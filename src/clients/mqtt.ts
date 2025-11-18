

import mqtt, { MqttClient } from "mqtt";
import { config } from "../config";
import { logger } from "../utils/logger";
import {
  EdgeEvent,
  GPSDataPayload,
  GPSDataPoint,
  DriverRequestPayload,
  DriverInfoPayload,
  DriverCheckInPayload,
  CheckOutConfirmRequestPayload,
  CheckOutConfirmResponsePayload,
  DriverCheckOutPayload,
  ParkingStateEvent,
  DrivingTimeEvent,
  VehicleOperationManagerEvent,
  DMSPayload,
  OMSPayload,
  StreamingEventPayload,
  EmergencyPayload,
} from "../types";
import { redisClient } from "./redis";
import { timescaleDB } from "./timescaledb";
import { socketIOServer } from "../server/socketio";
import { minioClient } from "./minio";
import { driverService } from "../services/driverService";
import { tripService } from "../services/tripService";
import { eventLogService } from "../services/eventLogService";
import { CacheKeys, VehicleState } from "../utils/constants";
import { MqttTopic } from "../types/enum";

class MQTTService {

  private client: MqttClient | null = null;
  private messageBuffer: EdgeEvent[] = [];
  private batchSize = 50;
  private batchTimeout = 5000; // 5 seconds
  private batchTimer: NodeJS.Timeout | null = null;
  private ttlGPSCache = 30; // 30 seconds

  // GPS Buffer for snap-to-road
  private gpsBuffers: Map<string, GPSDataPoint[]> = new Map();
  private gpsBufferTimers: Map<string, NodeJS.Timeout> = new Map();
  private cacheSessions: Map<string, string> = new Map();
  // For now, use deviceId as vehicleId
  private vehicleId = "770e8400-e29b-41d4-a716-446655440002";

  // TODO: Get driverId from driver_license_number
  // For now, use hardcoded UUID
  private driverId = "880e8400-e29b-41d4-a716-446655440001";
  private tzOffsetMinutes = 7 * 60 * 60 * 1000;

  /**
   * Connect to MQTT broker
   */
  connect(): void {
    logger.info(`Connecting to MQTT broker: ${config.mqtt.brokerUrl}`);

    this.client = mqtt.connect(config.mqtt.brokerUrl, {
      clientId: config.mqtt.clientId,
      username: config.mqtt.username,
      password: config.mqtt.password,
      clean: false,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
    });

    this.client.on("connect", () => {
      logger.info("MQTT connected successfully");
      this.subscribe();
    });

    this.client.on("error", (error) => {
      logger.error("MQTT connection error:", error);
    });

    this.client.on("offline", () => {
      logger.warn("MQTT client offline");
    });

    this.client.on("reconnect", () => {
      logger.info("MQTT reconnecting...");
    });

    this.client.on("message", (topic, payload) => {
      this.handleMessage(topic, payload);
    });
  }

  /**
   * Subscribe to MQTT topics
   */
  private subscribe(): void {
    if (!this.client) return;

    const topics = [
      config.mqtt.topics.gpsData,
      config.mqtt.topics.driverRequest,
      config.mqtt.topics.driverCheckIn,
      config.mqtt.topics.checkoutConfirmRequest,
      config.mqtt.topics.driverCheckOut,
      config.mqtt.topics.parkingState,
      config.mqtt.topics.drivingTime,
      config.mqtt.topics.vehicleOperationManager,
      config.mqtt.topics.dms,
      config.mqtt.topics.oms,
      config.mqtt.topics.streamingEvent,
      config.mqtt.topics.emergency,
    ];

    topics.forEach((topic) => {
      this.client!.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          logger.error(`MQTT subscription error for ${topic}:`, err);
        } else {
          logger.info(`Subscribed to topic: ${topic}`);
        }
      });
    });
  }

  /**
   * Handle incoming MQTT message
   */
  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    try {
      // Parse message payload
      const message = JSON.parse(payload.toString());
      // Extract device_id from topic (e.g., fms/device123/operation_monitoring/gps_data -> device123)
      const topicParts = topic.split("/");
      const deviceId = topicParts[1] || message.device_id;

      let matchedCase: MqttTopic | undefined = undefined;
      for (const key in MqttTopic) {
        if (Object.prototype.hasOwnProperty.call(MqttTopic, key)) {
          const topicValue = MqttTopic[key as keyof typeof MqttTopic];
          if (topic.includes(topicValue)) {
            matchedCase = topicValue as MqttTopic;
            break;
          }
        }
      }

      // if no cache, get from db
      if (!this.cacheSessions.has(deviceId)) {
        const latestTrip = await tripService.getLatestTrip(this.vehicleId);
        if (latestTrip) {
          this.cacheSessions.set(deviceId, latestTrip.id);
        }
      }

      switch (matchedCase) {
        case MqttTopic.GpsData:
          await this.handleGPSData(deviceId, message as GPSDataPayload);
          break;
        case MqttTopic.DriverRequest:
          await this.handleDriverRequest(deviceId, message as DriverRequestPayload);
          break;
        case MqttTopic.DriverCheckIn:
          await this.handleDriverCheckIn(deviceId, message as DriverCheckInPayload);
          break;
        case MqttTopic.CheckOutConfirmRequest:
          await this.handleCheckOutConfirmRequest(deviceId, message as CheckOutConfirmRequestPayload);
          break;
        case MqttTopic.DriverCheckOut:
          await this.handleDriverCheckOut(deviceId, message as DriverCheckOutPayload);
          break;
        case MqttTopic.ParkingState:
          await this.handleParkingState(deviceId, message as ParkingStateEvent);
          break;
        case MqttTopic.DrivingTime:
          await this.handleContinuousDrivingTime(deviceId, message as DrivingTimeEvent);
          break;
        case MqttTopic.VehicleOperationManager:
          await this.handleVehicleOperationManager(deviceId, message as VehicleOperationManagerEvent);
          break;
        case MqttTopic.DMS:
          await this.handleDMS(deviceId, message as DMSPayload);
          break;
        case MqttTopic.OMS:
          await this.handleOMS(deviceId, message as OMSPayload);
          break;
        case MqttTopic.StreamingEvent:
          await this.handleStreamingEvent(deviceId, message as StreamingEventPayload);
          break;
        case MqttTopic.Emergency:
          await this.handleEmergency(deviceId, message as EmergencyPayload);
          break;
        default: {
          // Handle generic event
          const event: EdgeEvent = {
            device_id: deviceId,
            timestamp: new Date(message.timestamp || Date.now()),
            event_type: message.event_type || "unknown",
            data: message.data || message,
            metadata: message.metadata,
          };
          logger.debug(
            `Received event from device: ${deviceId}, type: ${event.event_type}`
          );
          // Process event in parallel
          await Promise.allSettled([
            this.cacheEvent(event),
            this.streamEvent(event),
          ]);
          // Add to batch for database insertion
          this.addToBatch(event);
        }
      }
    } catch (error) {
      logger.error("Error handling MQTT message:", error);
    }
  }

  /**
   * Handle GPS data messages
   */
  private lastGPSTimestampByDevice: Map<string, number> = new Map();
  private async handleGPSData(deviceId: string, payload: GPSDataPayload): Promise<void> {
    try {
      logger.info(`Received GPS data from device: ${deviceId}, points: ${payload.gps_data.length}`);

      // Lọc các điểm GPS nếu không phải bản ghi đầu tiên
      let filteredPayload = payload;
      // const lastTimestamp = this.lastGPSTimestampByDevice.get(deviceId);
      // if (lastTimestamp !== undefined) {
      //   // Lọc các điểm có gps_timestamp > lastTimestamp
      //   const filteredPoints = payload.gps_data.filter(point => point.gps_timestamp > lastTimestamp);
      //   if (filteredPoints.length === 0) {
      //     logger.debug(`All GPS points dropped for device: ${deviceId} (all older than last received)`);
      //     return;
      //   }
      //   filteredPayload = { ...payload, gps_data: filteredPoints };
      // }
      // // Cập nhật lastGPSTimestampByDevice nếu có điểm mới
      // if (filteredPayload.gps_data.length > 0) {
      //   const maxTimestamp = Math.max(...filteredPayload.gps_data.map(p => p.gps_timestamp));
      //   this.lastGPSTimestampByDevice.set(deviceId, maxTimestamp);
      // }
      // filteredPayload.gps_data.forEach(point => {
      //   point.speed = Math.floor(point.speed);
      // });

      // Cache và lưu dữ liệu GPS đã lọc
      await Promise.allSettled([
        this.streamRawGPSData(deviceId, filteredPayload),
        this.cacheGPSData(deviceId, filteredPayload),
        this.storeGPSData(deviceId, filteredPayload),
      ]);

    } catch (error) {
      logger.error('Error handling GPS data:', error);
    }
  }


  /**
   * Cache GPS data in Redis
   */
  private async cacheGPSData(
    deviceId: string,
    payload: GPSDataPayload
  ): Promise<void> {
    try {
      // Get the latest GPS data point (last item in the array)
      const latestGPSPoint = payload.gps_data[payload.gps_data.length - 1];

      if (latestGPSPoint) {
        const cacheData = {
          time_stamp: payload.time_stamp,
          message_id: payload.message_id,
          trip_id: this.cacheSessions.get(deviceId) || undefined,
          gps_data: latestGPSPoint,
        };
        await redisClient.cacheGPSData(deviceId, cacheData, this.ttlGPSCache);
        await redisClient.cacheGPSData(this.cacheSessions.get(deviceId) || "", cacheData, this.ttlGPSCache);
      }
    } catch (error) {
      logger.error("Error caching GPS data:", error);
    }
  }

  /**
   * Stream raw GPS data to dashboard via Socket.IO
   */
  private streamRawGPSData(deviceId: string, payload: GPSDataPayload): void {
    try {
      // Get the latest GPS data point (last item in the array)
      const latestGPSPoint = payload.gps_data[payload.gps_data.length - 1];

      if (latestGPSPoint) {
        const streamData = {
          device_id: deviceId,
          time_stamp: payload.time_stamp,
          message_id: payload.message_id,
          gps_data: latestGPSPoint,
          trip_id: this.cacheSessions.get(deviceId) || undefined,
        };

        // Emit to channel by device ID
        socketIOServer.emit(deviceId, streamData);

        // Also emit to generic GPS channel for monitoring all devices
        socketIOServer.emit("gps:all", streamData);

        // Emit raw GPS data
        socketIOServer.emit("gps:raw", streamData);

        logger.info("streamed raw GPS data for device:", deviceId);
      }
    } catch (error) {
      logger.error("Error streaming raw GPS data:", error);
    }
  }

  /**
   * Store GPS data in TimescaleDB
   */
  private async storeGPSData(
    deviceId: string,
    payload: GPSDataPayload
  ): Promise<void> {
    try {
      await timescaleDB.insertGPSDataBatch(deviceId, payload, this.cacheSessions.get(deviceId) || undefined);
    } catch (error) {
      logger.error("Error storing GPS data:", error);
    }
  }

  /**
   * Handle driver request messages
   */
  private async handleDriverRequest(
    deviceId: string,
    payload: DriverRequestPayload
  ): Promise<void> {
    try {
      logger.info(`Received driver request from device: ${deviceId}`);
      logger.info(`Driver ID: ${payload.driver_id}`);

      // Validate driver_id
      if (!payload.driver_id || payload.driver_id === "None") {
        logger.error("Invalid driver request: driver_id is missing or None");
        return;
      }

      // HARD CODED: Always use fixed driver ID regardless of input
      logger.info(`HARD CODED: Using fixed driver_id: ${this.driverId} (received: ${payload.driver_id})`);

      // Get driver info from API using FIXED driver_id
      let driverData;

      try {
        logger.info(`Fetching driver info from API for driver_id: ${this.driverId}`);
        driverData = await driverService.getDriverById(this.driverId);

        // Fallback to mock data if API fails or driver not found
        if (!driverData) {
          logger.warn(`Driver ${this.driverId} not found in API, using mock data`);
          driverData = driverService.getMockDriverInfo(0);
        }
      } catch (error) {
        logger.error("Error fetching driver from API, using mock data:", error);
        driverData = driverService.getMockDriverInfo(0);
      }

      // Build driver info payload
      // Convert to UTC+7 milliseconds
      const utc7Ms = Date.now() + this.tzOffsetMinutes;

      const driverInfo: DriverInfoPayload = {
        time_stamp: utc7Ms,
        message_id: payload.message_id,
        driver_information: {
          driver_name: `${driverData.firstName} ${driverData.lastName}`,
          driver_license_number: driverData.licenseNumber,
        },
      };

      // Publish driver info back to device
      await this.publishDriverInfo(deviceId, driverInfo);

      // Stream to Socket.IO for monitoring
      socketIOServer.emit("driver:request", {
        device_id: deviceId,
        driver_id: payload.driver_id,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      socketIOServer.emit("driver:info", {
        device_id: deviceId,
        ...driverInfo,
      });
    } catch (error) {
      logger.error("Error handling driver request:", error);
    }
  }


  /**
   * Publish driver info to MQTT topic
   */
  private async publishDriverInfo(
    deviceId: string,
    driverInfo: DriverInfoPayload
  ): Promise<void> {
    try {
      if (!this.client) {
        logger.error("MQTT client not connected");
        return;
      }

      const topic = `fms/${deviceId}/driving_session/driver_info`;
      const payload = JSON.stringify(driverInfo);

      this.client.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) {
          logger.error(`Failed to publish driver info to ${topic}:`, err);
        } else {
          logger.info(`Published driver info to ${topic}`);
        }
      });
    } catch (error) {
      logger.error("Error publishing driver info:", error);
    }
  }

  /**
   * Handle driver check-in messages
   */
  private async handleDriverCheckIn(
    deviceId: string,
    payload: DriverCheckInPayload
  ): Promise<void> {
    try {
      logger.info(`Received driver check-in from device: ${deviceId}`);

      const checkInData = payload.check_in_data;
      const driverInfo = checkInData.driver_information;
      const location = checkInData.CheckInLocation;

      logger.info(
        `Driver: ${driverInfo.driver_name} (${driverInfo.driver_license_number})`
      );

      // Convert Unix milliseconds to UTC+7
      const checkInTimestampMs =
        checkInData.check_in_timestamp + this.tzOffsetMinutes;
      logger.info(
        `Check-in time: ${new Date(checkInTimestampMs).toISOString()}`
      );
      logger.info(`Location: ${location.latitude}, ${location.longitude}`);

      // Stream to Socket.IO for real-time monitoring
      socketIOServer.emit("driver:checkin", {
        device_id: deviceId,
        driver_name: driverInfo.driver_name,
        driver_license: driverInfo.driver_license_number,
        check_in_timestamp: checkInData.check_in_timestamp,
        location: {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy,
          gps_timestamp: location.gps_timestamp,
        },
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit("device:checkin", {
        device_id: deviceId,
        ...payload,
      });

      // Create new trip with status "Working"
      let tripId = await this.createTripForCheckIn(deviceId, checkInData);
      logger.info(`🔍 DEBUG: After createTripForCheckIn, tripId = ${tripId}`);
      this.cacheSessions.set(deviceId, tripId || "");

      // Log check-in event
      await eventLogService.logCheckInEvent(
        payload.message_id,
        this.vehicleId,
        {
          name: driverInfo.driver_name,
          licenseNumber: driverInfo.driver_license_number,
        },
        {
          checkInTimestamp: new Date(checkInTimestampMs).toISOString(),
          location: {
            latitude: location.latitude,
            longitude: location.longitude,
            accuracy: location.accuracy,
          },
          address: `Lat: ${location.latitude.toFixed(
            6
          )}, Lon: ${location.longitude.toFixed(6)}`,
        },
        tripId
      );

      logger.info(`Driver check-in processed successfully for ${deviceId}`);
    } catch (error) {
      logger.error("Error handling driver check-in:", error);
    }
  }

  /**
   * Create a new trip when driver checks in
   * @returns tripId if trip was created successfully, undefined otherwise
   */
  private async createTripForCheckIn(
    deviceId: string,
    checkInData: any
  ): Promise<string | undefined> {
    try {
      logger.info(`Creating trip for device: ${deviceId}`);

      // Convert Unix milliseconds to UTC+7
      const startTimeMs = checkInData.check_in_timestamp + this.tzOffsetMinutes;
      const startTime = new Date(startTimeMs).toISOString();

      // get current trip

      const existingTrip = await tripService.getLatestTrip(this.vehicleId);
      if (existingTrip && existingTrip.status === VehicleState.MOVING) {
        logger.warn(
          `Vehicle ${deviceId} already has an active trip (${existingTrip.id}). Skipping trip creation.`
        );
        
        // Cache vehicle state with trip info
        await redisClient.cacheDeviceState(deviceId, {
          device_id: deviceId,
          timestamp: new Date(),
          event_type: CacheKeys.VEHICLE_STATE,
          data: {
            trip_id: existingTrip.id,
            trip_number: existingTrip.tripNumber,
            status: VehicleState.MOVING,
          },
        });

        return existingTrip.id;
      }


      // Generate trip number
      const tripNumber = tripService.generateTripNumber(deviceId);

      // Format start address from location
      const startAddress = `Lat: ${checkInData.CheckInLocation.latitude.toFixed(
        6
      )}, Lon: ${checkInData.CheckInLocation.longitude.toFixed(6)}`;

      // Create trip request
      const tripRequest = {
        vehicleId: this.vehicleId,
        driverId: this.driverId,
        tripNumber: tripNumber,
        startTime: startTime,
        startAddress: startAddress,
        status: VehicleState.MOVING,
        notes: `Driver: ${checkInData.driver_information.driver_name}, License: ${checkInData.driver_information.driver_license_number}`,
      };

      // Call API to create trip
      const trip = await tripService.createTrip(tripRequest);

      if (trip) {
        logger.info(`Trip created successfully: ${trip.id}`);

        // Emit trip creation event via Socket.IO
        socketIOServer.emit("trip:created", {
          device_id: deviceId,
          trip_id: trip.id,
          trip_number: trip.tripNumber,
          driver_name: checkInData.driver_information.driver_name,
          start_time: trip.startTime,
          status: trip.status,
        });
        // Cache vehicle state with trip info
        await redisClient.cacheDeviceState(deviceId, {
          device_id: deviceId,
          timestamp: new Date(),
          event_type: CacheKeys.VEHICLE_STATE,
          data: {
            trip_id: trip.id,
            trip_number: trip.tripNumber,
            status: VehicleState.MOVING,
          },
        });

        return trip.id;
      }

      return undefined;
    } catch (error: any) {
      logger.error("Error creating trip for check-in:", error.message);

      // If error is about ongoing trip, log but don't throw
      if (error.message?.includes("chưa kết thúc")) {
        logger.warn(
          `Vehicle ${deviceId} has ongoing trip. Check-in recorded but new trip not created.`
        );
      } else {
        // For other errors, still continue processing (don't block check-in)
        logger.error(
          "Failed to create trip, but check-in was recorded successfully"
        );
      }

      return undefined;
    }
  }

  /**
   * Handle driver check-out confirm request
   * Find latest trip, if no end time, respond with is_confirm = true
   */
  private async handleCheckOutConfirmRequest(
    deviceId: string,
    payload: CheckOutConfirmRequestPayload
  ): Promise<void> {
    try {
      logger.info(
        `Received check-out confirm request from device: ${deviceId}`
      );
      logger.info(`Driver ID: ${payload.driver_id}`);

      // Validate driver_id
      if (!payload.driver_id || payload.driver_id === "None") {
        logger.warn(
          `Invalid check-out confirm request from ${deviceId}: driver_id is missing or None`
        );
        await this.publishCheckOutConfirmResponse(
          deviceId,
          payload.message_id,
          false
        );
        return;
      }

      // Get latest trip for vehicle
      // TODO: Map deviceId to vehicleId (UUID from API)
      const latestTrip = await tripService.getLatestTrip(this.vehicleId);

      // Check if trip exists and has no end time
      const isConfirm = latestTrip !== null && latestTrip.status === VehicleState.MOVING;

      if (isConfirm) {
        logger.info(
          `Ongoing trip found for ${deviceId}: ${latestTrip!.id
          }. Confirming check-out.`
        );
      } else if (latestTrip === null) {
        logger.warn(`No trip found for ${deviceId}. Cannot confirm check-out.`);
      } else {
        logger.warn(
          `Latest trip for ${deviceId} already has end time. Cannot confirm check-out.`
        );
      }

      // Publish confirmation response
      await this.publishCheckOutConfirmResponse(
        deviceId,
        payload.message_id,
        isConfirm
      );

      // Emit to Socket.IO
      socketIOServer.emit("checkout:confirm:request", {
        device_id: deviceId,
        driver_id: payload.driver_id,
        message_id: payload.message_id,
        is_confirm: isConfirm,
        has_trip: latestTrip !== null,
        trip_id: latestTrip?.id,
        time_stamp: payload.time_stamp,
      });
    } catch (error) {
      logger.error("Error handling check-out confirm request:", error);
      // On error, respond with is_confirm = false
      await this.publishCheckOutConfirmResponse(
        deviceId,
        payload.message_id,
        false
      );
    }
  }

  /**
   * Publish check-out confirm response to MQTT
   */
  private async publishCheckOutConfirmResponse(
    deviceId: string,
    requestMessageId: string,
    isConfirm: boolean
  ): Promise<void> {
    try {
      if (!this.client) {
        logger.error("MQTT client not connected");
        return;
      }

      const responseTopic = config.mqtt.topics.checkoutConfirmResponse.replace(
        "+",
        deviceId
      );

      // Convert to UTC+7 milliseconds
      const utc7Ms = Date.now() + this.tzOffsetMinutes;

      const responsePayload: CheckOutConfirmResponsePayload = {
        time_stamp: utc7Ms,
        message_id: requestMessageId,
        respond_data: {
          is_confirm: isConfirm,
        },
      };

      this.client.publish(
        responseTopic,
        JSON.stringify(responsePayload),
        { qos: 1 },
        (err) => {
          if (err) {
            logger.error(
              `Error publishing check-out confirm response to ${responseTopic}:`,
              err
            );
          } else {
            logger.info(
              `Check-out confirm response sent to ${deviceId}: is_confirm=${isConfirm}`
            );
          }
        }
      );
    } catch (error) {
      logger.error("Error publishing check-out confirm response:", error);
    }
  }

  /**
   * Handle driver check-out
   * Update the latest trip with end time and duration
   */
  private async handleDriverCheckOut(
    deviceId: string,
    payload: DriverCheckOutPayload
  ): Promise<void> {
    try {
      logger.info(`Received driver check-out from device: ${deviceId}`);

      const checkOutData = payload.check_out_data;
      const driverInfo = checkOutData.driver_information;
      const location = checkOutData.CheckOutLocation;

      logger.info(
        `Driver: ${driverInfo.driver_name} (${driverInfo.driver_license_number})`
      );

      // Convert Unix milliseconds to UTC+7
      const checkOutTimestampMs =
        checkOutData.check_out_timestamp + this.tzOffsetMinutes;
      logger.info(
        `Check-out time: ${new Date(checkOutTimestampMs).toISOString()}`
      );
      logger.info(`Working duration: ${checkOutData.working_duration} minutes`);
      logger.info(`Location: ${location.latitude}, ${location.longitude}`);

      // Stream to Socket.IO for real-time monitoring
      socketIOServer.emit("driver:checkout", {
        device_id: "deviceId",
        driver_name: driverInfo.driver_name,
        driver_license: driverInfo.driver_license_number,
        check_out_timestamp: checkOutData.check_out_timestamp,
        working_duration: checkOutData.working_duration,
        location: {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy,
          gps_timestamp: location.gps_timestamp,
        },
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit("device:checkout", {
        device_id: deviceId,
        ...payload,
      });

      // Update latest trip with check-out data
      const tripId = await this.updateTripWithCheckOut(deviceId, checkOutData);

      // Log check-out event
      await eventLogService.logCheckOutEvent(
        payload.message_id,
        this.vehicleId,
        {
          name: driverInfo.driver_name,
          licenseNumber: driverInfo.driver_license_number,
        },
        {
          checkOutTimestamp: new Date(checkOutTimestampMs).toISOString(),
          workingDuration: checkOutData.working_duration,
          location: {
            latitude: location.latitude,
            longitude: location.longitude,
            accuracy: location.accuracy,
          },
          address: `Lat: ${location.latitude.toFixed(
            6
          )}, Lon: ${location.longitude.toFixed(6)}`,
        },
        tripId
      );

      logger.info(`Driver check-out processed successfully for ${deviceId}`);
    } catch (error) {
      logger.error("Error handling driver check-out:", error);
    }
  }

  /**
   * Update the latest trip with check-out data
   * @returns tripId if trip was updated successfully, undefined otherwise
   */
  private async updateTripWithCheckOut(
    deviceId: string,
    checkOutData: any
  ): Promise<string | undefined> {
    try {
      logger.info(`Updating trip for device: ${deviceId} with check-out data`);

      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(this.vehicleId);

      if (!latestTrip) {
        logger.warn(
          `No trip found for vehicle ${deviceId}. Cannot update with check-out data.`
        );
        return undefined;
      }

      if (latestTrip.endTime) {
        logger.warn(
          `Latest trip ${latestTrip.id} already has end time. Cannot update with check-out data.`
        );
        return latestTrip.id;
      }

      // Convert Unix milliseconds to UTC+7
      const endTimeMs = checkOutData.check_out_timestamp + this.tzOffsetMinutes;
      const endTime = new Date(endTimeMs).toISOString();

      // Format end address from location
      const endAddress = `Lat: ${checkOutData.CheckOutLocation.latitude.toFixed(
        6
      )}, Lon: ${checkOutData.CheckOutLocation.longitude.toFixed(6)}`;

      // Update trip with check-out data
      // updateTrip automatically preserves all existing fields (fetches existing trip first)
      const updatedTrip = await tripService.updateTrip(latestTrip.id, {
        startTime: latestTrip.startTime, // Required by API
        endTime: endTime,
        endAddress: endAddress,
        durationMinutes: checkOutData.working_duration,
        status: VehicleState.COMPLETED,
      });
      // const updatedTrip = await tripService.endDrivingSession(vehicleId);

      if (updatedTrip) {
        logger.info(
          ` Trip ${latestTrip.id} updated successfully with check-out data`
        );

        // Emit trip completion event via Socket.IO
        socketIOServer.emit("trip:completed", {
          device_id: deviceId,
          trip_id: updatedTrip.id,
          trip_number: updatedTrip.tripNumber,
          driver_name: checkOutData.driver_information.driver_name,
          start_time: updatedTrip.startTime,
          end_time: updatedTrip.endTime,
          duration_minutes: checkOutData.working_duration,
          status: updatedTrip.status,
        });

        return updatedTrip.id;
      }

      this.cacheSessions.delete(deviceId);

      return latestTrip.id;
    } catch (error: any) {
      logger.error("Error updating trip with check-out:", {
        message: error.message,
        stack: error.stack,
      });
      return undefined;
    }
  }

  /**
   * Handle parking state messages
   */
  private async handleParkingState(
    deviceId: string,
    payload: ParkingStateEvent
  ): Promise<void> {
    try {
      logger.info(`Received parking state from device: ${deviceId}`);
      logger.info(
        `Parking ID: ${payload.parking_id}, State: ${payload.parking_status === 0 ? "PARKED" : "MOVING"
        }, Duration: ${payload.parking_duration} seconds`
      );

      // get latest trip
      const latestTrip = await tripService.getLatestTrip(this.vehicleId);

      if (!latestTrip) {
        logger.info(
          `No active trip found for vehicle ${this.vehicleId}. Cannot update with parking state.`
        );
        return;
      }

      // Convert Unix milliseconds to UTC+7
      const timestampMs = payload.time_stamp + this.tzOffsetMinutes;
      const timestamp = new Date(timestampMs).toISOString();

      //get latest location
      const latestGPSData = await redisClient.getGPSData(deviceId);
      let latestLocation = null;
      if (latestGPSData && latestGPSData.gps_data) {
        latestLocation = latestGPSData.gps_data;
      }

      // Handle parking state
      if (payload.parking_status === 0) {
        // Vehicle PARKED - Create new parking event
        logger.info(`Vehicle ${deviceId} parked. Creating parking event.`);

        // Cache vehicle state in Redis
        await redisClient.cacheDeviceState(deviceId, {
          device_id: deviceId,
          timestamp: new Date(),
          event_type: CacheKeys.VEHICLE_STATE,
          data: {
            trip_id: latestTrip.id,
            trip_number: latestTrip.tripNumber,
            status: VehicleState.IDLE,
          }
        });

        // Update trip status to IDLE
        await tripService.updateTrip(latestTrip.id, {
          startTime: latestTrip.startTime, // Required by API
          status: VehicleState.IDLE,
          continuousDrivingDurationSeconds: 0,
        });

        // Create parking start event
        const parkingEvent = await eventLogService.logParkingStartEvent(
          payload.message_id,
          this.vehicleId,
          {
            parkingId: payload.parking_id,
            timestamp: timestamp,
          },
          latestLocation,
          latestTrip.id,
          {
            vehicleId: latestTrip.vehicleId,
            driverId: latestTrip.driverId,
            tripNumber: latestTrip.tripNumber,
            licensePlate: latestTrip.licensePlate,
            vehicleType: latestTrip.vehicleType,
            driverName: latestTrip.driverName,
            driverLicenseNumber: latestTrip.licenseNumber,
          }
        );

        // Cache the MongoDB event ID for later update
        if (parkingEvent && parkingEvent.id) {
          await redisClient.cacheParkingEventId(
            payload.parking_id,
            parkingEvent.id
          );
          logger.info(
            `Cached parking event ID: ${parkingEvent.id} for parking ${payload.parking_id}`
          );
        }
      } else {
        // Vehicle MOVING - Update existing parking event
        logger.info(
          `Vehicle ${deviceId} resumed movement. Updating parking event.`
        );

        // Cache vehicle state in Redis
        await redisClient.cacheDeviceState(deviceId, {
          device_id: deviceId,
          timestamp: new Date(),
          event_type: CacheKeys.VEHICLE_STATE,
          data: {
            trip_id: latestTrip.id,
            trip_number: latestTrip.tripNumber,
            status: VehicleState.MOVING,
          },
        });

        // Calculate total idle time by adding this parking duration
        const currentIdleTime = latestTrip.idleTimeSeconds || 0;
        const newIdleTime = currentIdleTime + payload.parking_duration;

        logger.info(
          `Updating trip idle time: ${currentIdleTime}s + ${payload.parking_duration}s = ${newIdleTime}s`
        );

        // Update trip status to MOVING and add idle time
        await tripService.updateTrip(latestTrip.id, {
          startTime: latestTrip.startTime, // Required by API
          status: VehicleState.MOVING,
          idleTimeSeconds: newIdleTime,
        });

        // Get the cached parking event MongoDB ID
        const parkingEventId = await redisClient.getParkingEventId(
          payload.parking_id
        );


        if (parkingEventId) {
          // Update the parking event with end time and duration
          await eventLogService.updateParkingEndEvent(parkingEventId, {
            parkingDuration: payload.parking_duration,
            endTime: timestamp,
          });

          // Delete the cached event ID
          await redisClient.deleteParkingEventId(payload.parking_id);
          logger.info(
            `Updated and cleaned up parking event: ${parkingEventId}`
          );
        } else {
          logger.warn(
            `No cached parking event ID found for parking ${payload.parking_id}. Cannot update event.`
          );
        }
      }

      // Count total parking events in this session
      const parkingCount = await eventLogService.countParkingEventsBySession(
        latestTrip.id
      );

      // Get updated trip to get latest idle time
      const updatedTrip = await tripService.getLatestTrip(this.vehicleId);
      const totalParkingTime = updatedTrip?.idleTimeSeconds || 0;

      // Stream to Socket.IO for real-time monitoring
      socketIOServer.emit("parking:state", {
        device_id: deviceId,
        parking_id: payload.parking_id,
        parking_state: payload.parking_status,
        parking_duration: payload.parking_duration,
        total_parking_time: totalParkingTime,
        parking_count: parkingCount,
        trip_id: latestTrip.id,
        trip_number: latestTrip.tripNumber,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      logger.info(
        `Parking state processed successfully for ${deviceId}. Total parking events in session: ${parkingCount}`
      );
    } catch (error) {
      logger.error("Error handling parking state:", error);
    }
  }

  /**
   * Handle continuous driving time messages
   */
  private async handleContinuousDrivingTime(
    deviceId: string,
    payload: DrivingTimeEvent
  ): Promise<void> {
    try {
      logger.info(`Received continuous driving time from device: ${deviceId}`);
      logger.info(
        `Continuous driving time: ${payload.continuous_driving_time} seconds, Total driving duration: ${payload.driving_duration} seconds`
      );


      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(this.vehicleId);

      if (!latestTrip) {
        logger.info(
          `No active trip found for vehicle ${this.vehicleId}. Cannot update with continuous driving time.`
        );
        return;
      }

      // Update trip with continuous driving time and total duration
      await tripService.updateTrip(latestTrip.id, {
        startTime: latestTrip.startTime, // Required by API
        continuousDrivingDurationSeconds: payload.continuous_driving_time,
        durationSeconds: payload.driving_duration,
      });

      logger.info(
        `Trip ${latestTrip.id} updated with continuous driving time: ${payload.continuous_driving_time}s`
      );

      // Stream to Socket.IO for real-time monitoring
      socketIOServer.emit("driving:time", {
        device_id: deviceId,
        continuous_driving_time: payload.continuous_driving_time,
        driving_duration: payload.driving_duration,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
        trip_id: latestTrip.id,
        trip_number: latestTrip.tripNumber,
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit("device:driving:time", {
        device_id: deviceId,
        ...payload,
        trip_id: latestTrip.id,
      });

      logger.info(
        `Continuous driving time processed successfully for ${deviceId}`
      );
    } catch (error) {
      logger.error("Error handling continuous driving time:", error);
    }
  }

  /**
   * Handle vehicle operation manager messages (violations)
   * Each message contains only ONE violation at a time (non-violating values are 0)
   */
  private async handleVehicleOperationManager(
    deviceId: string,
    payload: VehicleOperationManagerEvent
  ): Promise<void> {
    try {
      logger.info(
        `Received vehicle operation manager event from device: ${deviceId}`
      );


      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(this.vehicleId);

      if (!latestTrip) {
        logger.info(
          `No active trip found for vehicle ${this.vehicleId}. Cannot log violation.`
        );
        return;
      }

      const timestamp = new Date(payload.time_stamp).toISOString();
      const violations = payload.violation_operation;

      // Determine which violation is active (non-zero value)
      let violationType:
        | "CONTINUOUS_DRIVING"
        | "PARKING_DURATION"
        | "SPEED_LIMIT"
        | null = null;
      let violationValue = 0;
      let violationUnit = "";

      if (violations.continuous_driving_time_violate > 0) {
        violationType = "CONTINUOUS_DRIVING";
        violationValue = violations.continuous_driving_time_violate;
        violationUnit = "minutes";
      } else if (violations.parking_duration_violate > 0) {
        violationType = "PARKING_DURATION";
        violationValue = violations.parking_duration_violate;
        violationUnit = "minutes";
      } else if (violations.speed_limit_violate > 0) {
        violationType = "SPEED_LIMIT";
        violationValue = violations.speed_limit_violate;
        violationUnit = "km/h";
      }

      // If no violation is detected, log and return
      if (!violationType) {
        logger.info(`No active violation in message from ${deviceId}`);
        return;
      }

      // Log the violation event
      const eventId = `violation_${deviceId}_${payload.message_id}`;
      await eventLogService.logViolationEvent(
        eventId,
        this.vehicleId,
        {
          timestamp,
          messageId: payload.message_id,
          violationType,
          violationValue,
          violationUnit,
        },
        latestTrip.id
      );

      logger.info(
        `Violation logged: ${violationType} = ${violationValue} ${violationUnit}`
      );

      // Count speed violations if this is a speed violation
      let speedViolationCount = 0;
      if (violationType === "SPEED_LIMIT") {
        speedViolationCount =
          await eventLogService.countSpeedViolationsBySession(latestTrip.id);
      }

      // Emit to Socket.IO - only the active violation, others are 0
      socketIOServer.emit("violation:detected", {
        device_id: deviceId,
        trip_id: latestTrip.id,
        trip_number: latestTrip.tripNumber,
        violation_type: violationType,
        continuous_driving_time_violate:
          violations.continuous_driving_time_violate,
        parking_duration_violate: violations.parking_duration_violate,
        speed_limit_violate: violations.speed_limit_violate,
        speed_violation_count: speedViolationCount, // Only count speed violations
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit("device:violation", {
        device_id: deviceId,
        violation_type: violationType,
        violation_value: violationValue,
        violation_unit: violationUnit,
        speed_violation_count: speedViolationCount, // Only count speed violations
        trip_id: latestTrip.id,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      logger.info(
        `Vehicle operation violation processed successfully for ${deviceId}${violationType === "SPEED_LIMIT"
          ? `. Speed violations in session: ${speedViolationCount}`
          : ""
        }`
      );
    } catch (error) {
      logger.error("Error handling vehicle operation manager:", error);
    }
  }

  /**
   * Handle DMS (Driver Monitoring System) messages
   * Processes driver behavior violations with location and image data
   */
  private async handleDMS(
    deviceId: string,
    payload: DMSPayload
  ): Promise<void> {
    try {
      logger.info(`Received DMS data from device: ${deviceId}`);

      // Validate payload structure
      if (!payload.violate_infomation_DMS) {
        logger.error(`Invalid DMS payload - missing violate_infomation_DMS field`);
        return;
      }

      const violationInfo = payload.violate_infomation_DMS;

      // Map behavior code to string name - violation_dms is now number
      const behaviorNames = ['None', 'PhoneUse', 'Drowness', 'Smoking', 'Unfocus', 'Handoff'];
      const behaviorName = behaviorNames[violationInfo.violation_dms] || 'Unknown';

      logger.info(
        `DMS Violation - Behavior: ${behaviorName} (${violationInfo.violation_dms}), Speed: ${violationInfo.speed} km/h`
      );
      logger.info(
        `Location: ${violationInfo.latitude}, ${violationInfo.longitude}`
      );

      // Upload image to MinIO (fleet-snapshots bucket, no subfolder)
      let imageUrl = "";
      try {
        if (violationInfo.image_data && violationInfo.image_data !== "None") {
          // Generate unique filename without subfolder: device_behavior_timestamp.png
          const behaviorSlug = behaviorName.toLowerCase();
          const fileName = `${deviceId}_${behaviorSlug}_${payload.time_stamp}.png`;

          // Upload to MinIO
          imageUrl = await minioClient.uploadImageFromBase64(
            violationInfo.image_data,
            fileName,
            "image/png"
          );

          logger.info(`DMS image uploaded to MinIO: ${imageUrl}`);
        }
      } catch (uploadError) {
        logger.error("Error uploading DMS image to MinIO:", uploadError);
        // Continue processing even if image upload fails
      }

      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(this.vehicleId);

      if (!latestTrip) {
        logger.info(
          `No active trip found for vehicle ${this.vehicleId}. Logging DMS event without trip.`
        );
      } else {
        logger.info(`Latest trip data: ${JSON.stringify(latestTrip)}`);
      }

      // Convert Unix milliseconds to UTC+7
      const timestampMs = payload.time_stamp + this.tzOffsetMinutes;
      const timestamp = new Date(timestampMs).toISOString();

      const gpsTimestampMs = violationInfo.gps_timestamp + this.tzOffsetMinutes;
      const gpsTimestamp = new Date(gpsTimestampMs).toISOString();

      // Log DMS violation event with image URL
      const eventId = `dms_${deviceId}_${payload.message_id}`;
      await eventLogService.logDMSEvent(
        eventId,
        this.vehicleId,
        {
          timestamp,
          messageId: payload.message_id,
          behaviorViolate: behaviorName,
          speed: violationInfo.speed,
          location: {
            latitude: violationInfo.latitude,
            longitude: violationInfo.longitude,
            gpsTimestamp,
          },
          imageUrl: imageUrl, // Send MinIO URL instead of base64
          driverName: payload.driver_information?.driver_name || "Unknown",
          driverLicenseNumber: payload.driver_information?.driver_license_number || "Unknown",
        },
        latestTrip?.id,
        latestTrip ? {
          vehicleId: latestTrip.vehicleId,
          driverId: latestTrip.driverId,
          tripNumber: latestTrip.tripNumber,
          licensePlate: latestTrip.licensePlate,
          vehicleType: latestTrip.vehicleType,
        } : undefined
      );

      logger.info(`DMS violation logged: ${behaviorName} (${violationInfo.violation_dms})`);

      // Count total DMS violations in this session
      let dmsViolationCount = 0;
      if (latestTrip) {
        dmsViolationCount = await eventLogService.countDMSViolationsBySession(
          latestTrip.id
        );
      }

      // Stream to Socket.IO for real-time monitoring with image URL
      socketIOServer.emit("dms:violation", {
        device_id: deviceId,
        trip_id: latestTrip?.id,
        trip_number: latestTrip?.tripNumber,
        behavior_violate: violationInfo.violation_dms,
        behavior_name: behaviorName,
        speed: violationInfo.speed,
        location: {
          latitude: violationInfo.latitude,
          longitude: violationInfo.longitude,
          gps_timestamp: violationInfo.gps_timestamp,
        },
        image_url: imageUrl, // Send URL instead of base64
        // dms_violation_count: dmsViolationCount,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit("device:dms:violation", {
        device_id: deviceId,
        behavior_violate: violationInfo.violation_dms,
        behavior_name: behaviorName,
        speed: violationInfo.speed,
        image_url: imageUrl, // Send URL instead of base64
        // dms_violation_count: dmsViolationCount,
        trip_id: latestTrip?.id,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      logger.info(
        `DMS violation processed successfully for ${deviceId}. Total violations in session: ${dmsViolationCount}`
      );
    } catch (error) {
      logger.error("Error handling DMS data:", error);
    }
  }

  /**
   * Handle OMS (Operational Monitoring System) messages
   * Processes operational behavior violations with location and image data
   */
  private async handleOMS(
    deviceId: string,
    payload: OMSPayload
  ): Promise<void> {
    try {
      logger.info(`Received OMS data from device: ${deviceId}`);

      // Validate payload structure
      if (!payload.violate_infomation_OMS) {
        logger.error(`Invalid OMS payload - missing violate_infomation_OMS field`);
        return;
      }

      const violationInfo = payload.violate_infomation_OMS;

      // Map behavior code to string name - OMS only has 2 values - violation_oms is now number
      const behaviorNames = ['None', 'Unfasten_seat_belt'];
      const behaviorName = behaviorNames[violationInfo.violation_oms] || 'Unknown';

      logger.info(
        `OMS Violation - Behavior: ${behaviorName} (${violationInfo.violation_oms}), Speed: ${violationInfo.speed} km/h`
      );
      logger.info(
        `Location: ${violationInfo.latitude}, ${violationInfo.longitude}`
      );

      // Upload image to MinIO (fleet-snapshots bucket, no subfolder)
      let imageUrl = "";
      try {
        if (violationInfo.image_data && violationInfo.image_data !== "None") {
          // Generate unique filename without subfolder: device_behavior_timestamp.png
          const behaviorSlug = behaviorName.toLowerCase();
          const fileName = `${deviceId}_${behaviorSlug}_${payload.time_stamp}.png`;

          // Upload to MinIO
          imageUrl = await minioClient.uploadImageFromBase64(
            violationInfo.image_data,
            fileName,
            "image/png"
          );

          logger.info(`OMS image uploaded to MinIO: ${imageUrl}`);
        }
      } catch (uploadError) {
        logger.error("Error uploading OMS image to MinIO:", uploadError);
        // Continue processing even if image upload fails
      }

      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(this.vehicleId);

      if (!latestTrip) {
        logger.info(
          `No active trip found for vehicle ${this.vehicleId}. Logging OMS event without trip.`
        );
      }

      // Convert Unix milliseconds to UTC+7
      const timestampMs = payload.time_stamp + this.tzOffsetMinutes;
      const timestamp = new Date(timestampMs).toISOString();

      const gpsTimestampMs = violationInfo.gps_timestamp + this.tzOffsetMinutes;
      const gpsTimestamp = new Date(gpsTimestampMs).toISOString();

      // Log OMS violation event with image URL
      const eventId = `oms_${deviceId}_${payload.message_id}`;
      await eventLogService.logDMSEvent(
        eventId,
        this.vehicleId,
        {
          timestamp,
          messageId: payload.message_id,
          behaviorViolate: behaviorName,
          speed: violationInfo.speed,
          location: {
            latitude: violationInfo.latitude,
            longitude: violationInfo.longitude,
            gpsTimestamp,
          },
          imageUrl: imageUrl, // Send MinIO URL instead of base64
          driverName: payload.driver_information?.driver_name || "Unknown",
          driverLicenseNumber: payload.driver_information?.driver_license_number || "Unknown",
        },
        latestTrip?.id
      );

      logger.info(`OMS violation logged: ${behaviorName} (${violationInfo.violation_oms})`);

      // Count total OMS violations in this session
      let omsViolationCount = 0;
      if (latestTrip) {
        omsViolationCount = await eventLogService.countDMSViolationsBySession(
          latestTrip.id
        );
      }

      // Stream to Socket.IO for real-time monitoring with image URL
      socketIOServer.emit("oms:violation", {
        device_id: deviceId,
        trip_id: latestTrip?.id,
        trip_number: latestTrip?.tripNumber,
        behavior_violate: violationInfo.violation_oms,
        behavior_name: behaviorName,
        speed: violationInfo.speed,
        location: {
          latitude: violationInfo.latitude,
          longitude: violationInfo.longitude,
          gps_timestamp: violationInfo.gps_timestamp,
        },
        image_url: imageUrl, // Send URL instead of base64
        // oms_violation_count: omsViolationCount,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit("device:oms:violation", {
        device_id: deviceId,
        behavior_violate: violationInfo.violation_oms,
        behavior_name: behaviorName,
        speed: violationInfo.speed,
        image_url: imageUrl, // Send URL instead of base64
        // oms_violation_count: omsViolationCount,
        trip_id: latestTrip?.id,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      logger.info(
        `OMS violation processed successfully for ${deviceId}. Total violations in session: ${omsViolationCount}`
      );
    } catch (error) {
      logger.error("Error handling OMS data:", error);
    }
  }

  /**
   * Handle streaming event messages
   * This handler receives streaming requests from edge devices
   */
  private async handleStreamingEvent(
    deviceId: string,
    payload: StreamingEventPayload
  ): Promise<void> {
    try {
      logger.info(`Received streaming event from device: ${deviceId}`);

      const stateNames = ["Oms", "Dms", "Dash", "Off"];
      const stateName = stateNames[payload.streamming_state] || "Unknown";

      logger.info(
        `Streaming state: ${stateName} (${payload.streamming_state})`
      );
      logger.info(`Message ID: ${payload.message_id}`);
      logger.info(`Timestamp: ${payload.time_stamp}`);

      // Stream to Socket.IO for real-time monitoring
      socketIOServer.emit("streaming:event", {
        device_id: deviceId,
        streaming_state: payload.streamming_state,
        streaming_state_name: stateName,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
        timestamp: new Date().toISOString(),
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit("device:streaming:event", {
        device_id: deviceId,
        streaming_state: payload.streamming_state,
        streaming_state_name: stateName,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      logger.info(`Streaming event processed successfully for ${deviceId}`);
    } catch (error) {
      logger.error("Error handling streaming event:", error);
    }
  }

  /**
   * Handle emergency event messages
   * Logs with ALERT severity and forwards to Socket.IO
   */
  private async handleEmergency(
    deviceId: string,
    payload: EmergencyPayload
  ): Promise<void> {
    try {
      logger.error(`🚨 EMERGENCY from device: ${deviceId}`);

      // Log full raw payload
      logger.error(`Emergency Raw Payload: ${JSON.stringify(payload, null, 2)}`);

      const emergencyData = payload.Emergency;

      logger.error(
        `Emergency Location: ${emergencyData.latitude}, ${emergencyData.longitude}`
      );
      logger.error(
        `GPS Timestamp: ${new Date(emergencyData.gps_timestamp).toISOString()}`
      );

      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(this.vehicleId);

      // Convert Unix milliseconds to UTC+7
      const timestampMs = payload.time_stamp + this.tzOffsetMinutes;
      const timestamp = new Date(timestampMs).toISOString();

      // Stream to Socket.IO for real-time monitoring with ALERT severity
      socketIOServer.emit("emergency:alert", {
        device_id: deviceId,
        trip_id: latestTrip?.id,
        trip_number: latestTrip?.tripNumber,
        location: {
          latitude: emergencyData.latitude,
          longitude: emergencyData.longitude,
          gps_timestamp: emergencyData.gps_timestamp,
        },
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
        timestamp: timestamp,
      });

      // Emit to specific device room with high priority
      socketIOServer.to(`device:${deviceId}`).emit("device:emergency:alert", {
        device_id: deviceId,
        location: {
          latitude: emergencyData.latitude,
          longitude: emergencyData.longitude,
          gps_timestamp: emergencyData.gps_timestamp,
        },
        trip_id: latestTrip?.id,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      // Broadcast to all clients for emergency
      socketIOServer.emit("emergency:broadcast", {
        device_id: deviceId,
        location: {
          latitude: emergencyData.latitude,
          longitude: emergencyData.longitude,
        },
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
        timestamp: timestamp,
      });

      // Log emergency event to EventLog with ALERT severity
      const gpsTimestamp = new Date(emergencyData.gps_timestamp).toISOString();
      await eventLogService.logEmergencyEvent(
        payload.message_id,
        deviceId,
        {
          timestamp: timestamp,
          messageId: payload.message_id,
          location: {
            latitude: emergencyData.latitude,
            longitude: emergencyData.longitude,
            gpsTimestamp,
          },
        },
        latestTrip?.id,
        latestTrip ? {
          vehicleId: latestTrip.vehicleId,
          driverId: latestTrip.driverId,
          tripNumber: latestTrip.tripNumber,
          licensePlate: latestTrip.licensePlate,
          vehicleType: latestTrip.vehicleType,
          driverName: latestTrip.driverName,
          driverLicenseNumber: latestTrip.licenseNumber,
        } : undefined
      );

      logger.error(`Emergency event processed for ${deviceId}`);
    } catch (error) {
      logger.error("Error handling emergency event:", error);
    }
  }

  /**
   * Cache event in Redis
   */
  private async cacheEvent(event: EdgeEvent): Promise<void> {
    try {
      await Promise.all([
        redisClient.cacheDeviceState(event.device_id, event),
        redisClient.cacheLatestEvent(event),
      ]);
    } catch (error) {
      logger.error("Error caching event:", error);
    }
  }

  /**
   * Stream event to dashboard via Socket.IO
   */
  private streamEvent(event: EdgeEvent): void {
    try {
      // Broadcast to all connected clients
      socketIOServer.emit("edge:event", event);

      // Emit to room for specific device
      socketIOServer
        .to(`device:${event.device_id}`)
        .emit("edge:device:event", event);
    } catch (error) {
      logger.error("Error streaming event:", error);
    }
  }

  /**
   * Add event to batch for database insertion
   */
  private addToBatch(event: EdgeEvent): void {
    this.messageBuffer.push(event);

    if (this.messageBuffer.length >= this.batchSize) {
      this.flushBatch();
    } else if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flushBatch(), this.batchTimeout);
    }
  }

  /**
   * Flush batch to TimescaleDB
   */
  private async flushBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.messageBuffer.length === 0) return;

    const batch = [...this.messageBuffer];
    this.messageBuffer = [];

    try {
      await timescaleDB.insertEventsBatch(batch);
      logger.info(`Flushed batch of ${batch.length} events to database`);
    } catch (error) {
      logger.error("Error flushing batch to database:", error);
      // Optionally: implement retry logic or dead-letter queue
    }
  }

  /**
   * Public method to publish streaming request
   */
  public async publishStreamingRequest(
    deviceId: string,
    streamingState: 0 | 1 | 2 | 3
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.client) {
        const errorMsg = "MQTT client not connected";
        logger.error(errorMsg);
        return { success: false, error: errorMsg };
      }

      const topic = `fms/${deviceId}/driving_session/streamming_event`;
      const message = {
        time_stamp: 0,
        message_id: "None",
        streamming_state: streamingState,
      };

      const payload = JSON.stringify(message);

      return new Promise((resolve) => {
        this.client!.publish(
          topic,
          payload,
          { qos: 2, retain: false },
          (err) => {
            if (err) {
              logger.error(
                `Failed to publish streaming request to ${topic}:`,
                err
              );
              resolve({ success: false, error: err.message });
            } else {
              logger.info(`Published streaming request to ${topic}:`, message);
              resolve({ success: true });
            }
          }
        );
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("Error publishing streaming request:", error);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Disconnect MQTT client
   */
  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.client = null;
      logger.info("MQTT client disconnected");
    }

    // Clear GPS buffer timers
    for (const [deviceId, timer] of this.gpsBufferTimers.entries()) {
      clearTimeout(timer);
      logger.debug(`Cleared GPS buffer timer for ${deviceId}`);
    }
    this.gpsBufferTimers.clear();
    this.gpsBuffers.clear();
  }
}

export const mqttService = new MQTTService();
