import mqtt, { MqttClient } from "mqtt";
import axios from "axios";
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
  EnrollBiometricData,
  EnrollBiometricRequest,
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

  // Driver ID - will be set after successful face authentication
  private driverId: string = "";
  private tzOffsetMinutes = 0; // Changed from UTC+7 to UTC+0

  // Driving time tracking
  private drivingTimeTimer: NodeJS.Timeout | null = null;
  private drivingTimeInterval = 60000; // 1 minute in milliseconds

  /**
   * Get address from coordinates using reverse geocoding API
   * @param longitude - Longitude coordinate
   * @param latitude - Latitude coordinate
   * @returns Address string or empty string if failed
   */
  private async getReverseGeocodingAddress(
    longitude: number,
    latitude: number
  ): Promise<string> {
    try {
      // Skip if coordinates are invalid (0,0)
      if (longitude === 0 && latitude === 0) {
        return "";
      }

      const url = `${config.reverseGeocoding.apiUrl}?lat=${latitude}&lon=${longitude}&format=json&addressdetails=1&accept-language=vi`;
      const response = await axios.get(url, { timeout: 10000 });

      if (response.data && response.data.address) {
        const addr = response.data.address;
        const countryCode = addr.country_code?.toLowerCase();

        let formattedAddress = "";

        if (countryCode === "vn") {
          // Vietnam address structure: Road, Ward/District, City/Province
          // Note: city_district contains ward info, city or state contains city/province
          const road = addr.road;
          const ward = addr.city_district || addr.quarter || addr.suburb || addr.neighbourhood;
          const cityProvince = addr.state || addr.county || (addr.city_district ? addr.city : null) || addr.city;

          const parts = [road, ward, cityProvince].filter(Boolean);
          formattedAddress = parts.join(", ");
        } else if (countryCode === "my") {
          const parts = [
            addr.road,
            addr.neighbourhood || addr.suburb || addr.quarter,
            addr.city || addr.district,
            addr.state,
          ].filter(Boolean);
          formattedAddress = parts.join(", ");
        } else {
          const parts = [
            addr.road,
            addr.neighbourhood || addr.suburb || addr.quarter,
            addr.city || addr.town || addr.village,
          ].filter(Boolean);
          formattedAddress = parts.join(", ");
        }

        logger.debug(`Reverse geocoding: ${formattedAddress}`);
        return formattedAddress || response.data.display_name || "";
      }

      return "";
    } catch (error) {
      logger.warn(
        `Failed to get reverse geocoding for lon=${longitude}, lat=${latitude}:`,
        error instanceof Error ? error.message : String(error)
      );
      return "";
    }
  }

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

    this.client.on("connect", async () => {
      logger.info("MQTT connected successfully");
      this.subscribe();

      // Check if there's an active trip and start timer if needed
      try {
        const latestTrip = await tripService.getLatestTrip(this.vehicleId);
        if (latestTrip && latestTrip.status !== VehicleState.COMPLETED) {
          logger.info(`Found active trip ${latestTrip.id} (status: ${latestTrip.status}). Starting driving time tracking.`);
          this.startDrivingTimeTracking();
        } else {
          logger.info("No active trip found. Timer will start when driver checks in.");
        }
      } catch (error) {
        logger.error("Error checking for active trip on connect:", error);
      }
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
      config.mqtt.topics.biometricEnroll,
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
          await this.handleDriverRequest(
            deviceId,
            message as DriverRequestPayload
          );
          break;
        case MqttTopic.DriverCheckIn:
          await this.handleDriverCheckIn(
            deviceId,
            message as DriverCheckInPayload
          );
          break;
        case MqttTopic.CheckOutConfirmRequest:
          await this.handleCheckOutConfirmRequest(
            deviceId,
            message as CheckOutConfirmRequestPayload
          );
          break;
        case MqttTopic.DriverCheckOut:
          await this.handleDriverCheckOut(
            deviceId,
            message as DriverCheckOutPayload
          );
          break;
        case MqttTopic.ParkingState:
          await this.handleParkingState(deviceId, message as ParkingStateEvent);
          break;
        case MqttTopic.DrivingTime:
          await this.handleContinuousDrivingTime(
            deviceId,
            message as DrivingTimeEvent
          );
          break;
        case MqttTopic.VehicleOperationManager:
          await this.handleVehicleOperationManager(
            deviceId,
            message as VehicleOperationManagerEvent
          );
          break;
        case MqttTopic.DMS:
          await this.handleDMS(deviceId, message as DMSPayload);
          break;
        case MqttTopic.OMS:
          await this.handleOMS(deviceId, message as OMSPayload);
          break;
        case MqttTopic.StreamingEvent:
          await this.handleStreamingEvent(
            deviceId,
            message as StreamingEventPayload
          );
          break;
        case MqttTopic.Emergency:
          await this.handleEmergency(deviceId, message as EmergencyPayload);
          break;
        case MqttTopic.EnrollBiometric:
          await this.handleEnrollBiometric(deviceId, message as EnrollBiometricData);
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
  private async handleGPSData(
    deviceId: string,
    payload: GPSDataPayload
  ): Promise<void> {
    try {
      logger.info(
        `Received GPS data from device: ${deviceId}, points: ${payload.gps_data.length}`
      );

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
      logger.error("Error handling GPS data:", error);
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
        await redisClient.cacheGPSData(
          this.cacheSessions.get(deviceId) || "",
          cacheData,
          this.ttlGPSCache
        );
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
      await timescaleDB.insertGPSDataBatch(
        deviceId,
        payload,
        this.cacheSessions.get(deviceId) || undefined
      );
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
      logger.info(`Face vector received (length: ${payload.biometric?.length || 0} chars)`);
      console.info(`Face vector: ${payload.biometric}`);

      // Validate face vector
      if (!payload.biometric || payload.biometric === "None") {
        logger.error("Invalid driver request: face vector is missing or None");
        return;
      }

      // Authenticate via face recognition API
      logger.info(`Authenticating driver via face recognition API...`);
      
      const authResponse = await axios.post(
        `${config.api.baseUrl}/api/face-recognition/authenticate`,
        {
          faceVector: payload.biometric,
          threshold: 0.85
        }
      );

      // Check if response contains error (API returns 200 even on failure)
      if (authResponse.data.errorType) {
        logger.warn(`Face authentication failed for device: ${deviceId}`);
        logger.warn(`Error: ${authResponse.data.description} (${authResponse.data.responseCode})`);
        
        // Publish driver info with "None" values to indicate authentication failure
        const utcMs = Date.now() + this.tzOffsetMinutes;
        const failureDriverInfo: DriverInfoPayload = {
          time_stamp: utcMs,
          message_id: payload.message_id,
          driver_information: {
            driver_name: "None",
            driver_license_number: "None"
          }
        };
        
        await this.publishDriverInfo(deviceId, failureDriverInfo);
        
        // Stream to Socket.IO for monitoring
        socketIOServer.emit("driver:request", {
          device_id: deviceId,
          driver_id: "None",
          message_id: payload.message_id,
          time_stamp: payload.time_stamp,
        });

        socketIOServer.emit("driver:info", {
          device_id: deviceId,
          ...failureDriverInfo,
        });
        
        return;
      }

      // Success case - response has data field
      if (!authResponse.data || !authResponse.data.data) {
        logger.error("Invalid response from face authentication API: missing data field");
        
        // Publish driver info with "None" values
        const utcMs = Date.now() + this.tzOffsetMinutes;
        const failureDriverInfo: DriverInfoPayload = {
          time_stamp: utcMs,
          message_id: payload.message_id,
          driver_information: {
            driver_name: "None",
            driver_license_number: "None"
          }
        };
        
        await this.publishDriverInfo(deviceId, failureDriverInfo);
        return;
      }

      const driverData = authResponse.data.data;
      this.driverId = driverData.id; // Store authenticated driver ID
      
      logger.info(`Face authentication successful for driver: ${driverData.firstName} ${driverData.lastName} (ID: ${driverData.id})`);

      // Build driver info payload
      const utcMs = Date.now() + this.tzOffsetMinutes;

      const driverInfo: DriverInfoPayload = {
        time_stamp: utcMs,
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
        driver_id: driverData.id,
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

      // Convert Unix milliseconds (now using UTC+0)
      const checkInTimestampMs =
        checkInData.check_in_timestamp + this.tzOffsetMinutes;
      logger.info(
        `Check-in time: ${new Date(checkInTimestampMs).toISOString()}`
      );
      logger.info(`Location: ${location.latitude}, ${location.longitude}`);

      // Create new trip with status "Working"
      let tripId = await this.createTripForCheckIn(deviceId, checkInData);
      logger.info(`🔍 DEBUG: After createTripForCheckIn, tripId = ${tripId}`);

      if (tripId) {
        this.cacheSessions.set(deviceId, tripId);

        // Log check-in event only when trip is created successfully
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
          tripId,
          this.driverId
        );

        logger.info(`Driver check-in processed successfully for ${deviceId}`);
      } else {
        logger.error(
          "Cannot create trip. Make sure you end the current trip before check-in."
        );
      }

      // Get address from reverse geocoding
      const address = await this.getReverseGeocodingAddress(
        location.longitude,
        location.latitude
      );

      // Stream to Socket.IO for real-time monitoring
      // If trip creation failed, send "none" as trip_id
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
          address: address,
        },
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
        trip_id: tripId || "none",
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit("device:checkin", {
        device_id: deviceId,
        ...payload,
        trip_id: tripId || "none",
      });
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

      // Convert Unix milliseconds (now using UTC+0)
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

        // Return undefined to indicate trip was NOT created (already exists)
        // This prevents logging duplicate check-in events
        return undefined;
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

        // Start driving time tracking timer when trip begins
        this.startDrivingTimeTracking();
        logger.info("Driving time tracking started for new trip");

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
      const isConfirm =
        latestTrip !== null && latestTrip.status === VehicleState.MOVING;

      if (isConfirm) {
        logger.info(
          `Ongoing trip found for ${deviceId}: ${
            latestTrip!.id
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

      // Get current timestamp in UTC+0
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

      // Convert Unix milliseconds (now using UTC+0)
      const checkOutTimestampMs =
        checkOutData.check_out_timestamp + this.tzOffsetMinutes;
      logger.info(
        `Check-out time: ${new Date(checkOutTimestampMs).toISOString()}`
      );
      logger.info(`Working duration: ${checkOutData.working_duration} minutes`);
      logger.info(`Location: ${location.latitude}, ${location.longitude}`);

      // Get address from reverse geocoding
      const address = await this.getReverseGeocodingAddress(
        location.longitude,
        location.latitude
      );

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
          address: address,
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
        tripId,
        this.driverId
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

      // Convert Unix milliseconds (now using UTC+0)
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

        // Stop driving time tracking timer when trip ends
        this.stopDrivingTimeTracking();
        logger.info("Driving time tracking stopped - trip completed");

        // Clean up cached parking end time
        await redisClient.deleteParkingEndTime(deviceId);
        logger.info(`Cleaned up parking end timestamp cache for completed trip`);

        // Clean up cached driving start time
        await redisClient.deleteDrivingStartTime(deviceId);
        logger.info(`Cleaned up driving start timestamp cache for completed trip`);

        // Clean up cached continuous driving time
        await redisClient.deleteContinuousDrivingTime(deviceId);
        logger.info(`Cleaned up continuous driving time cache for completed trip`);

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
        `Parking ID: ${payload.parking_id}, State: ${
          payload.parking_status === 0 ? "PARKED" : "MOVING"
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

      // Convert Unix milliseconds (now using UTC+0)
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
          },
        });

        // Update trip status to IDLE
        await tripService.updateTrip(latestTrip.id, {
          startTime: latestTrip.startTime, // Required by API
          status: VehicleState.IDLE,
          continuousDrivingDurationSeconds: 0,
        });

        // Delete cached parking end time since we're parking again
        await redisClient.deleteParkingEndTime(deviceId);
        logger.info(`Deleted parking end timestamp - vehicle is now parking`);

        // Delete cached driving start time since we're parked (speed-based tracking)
        await redisClient.deleteDrivingStartTime(deviceId);
        logger.info(`Deleted driving start timestamp - vehicle is now parking`);

        // Delete cached continuous driving time since we're parked
        await redisClient.deleteContinuousDrivingTime(deviceId);
        logger.info(`Deleted continuous driving time cache - vehicle is now parking`);

        // Emit driving time update with continuous driving = 0 immediately
        const currentTimeMs = Date.now() + this.tzOffsetMinutes;
        const currentTime = new Date(currentTimeMs);
        const tripStartTime = new Date(latestTrip.startTime);
        const totalDrivingDurationSeconds = Math.floor(
          (currentTime.getTime() - tripStartTime.getTime()) / 1000
        );
        const idleTimeSeconds = latestTrip.idleTimeSeconds || 0;
        const actualDrivingDurationSeconds = totalDrivingDurationSeconds - idleTimeSeconds;

        socketIOServer.emit("driving:time", {
          device_id: deviceId,
          continuous_driving_time: 0, // Reset to 0 on parking start
          driving_duration: totalDrivingDurationSeconds,
          actual_driving_duration: actualDrivingDurationSeconds,
          idle_time: idleTimeSeconds,
          time_stamp: Date.now(),
          trip_id: latestTrip.id,
          trip_number: latestTrip.tripNumber,
          auto_calculated: false, // This is from parking event, not timer
        });

        socketIOServer.to(`device:${deviceId}`).emit("device:driving:time", {
          device_id: deviceId,
          continuous_driving_time: 0,
          driving_duration: totalDrivingDurationSeconds,
          actual_driving_duration: actualDrivingDurationSeconds,
          idle_time: idleTimeSeconds,
          trip_id: latestTrip.id,
          time_stamp: Date.now(),
          auto_calculated: false,
        });

        logger.info(`Emitted continuous driving time reset to 0 on parking start`);

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

        // Update CONTINUOUS_DRIVING violation if exists
        // Calculate violation duration: parking start time - violation log time
        const continuousDrivingViolationId =
          await redisClient.getViolationEventId(deviceId, "CONTINUOUS_DRIVING");
        if (continuousDrivingViolationId) {
          logger.info(
            `Found cached CONTINUOUS_DRIVING violation event: ${continuousDrivingViolationId}. Updating with actual duration.`
          );

          try {
            // Fetch the violation event to get its original timestamp
            const axios = require("axios");
            const violationEventResponse = await axios.get(
              `${
                require("../config").config.api.baseUrl
              }/api/event-logs/${continuousDrivingViolationId}`
            );

            if (
              violationEventResponse.data &&
              violationEventResponse.data.eventTimestamp
            ) {
              const violationTimestampMs = new Date(
                violationEventResponse.data.eventTimestamp
              ).getTime();
              const parkingStartMs = new Date(timestamp).getTime();

              // Calculate actual violation duration in seconds
              const violationDurationSeconds = Math.floor(
                (parkingStartMs - violationTimestampMs) / 1000
              );

              logger.info(
                `Calculated CONTINUOUS_DRIVING violation duration: ${violationDurationSeconds} seconds (from ${violationEventResponse.data.eventTimestamp} to ${timestamp})`
              );

              // Update the violation event with the actual duration
              await eventLogService.updateViolationEvent(
                continuousDrivingViolationId,
                violationDurationSeconds
              );

              // Emit updated violation to Socket.IO
              socketIOServer.emit("violation:detected", {
                device_id: deviceId,
                trip_id: latestTrip.id,
                trip_number: latestTrip.tripNumber,
                violation_type: "CONTINUOUS_DRIVING",
                eventId: continuousDrivingViolationId,
                continuous_driving_time_violate: violationDurationSeconds,
                parking_duration_violate: 0,
                speed_limit_violate: 0,
                updated: true,
                message_id: payload.message_id,
                time_stamp: payload.time_stamp,
              });

              // Emit to specific device room
              socketIOServer.to(`device:${deviceId}`).emit("device:violation", {
                device_id: deviceId,
                violation_type: "CONTINUOUS_DRIVING",
                violation_value: violationDurationSeconds,
                violation_unit: "seconds",
                updated: true,
                trip_id: latestTrip.id,
                message_id: payload.message_id,
                time_stamp: payload.time_stamp,
              });

              // Delete the cached violation event ID
              await redisClient.deleteViolationEventId(
                deviceId,
                "CONTINUOUS_DRIVING"
              );
              logger.info(
                `Updated and cleaned up CONTINUOUS_DRIVING violation event: ${continuousDrivingViolationId}`
              );
            }
          } catch (error) {
            logger.error(
              "Error updating CONTINUOUS_DRIVING violation event:",
              error
            );
          }
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

        // Update trip status to MOVING, add idle time, and reset continuous driving to 0
        // Continuous driving will start counting from 0 again via timer (when speed >= 3)
        await tripService.updateTrip(latestTrip.id, {
          startTime: latestTrip.startTime, // Required by API
          status: VehicleState.MOVING,
          idleTimeSeconds: newIdleTime,
          continuousDrivingDurationSeconds: 0, // Reset to 0, timer will start counting up
        });

        // Cache parking end timestamp for continuous driving calculation (legacy)
        await redisClient.cacheParkingEndTime(deviceId, timestamp);
        logger.info(`Cached parking end timestamp for continuous driving: ${timestamp}`);

        // Delete cached driving start time - will be set when speed >= 3 km/h
        await redisClient.deleteDrivingStartTime(deviceId);
        logger.info(`Deleted driving start timestamp - will restart when speed >= 3 km/h`);

        // Delete cached continuous driving time - will restart from MQTT data
        await redisClient.deleteContinuousDrivingTime(deviceId);
        logger.info(`Deleted continuous driving time cache - will restart from MQTT data`);

        // Emit driving time update with continuous driving = 0 immediately (will start counting from now)
        const currentTimeMs = Date.now() + this.tzOffsetMinutes;
        const currentTime = new Date(currentTimeMs);
        const tripStartTime = new Date(latestTrip.startTime);
        const totalDrivingDurationSeconds = Math.floor(
          (currentTime.getTime() - tripStartTime.getTime()) / 1000
        );
        const actualDrivingDurationSeconds = totalDrivingDurationSeconds - newIdleTime;

        socketIOServer.emit("driving:time", {
          device_id: deviceId,
          continuous_driving_time: 0, // Start counting from 0 after parking end
          driving_duration: totalDrivingDurationSeconds,
          actual_driving_duration: actualDrivingDurationSeconds,
          idle_time: newIdleTime,
          time_stamp: Date.now(),
          trip_id: latestTrip.id,
          trip_number: latestTrip.tripNumber,
          auto_calculated: false, // This is from parking event, not timer
        });

        socketIOServer.to(`device:${deviceId}`).emit("device:driving:time", {
          device_id: deviceId,
          continuous_driving_time: 0,
          driving_duration: totalDrivingDurationSeconds,
          actual_driving_duration: actualDrivingDurationSeconds,
          idle_time: newIdleTime,
          trip_id: latestTrip.id,
          time_stamp: Date.now(),
          auto_calculated: false,
        });

        logger.info(`Emitted continuous driving time reset to 0 on parking end - will start counting from cached timestamp`);

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

        // Update PARKING_DURATION violation if exists
        // Calculate violation duration: parking end time - violation log time
        const parkingDurationViolationId =
          await redisClient.getViolationEventId(deviceId, "PARKING_DURATION");
        if (parkingDurationViolationId) {
          logger.info(
            `Found cached PARKING_DURATION violation event: ${parkingDurationViolationId}. Updating with actual duration.`
          );

          try {
            // Fetch the violation event to get its original timestamp
            const axios = require("axios");
            const violationEventResponse = await axios.get(
              `${
                require("../config").config.api.baseUrl
              }/api/event-logs/${parkingDurationViolationId}`
            );

            if (
              violationEventResponse.data &&
              violationEventResponse.data.eventTimestamp
            ) {
              const violationTimestampMs = new Date(
                violationEventResponse.data.eventTimestamp
              ).getTime();
              const parkingEndMs = new Date(timestamp).getTime();

              // Calculate actual violation duration in seconds
              const violationDurationSeconds = Math.floor(
                (parkingEndMs - violationTimestampMs) / 1000
              );

              logger.info(
                `Calculated PARKING_DURATION violation duration: ${violationDurationSeconds} seconds (from ${violationEventResponse.data.eventTimestamp} to ${timestamp})`
              );

              // Update the violation event with the actual duration
              await eventLogService.updateViolationEvent(
                parkingDurationViolationId,
                violationDurationSeconds
              );

              // Emit updated violation to Socket.IO
              socketIOServer.emit("violation:detected", {
                device_id: deviceId,
                trip_id: latestTrip.id,
                trip_number: latestTrip.tripNumber,
                violation_type: "PARKING_DURATION",
                eventId: parkingDurationViolationId,
                continuous_driving_time_violate: 0,
                parking_duration_violate: violationDurationSeconds,
                speed_limit_violate: 0,
                updated: true,
                message_id: payload.message_id,
                time_stamp: payload.time_stamp,
              });

              // Emit to specific device room
              socketIOServer.to(`device:${deviceId}`).emit("device:violation", {
                device_id: deviceId,
                violation_type: "PARKING_DURATION",
                violation_value: violationDurationSeconds,
                violation_unit: "seconds",
                updated: true,
                trip_id: latestTrip.id,
                message_id: payload.message_id,
                time_stamp: payload.time_stamp,
              });

              // Delete the cached violation event ID
              await redisClient.deleteViolationEventId(
                deviceId,
                "PARKING_DURATION"
              );
              logger.info(
                `Updated and cleaned up PARKING_DURATION violation event: ${parkingDurationViolationId}`
              );
            }
          } catch (error) {
            logger.error(
              "Error updating PARKING_DURATION violation event:",
              error
            );
          }
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
   * Start driving time tracking timer
   * Emits driving time data every minute
   */
  private startDrivingTimeTracking(): void {
    // Clear existing timer if any
    if (this.drivingTimeTimer) {
      clearInterval(this.drivingTimeTimer);
    }

    // Start new timer - runs every minute
    this.drivingTimeTimer = setInterval(async () => {
      await this.calculateAndEmitDrivingTime();
    }, this.drivingTimeInterval);

    logger.info("Driving time tracking started - emitting every 1 minute");
  }

  /**
   * Stop driving time tracking timer
   */
  private stopDrivingTimeTracking(): void {
    if (this.drivingTimeTimer) {
      clearInterval(this.drivingTimeTimer);
      this.drivingTimeTimer = null;
      logger.info("Driving time tracking stopped");
    }
  }

  /**
   * Calculate and emit driving time data
   * Called automatically every minute when trip is active
   * NEW LOGIC: Continuous driving time received from MQTT (cached in Redis)
   *
   * Flow:
   * 1. Get continuous driving time from Redis cache (received from MQTT)
   * 2. Calculate total driving duration (self-calculated)
   * 3. Update DB and emit to Socket.IO
   */
  private async calculateAndEmitDrivingTime(): Promise<void> {
    try {
      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(this.vehicleId);

      if (!latestTrip) {
        // No trip found, stop timer
        logger.warn("No active trip found. Stopping driving time tracking.");
        this.stopDrivingTimeTracking();
        return;
      }

      // If trip is completed, stop timer
      if (latestTrip.status === VehicleState.COMPLETED) {
        logger.info("Trip completed. Stopping driving time tracking.");
        this.stopDrivingTimeTracking();
        return;
      }

      // Get current time in UTC+0
      const currentTimeMs = Date.now() + this.tzOffsetMinutes;
      const currentTime = new Date(currentTimeMs);

      // Parse trip start time (already in UTC+0 format from DB)
      const tripStartTime = new Date(latestTrip.startTime);

      // Calculate total driving duration in seconds
      const totalDrivingDurationSeconds = Math.floor(
        (currentTime.getTime() - tripStartTime.getTime()) / 1000
      );

      // Get idle time from trip
      const idleTimeSeconds = latestTrip.idleTimeSeconds || 0;
      const actualDrivingDurationSeconds = totalDrivingDurationSeconds - idleTimeSeconds;

      // Get device ID (TODO: Map from vehicleId to deviceId)
      const deviceId = "vehicle_001";

      // Get current speed from GPS cache
      const latestGPSData = await redisClient.getGPSData(deviceId);
      const currentSpeed = latestGPSData?.gps_data?.speed || 0;

      // Get continuous driving time from Redis cache (received from MQTT)
      // If not available, default to 0
      let continuousDrivingSeconds = await redisClient.getContinuousDrivingTime(deviceId);

      if (continuousDrivingSeconds === null) {
        // No MQTT data received yet, default to 0
        continuousDrivingSeconds = 0;
        logger.debug(`No continuous driving time from MQTT yet for device ${deviceId}, using 0`);
      } else {
        logger.debug(`Using continuous driving time from MQTT: ${continuousDrivingSeconds}s`);
      }

      // If vehicle is parking (IDLE), continuous driving should be 0
      if (latestTrip.status === VehicleState.IDLE) {
        continuousDrivingSeconds = 0;
      }

      logger.debug(
        `Driving time calculated - Total: ${totalDrivingDurationSeconds}s, Idle: ${idleTimeSeconds}s, Actual: ${actualDrivingDurationSeconds}s, Continuous: ${continuousDrivingSeconds}s (from MQTT), Speed: ${currentSpeed} km/h`
      );

      // Update trip with calculated durations
      await tripService.updateTrip(latestTrip.id, {
        startTime: latestTrip.startTime, // Required by API
        continuousDrivingDurationSeconds: continuousDrivingSeconds, // From MQTT
        durationSeconds: totalDrivingDurationSeconds, // Self-calculated
      });

      // Stream to Socket.IO for real-time monitoring
      socketIOServer.emit("driving:time", {
        device_id: deviceId,
        continuous_driving_time: continuousDrivingSeconds, // From MQTT
        driving_duration: totalDrivingDurationSeconds, // Self-calculated
        actual_driving_duration: actualDrivingDurationSeconds,
        idle_time: idleTimeSeconds,
        current_speed: currentSpeed,
        time_stamp: Date.now(),
        trip_id: latestTrip.id,
        trip_number: latestTrip.tripNumber,
        auto_calculated: false, // Flag: continuous driving from MQTT
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit("device:driving:time", {
        device_id: deviceId,
        continuous_driving_time: continuousDrivingSeconds, // From MQTT
        driving_duration: totalDrivingDurationSeconds, // Self-calculated
        actual_driving_duration: actualDrivingDurationSeconds,
        idle_time: idleTimeSeconds,
        current_speed: currentSpeed,
        trip_id: latestTrip.id,
        time_stamp: Date.now(),
        auto_calculated: false, // Flag: continuous driving from MQTT
      });
    } catch (error) {
      logger.error("Error calculating driving time:", error);
    }
  }

  /**
   * Handle continuous driving time messages from MQTT
   * Caches the value to Redis - the timer will use it for emit and DB update
   */
  private async handleContinuousDrivingTime(
    deviceId: string,
    payload: DrivingTimeEvent
  ): Promise<void> {
    try {
      logger.info(`Received continuous driving time from device: ${deviceId}`);
      logger.info(
        `MQTT payload - Continuous driving time: ${payload.continuous_driving_time} seconds, Total driving duration: ${payload.driving_duration} seconds`
      );

      // Cache continuous driving time to Redis
      // The timer (calculateAndEmitDrivingTime) will read this value
      await redisClient.cacheContinuousDrivingTime(deviceId, payload.continuous_driving_time);

      logger.info(
        `Cached continuous driving time ${payload.continuous_driving_time}s from MQTT for device ${deviceId}`
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

      // Convert Unix milliseconds (now using UTC+0)
      const timestampMs = payload.time_stamp + this.tzOffsetMinutes;
      const timestamp = new Date(timestampMs).toISOString();
      const violations = payload.violation_operation;

      // Determine which violation is active (non-zero value)
      let violationType:
        | "CONTINUOUS_DRIVING"
        | "PARKING_DURATION"
        | "SPEED_LIMIT"
        | null = null;
      let violationValue = 0;
      let violationUnit = "";

      if (violations.continuous_driving_time_violate >= 0) {
        violationType = "CONTINUOUS_DRIVING";
        violationValue = violations.continuous_driving_time_violate;
        violationUnit = "minutes";
      } else if (violations.parking_duration_violate >= 0) {
        violationType = "PARKING_DURATION";
        violationValue = violations.parking_duration_violate;
        violationUnit = "minutes";
      } else if (violations.speed_limit_violate >= 0) {
        violationType = "SPEED_LIMIT";
        violationValue = violations.speed_limit_violate;
        violationUnit = "km/h";
      }

      // If no violation is detected, log and return
      if (!violationType) {
        logger.info(`No active violation in message from ${deviceId}`);
        return;
      }

      // Generate video URL from messageId
      const videoUrl = `http://103.216.116.186:9000/fleet-videos/${payload.message_id}.mp4`;

      // Log the violation event
      const eventId = `violation_${deviceId}_${payload.message_id}`;
      const violationEvent = await eventLogService.logViolationEvent(
        eventId,
        this.vehicleId,
        {
          timestamp,
          messageId: payload.message_id,
          violationType,
          violationValue,
          violationUnit,
          videoUrl: videoUrl, // Add video attachment
        },
        latestTrip.id,
        this.driverId
      );

      // Cache eventId for CONTINUOUS_DRIVING and PARKING_DURATION violations
      if (
        violationEvent &&
        violationEvent.id &&
        (violationType === "CONTINUOUS_DRIVING" ||
          violationType === "PARKING_DURATION")
      ) {
        await redisClient.cacheViolationEventId(
          deviceId,
          violationType,
          violationEvent.id
        );
        logger.info(
          `Cached violation event ID for ${violationType}: ${violationEvent.id}`
        );
      }

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
        eventId: eventId,
        trip_number: latestTrip.tripNumber,
        violation_type: violationType,
        continuous_driving_time_violate:
          violations.continuous_driving_time_violate,
        parking_duration_violate: violations.parking_duration_violate,
        speed_limit_violate: violations.speed_limit_violate,
        speed_violation_count: speedViolationCount,
        updated: false,
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
        `Vehicle operation violation processed successfully for ${deviceId}${
          violationType === "SPEED_LIMIT"
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
        logger.error(
          `Invalid DMS payload - missing violate_infomation_DMS field`
        );
        return;
      }

      const violationInfo = payload.violate_infomation_DMS;

      // Map behavior code to string name - violation_dms is now number
      const behaviorNames = [
        "None",
        "PhoneUse",
        "Drowness",
        "Smoking",
        "Unfocus",
        "Handoff",
      ];
      const behaviorName =
        behaviorNames[violationInfo.violation_dms] || "Unknown";

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

      // Convert Unix milliseconds (now using UTC+0)
      const timestampMs = payload.time_stamp + this.tzOffsetMinutes;
      const timestamp = new Date(timestampMs).toISOString();

      // Get latest GPS data from Redis cache instead of MQTT payload
      const latestGPSData = await redisClient.getGPSData(deviceId);
      let latitude = 0;
      let longitude = 0;
      let gpsTimestamp = timestamp;

      if (latestGPSData && latestGPSData.gps_data) {
        latitude = latestGPSData.gps_data.latitude;
        longitude = latestGPSData.gps_data.longitude;

        // Use GPS timestamp from cache if available (UTC+0)
        if (latestGPSData.time_stamp) {
          const gpsTimestampMs = latestGPSData.time_stamp + this.tzOffsetMinutes;
          gpsTimestamp = new Date(gpsTimestampMs).toISOString();
        }

        logger.info(`Using GPS from Redis cache: lat=${latitude}, lng=${longitude}`);
      } else {
        logger.warn(`No GPS cache found for ${deviceId}, using default coordinates`);
      }

      // Generate video URL from messageId
      const videoUrl = `http://103.216.116.186:9000/fleet-videos/${payload.message_id}.mp4`;

      // Log DMS violation event with image URL and video URL
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
            latitude: latitude,
            longitude: longitude,
            gpsTimestamp,
          },
          imageUrl: imageUrl, // Send MinIO URL instead of base64
          videoUrl: videoUrl, // Send video URL
          driverName: payload.driver_information?.driver_name || "Unknown",
          driverLicenseNumber:
            payload.driver_information?.driver_license_number || "Unknown",
        },
        latestTrip?.id,
        latestTrip
          ? {
              vehicleId: latestTrip.vehicleId,
              driverId: latestTrip.driverId,
              tripNumber: latestTrip.tripNumber,
              licensePlate: latestTrip.licensePlate,
              vehicleType: latestTrip.vehicleType,
            }
          : undefined
      );

      logger.info(
        `DMS violation logged: ${behaviorName} (${violationInfo.violation_dms})`
      );

      // Count total DMS violations in this session
      let dmsViolationCount = 0;
      if (latestTrip) {
        dmsViolationCount = await eventLogService.countDMSViolationsBySession(
          latestTrip.id
        );
      }

      // Get address from reverse geocoding
      const address = await this.getReverseGeocodingAddress(longitude, latitude);

      // Stream to Socket.IO for real-time monitoring with image URL
      socketIOServer.emit("dms:violation", {
        device_id: deviceId,
        trip_id: latestTrip?.id,
        trip_number: latestTrip?.tripNumber,
        behavior_violate: violationInfo.violation_dms,
        behavior_name: behaviorName,
        speed: violationInfo.speed,
        location: {
          latitude: latitude,
          longitude: longitude,
          gps_timestamp: latestGPSData?.time_stamp || payload.time_stamp,
          address: address,
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
        logger.error(
          `Invalid OMS payload - missing violate_infomation_OMS field`
        );
        return;
      }

      const violationInfo = payload.violate_infomation_OMS;

      // Map behavior code to string name - OMS only has 2 values - violation_oms is now number
      const behaviorNames = ["None", "Unfasten_seat_belt"];
      const behaviorName =
        behaviorNames[violationInfo.violation_oms] || "Unknown";

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

      // Convert Unix milliseconds (now using UTC+0)
      const timestampMs = payload.time_stamp + this.tzOffsetMinutes;
      const timestamp = new Date(timestampMs).toISOString();

      // Get latest GPS data from Redis cache instead of MQTT payload
      const latestGPSData = await redisClient.getGPSData(deviceId);
      let latitude = 0;
      let longitude = 0;
      let gpsTimestamp = timestamp;

      if (latestGPSData && latestGPSData.gps_data) {
        latitude = latestGPSData.gps_data.latitude;
        longitude = latestGPSData.gps_data.longitude;

        // Use GPS timestamp from cache if available (UTC+0)
        if (latestGPSData.time_stamp) {
          const gpsTimestampMs = latestGPSData.time_stamp + this.tzOffsetMinutes;
          gpsTimestamp = new Date(gpsTimestampMs).toISOString();
        }

        logger.info(`Using GPS from Redis cache: lat=${latitude}, lng=${longitude}`);
      } else {
        logger.warn(`No GPS cache found for ${deviceId}, using default coordinates`);
      }

      // Generate video URL from messageId
      const videoUrl = `http://103.216.116.186:9000/fleet-videos/${payload.message_id}.mp4`;

      // Log OMS violation event with image URL and video URL
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
            latitude: latitude,
            longitude: longitude,
            gpsTimestamp,
          },
          imageUrl: imageUrl, // Send MinIO URL instead of base64
          videoUrl: videoUrl, // Send video URL
          driverName: payload.driver_information?.driver_name || "Unknown",
          driverLicenseNumber:
            payload.driver_information?.driver_license_number || "Unknown",
        },
        latestTrip?.id,
        latestTrip
          ? {
              vehicleId: latestTrip.vehicleId,
              driverId: latestTrip.driverId,
              tripNumber: latestTrip.tripNumber,
              licensePlate: latestTrip.licensePlate,
            }
          : undefined
      );

      logger.info(
        `OMS violation logged: ${behaviorName} (${violationInfo.violation_oms})`
      );

      // Count total OMS violations in this session
      let omsViolationCount = 0;
      if (latestTrip) {
        omsViolationCount = await eventLogService.countDMSViolationsBySession(
          latestTrip.id
        );
      }

      // Get address from reverse geocoding
      const address = await this.getReverseGeocodingAddress(longitude, latitude);

      // Stream to Socket.IO for real-time monitoring with image URL
      socketIOServer.emit("oms:violation", {
        device_id: deviceId,
        trip_id: latestTrip?.id,
        trip_number: latestTrip?.tripNumber,
        behavior_violate: violationInfo.violation_oms,
        behavior_name: behaviorName,
        speed: violationInfo.speed,
        location: {
          latitude: latitude,
          longitude: longitude,
          gps_timestamp: latestGPSData?.time_stamp || payload.time_stamp,
          address: address,
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
      logger.error(
        `Emergency Raw Payload: ${JSON.stringify(payload, null, 2)}`
      );

      const emergencyData = payload.Emergency;

      logger.error(
        `Emergency Location: ${emergencyData.latitude}, ${emergencyData.longitude}`
      );
      logger.error(
        `GPS Timestamp: ${new Date(emergencyData.gps_timestamp).toISOString()}`
      );

      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(this.vehicleId);

      // Convert Unix milliseconds (now using UTC+0)
      const timestampMs = payload.time_stamp + this.tzOffsetMinutes;
      const timestamp = new Date(timestampMs).toISOString();

      // Get address from reverse geocoding
      const address = await this.getReverseGeocodingAddress(
        emergencyData.longitude,
        emergencyData.latitude
      );

      // Stream to Socket.IO for real-time monitoring with ALERT severity
      socketIOServer.emit("emergency:alert", {
        device_id: deviceId,
        trip_id: latestTrip?.id,
        trip_number: latestTrip?.tripNumber,
        location: {
          latitude: emergencyData.latitude,
          longitude: emergencyData.longitude,
          gps_timestamp: emergencyData.gps_timestamp,
          address: address,
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
          address: address,
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
          address: address,
        },
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
        timestamp: timestamp,
      });

      // Log emergency event to EventLog with ALERT severity (UTC+0)
      const gpsTimestampMs = emergencyData.gps_timestamp + this.tzOffsetMinutes;
      const gpsTimestamp = new Date(gpsTimestampMs).toISOString();
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
        latestTrip
          ? {
              vehicleId: latestTrip.vehicleId,
              driverId: latestTrip.driverId,
              tripNumber: latestTrip.tripNumber,
              licensePlate: latestTrip.licensePlate,
              vehicleType: latestTrip.vehicleType,
              driverName: latestTrip.driverName,
              driverLicenseNumber: latestTrip.licenseNumber,
            }
          : undefined
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

    // Stop driving time tracking
    this.stopDrivingTimeTracking();

    // Clear GPS buffer timers
    for (const [deviceId, timer] of this.gpsBufferTimers.entries()) {
      clearTimeout(timer);
      logger.debug(`Cleared GPS buffer timer for ${deviceId}`);
    }
    this.gpsBufferTimers.clear();
    this.gpsBuffers.clear();
  }

  /**
   * Enroll biometric data for a driver
   * 1. Check duplicate via POST /api/face-recognition/check-duplicate
   * 2. Create driver via POST /api/drivers
   */
  public async handleEnrollBiometric(deviceId: string, payload: EnrollBiometricData): Promise<void> {
    const topic = `fms/${deviceId}/biometric/enroll_response`;

    try {
      logger.info(`Handling enroll biometric for device ${deviceId}`);

      // Check for duplicate biometric (95% similarity threshold)
      const duplicateResult = await driverService.checkDuplicateBiometric(payload.biometric, 0.1);
      if (duplicateResult && duplicateResult.data && duplicateResult.data.length > 0) {
        logger.warn(`Duplicate biometric found for device ${deviceId}`);
        const response = {
          time_stamp: Date.now(),
          message_id: payload.message_id,
          status: 'error',
          message: 'Biometric already exists'
        };
        this.client?.publish(topic, JSON.stringify(response), { qos: 1 });

        socketIOServer.emit("biometric:duplicate", {
          device_id: deviceId,
          message_id: payload.message_id,
          status: 'error',
          message: 'Biometric already exists',
          existing_driver: duplicateResult.data[0]
        });

        socketIOServer.to(`device:${deviceId}`).emit("device:biometric:duplicate", {
          device_id: deviceId,
          message_id: payload.message_id,
          status: 'error',
          message: 'Biometric already exists',
          existing_driver: duplicateResult.data[0]
        });

        return;
      }

      let driverInfoData = payload.driver_information;
      if (typeof driverInfoData === 'string') {
        try {
          driverInfoData = JSON.parse(driverInfoData);
        } catch (e) {
          logger.warn("driver_information là string nhưng không thể parse JSON, thử dùng trực tiếp.");
        }
      }
        // Parse driver name
      const driverName = driverInfoData?.driver_name;
      const nameParts = driverName?.split(' ');
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ');

      // Helper function for future date
      const getFutureDate = (yearsFromNow: number): string => {
        const date = new Date();
        date.setFullYear(date.getFullYear() + yearsFromNow);
        return date.toISOString().split('T')[0];
      };

      // Helper function to generate random phone number
      const generateRandomPhone = (): string => {
        const prefixes = ['090', '091', '092', '093', '094', '095', '096', '097', '098', '099'];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const suffix = Math.floor(Math.random() * 10000000).toString().padStart(7, '0');
        return `${prefix}${suffix}`;
      };

      // Build create driver request according to API spec
      const createDriverRequest = {
        firstName,
        lastName,
        phone: generateRandomPhone(),
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase().replace(/\s/g, '')}@example.com`,
        licenseNumber: driverInfoData?.driver_license_number || `DL${Date.now()}`,
        licenseType: driverInfoData?.class || 'B2',
        licenseExpiry: driverInfoData?.expiry_date || getFutureDate(5),
        status: 'active',
        notes: 'Enrolled via biometric system',
        faceVector: payload.biometric
      };

      // Create driver via POST /api/drivers
      const result = await driverService.createDriver(createDriverRequest);

      if (result) {
        logger.info(`Driver enrolled successfully: ${result.firstName} ${result.lastName} (ID: ${result.id})`);
        const response = {
          time_stamp: Date.now(),
          message_id: payload.message_id,
          status: 'success',
          message: 'Enrollment successful',
          driver_id: result.id
        };
        this.client?.publish(topic, JSON.stringify(response), { qos: 1 });

        socketIOServer.emit("biometric:enrolled", {
          device_id: deviceId,
          message_id: payload.message_id,
          status: 'success',
          driver_id: result.id,
          driver_name: `${result.firstName} ${result.lastName}`
        });

        socketIOServer.to(`device:${deviceId}`).emit("device:biometric:enrolled", {
          device_id: deviceId,
          message_id: payload.message_id,
          status: 'success',
          driver_id: result.id,
          driver_name: `${result.firstName} ${result.lastName}`
        });
      } else {
        logger.error(`Failed to create driver for device ${deviceId}`);
        const response = {
          time_stamp: Date.now(),
          message_id: payload.message_id,
          status: 'error',
          message: 'Enrollment failed'
        };
        this.client?.publish(topic, JSON.stringify(response), { qos: 1 });

        socketIOServer.emit("biometric:enroll:failed", {
          device_id: deviceId,
          message_id: payload.message_id,
          status: 'error',
          message: 'Enrollment failed'
        });

        socketIOServer.to(`device:${deviceId}`).emit("device:biometric:enroll:failed", {
          device_id: deviceId,
          message_id: payload.message_id,
          status: 'error',
          message: 'Enrollment failed'
        });
      }
    } catch (error: any) {
      logger.error(`Error handling enroll biometric for device ${deviceId}:`, error);
      const response = {
        time_stamp: Date.now(),
        message_id: payload.message_id,
        status: 'error',
        message: error.message || 'Enrollment failed'
      };
      this.client?.publish(topic, JSON.stringify(response), { qos: 1 });

      socketIOServer.emit("biometric:enroll:failed", {
        device_id: deviceId,
        message_id: payload.message_id,
        status: 'error',
        message: error.message || 'Enrollment failed'
      });

      socketIOServer.to(`device:${deviceId}`).emit("device:biometric:enroll:failed", {
        device_id: deviceId,
        message_id: payload.message_id,
        status: 'error',
        message: error.message || 'Enrollment failed'
      });
    }
  }
}

export const mqttService = new MQTTService();
