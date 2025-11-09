import mqtt, { MqttClient } from 'mqtt';
import { config } from '../config';
import { logger } from '../utils/logger';
import { EdgeEvent, GPSDataPayload, GPSDataPoint, DriverRequestPayload, DriverInfoPayload, DriverCheckInPayload, CheckOutConfirmRequestPayload, CheckOutConfirmResponsePayload, DriverCheckOutPayload, ParkingStateEvent, DrivingTimeEvent } from '../types';
import { redisClient } from './redis';
import { timescaleDB } from './timescaledb';
import { socketIOServer } from '../server/socketio';
import { driverService } from '../services/driverService';
import { tripService } from '../services/tripService';
import { eventLogService } from '../services/eventLogService';
import { CacheKeys, VehicleState } from '../utils/constants';

class MQTTService {
  private client: MqttClient | null = null;
  private messageBuffer: EdgeEvent[] = [];
  private batchSize = 50;
  private batchTimeout = 5000; // 5 seconds
  private batchTimer: NodeJS.Timeout | null = null;
  private ttlGPSCache = 30; // 30 seconds

  /**
   * Connect to MQTT broker
   */
  connect(): void {
    logger.info(`Connecting to MQTT broker: ${config.mqtt.brokerUrl}`);

    this.client = mqtt.connect(config.mqtt.brokerUrl, {
      clientId: config.mqtt.clientId,
      username: config.mqtt.username,
      password: config.mqtt.password,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
    });

    this.client.on('connect', () => {
      logger.info('MQTT connected successfully');
      this.subscribe();
    });

    this.client.on('error', (error) => {
      logger.error('MQTT connection error:', error);
    });

    this.client.on('offline', () => {
      logger.warn('MQTT client offline');
    });

    this.client.on('reconnect', () => {
      logger.info('MQTT reconnecting...');
    });

    this.client.on('message', (topic, payload) => {
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
    ];

    topics.forEach(topic => {
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
      const topicParts = topic.split('/');
      const deviceId = topicParts[1] || message.device_id;

      // Check if this is a GPS data message
      if (topic.includes('operation_monitoring/gps_data')) {
        await this.handleGPSData(deviceId, message as GPSDataPayload);
      }
      // Check if this is a driver request message
      else if (topic.includes('driving_session/driver_request')) {
        await this.handleDriverRequest(deviceId, message as DriverRequestPayload);
      }
      // Check if this is a driver check-in message
      else if (topic.includes('driving_session/driver_checkin')) {
        await this.handleDriverCheckIn(deviceId, message as DriverCheckInPayload);
      }
      // Check if this is a check-out confirm request message
      else if (topic.includes('driving_session/driver_checkout_confirm_request')) {
        await this.handleCheckOutConfirmRequest(deviceId, message as CheckOutConfirmRequestPayload);
      }
      // Check if this is a driver check-out message
      else if (topic.includes('driving_session/driver_checkout')) {
        await this.handleDriverCheckOut(deviceId, message as DriverCheckOutPayload);
      }
      else if (topic.includes('driving_session/parking_state')) {
        await this.handleParkingState(deviceId, message as ParkingStateEvent);
      }
      // Check if this is a continuous driving time message
      else if (topic.includes('driving_session/continuous_driving_time')) {
        await this.handleContinuousDrivingTime(deviceId, message as DrivingTimeEvent);
      }
      else {
        // Handle generic event
        const event: EdgeEvent = {
          device_id: deviceId,
          timestamp: new Date(message.timestamp || Date.now()),
          event_type: message.event_type || 'unknown',
          data: message.data || message,
          metadata: message.metadata,
        };

        logger.debug(`Received event from device: ${deviceId}, type: ${event.event_type}`);

        // Process event in parallel
        await Promise.allSettled([
          this.cacheEvent(event),
          this.streamEvent(event),
        ]);

        // Add to batch for database insertion
        this.addToBatch(event);
      }

    } catch (error) {
      logger.error('Error handling MQTT message:', error);
    }
  }

  /**
   * Handle GPS data messages
   */
  private async handleGPSData(deviceId: string, payload: GPSDataPayload): Promise<void> {
    try {
      logger.debug(`Received GPS data from device: ${deviceId}, points: ${payload.gps_data.length}`);

      // Process GPS data in parallel
      await Promise.allSettled([
        this.cacheGPSData(deviceId, payload),
        this.streamGPSData(deviceId, payload),
        this.storeGPSData(deviceId, payload),
      ]);

    } catch (error) {
      logger.error('Error handling GPS data:', error);
    }
  }

  /**
   * Cache GPS data in Redis
   */
  private async cacheGPSData(deviceId: string, payload: GPSDataPayload): Promise<void> {
    try {
      // Get the latest GPS data point (last item in the array)
      const latestGPSPoint = payload.gps_data[payload.gps_data.length - 1];

      if (latestGPSPoint) {
        const cacheData = {
          time_stamp: payload.time_stamp,
          message_id: payload.message_id,
          gps_data: latestGPSPoint,
        };
        await redisClient.cacheGPSData(deviceId, cacheData, this.ttlGPSCache);
      }
    } catch (error) {
      logger.error('Error caching GPS data:', error);
    }
  }

  /**
   * Stream GPS data to dashboard via Socket.IO
   */
  private streamGPSData(deviceId: string, payload: GPSDataPayload): void {
    try {
      // Get the latest GPS data point (last item in the array)
      const latestGPSPoint = payload.gps_data[payload.gps_data.length - 1];

      if (latestGPSPoint) {
        const streamData = {
          device_id: deviceId,
          time_stamp: payload.time_stamp,
          message_id: payload.message_id,
          gps_data: latestGPSPoint,
        };

        // Emit to channel by device ID
        socketIOServer.emit(deviceId, streamData);

        // Also emit to generic GPS channel for monitoring all devices
        socketIOServer.emit('gps:all', streamData);
      }
    } catch (error) {
      logger.error('Error streaming GPS data:', error);
    }
  }

  /**
   * Store GPS data in TimescaleDB
   */
  private async storeGPSData(deviceId: string, payload: GPSDataPayload): Promise<void> {
    try {
      await timescaleDB.insertGPSDataBatch(deviceId, payload);
    } catch (error) {
      logger.error('Error storing GPS data:', error);
    }
  }

  /**
   * Handle driver request messages
   */
  private async handleDriverRequest(deviceId: string, payload: DriverRequestPayload): Promise<void> {
    try {
      logger.info(`Received driver request from device: ${deviceId}`);

      // Validate: At least one of driver_image or driver_rfid must be present
      const hasImage = payload.request_data.driver_image && payload.request_data.driver_image !== 'None';
      const hasRfid = payload.request_data.driver_rfid && payload.request_data.driver_rfid !== 'None';

      if (!hasImage && !hasRfid) {
        logger.error('Invalid driver request: Neither driver_image nor driver_rfid provided');
        return;
      }

      // Log which method is being used
      if (hasRfid) {
        logger.info(`Driver identification by RFID: ${payload.request_data.driver_rfid}`);
      } else if (hasImage) {
        logger.info(`Driver identification by Image (length: ${payload.request_data.driver_image?.length || 0} chars)`);
      }

      // Get driver info from API
      let driverData;

      try {
        // TODO: Implement actual RFID/Image matching to get driver UUID
        // For now, use predefined UUIDs for testing
        const driverUuid = hasRfid
          ? '880e8400-e29b-41d4-a716-446655440001'  // RFID driver
          : '880e8400-e29b-41d4-a716-446655440002'; // Image driver

        logger.info(`Fetching driver info from API for UUID: ${driverUuid}`);
        driverData = await driverService.getDriverById(driverUuid);

        // Fallback to mock data if API fails or driver not found
        if (!driverData) {
          logger.warn(`Driver ${driverUuid} not found in API, using mock data`);
          driverData = driverService.getMockDriverInfo(hasRfid ? 0 : 1);
        }
      } catch (error) {
        logger.error('Error fetching driver from API, using mock data:', error);
        driverData = driverService.getMockDriverInfo(hasRfid ? 0 : 1);
      }

      // Build driver info payload
      // Convert to UTC+7 milliseconds
      const utc7Ms = Date.now() + (7 * 60 * 60 * 1000);

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
      socketIOServer.emit('driver:request', {
        device_id: deviceId,
        ...payload,
      });

      socketIOServer.emit('driver:info', {
        device_id: deviceId,
        ...driverInfo,
      });

    } catch (error) {
      logger.error('Error handling driver request:', error);
    }
  }

  /**
   * Publish driver info to MQTT topic
   */
  private async publishDriverInfo(deviceId: string, driverInfo: DriverInfoPayload): Promise<void> {
    try {
      if (!this.client) {
        logger.error('MQTT client not connected');
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
      logger.error('Error publishing driver info:', error);
    }
  }

  /**
   * Handle driver check-in messages
   */
  private async handleDriverCheckIn(deviceId: string, payload: DriverCheckInPayload): Promise<void> {
    try {
      logger.info(`Received driver check-in from device: ${deviceId}`);

      const checkInData = payload.check_in_data;
      const driverInfo = checkInData.driver_information;
      const location = checkInData.CheckInLocation;

      logger.info(`Driver: ${driverInfo.driver_name} (${driverInfo.driver_license_number})`);

      // Convert Unix milliseconds to UTC+7
      const checkInTimestampMs = checkInData.check_in_timestamp + (7 * 60 * 60 * 1000);
      logger.info(`Check-in time: ${new Date(checkInTimestampMs).toISOString()}`);
      logger.info(`Location: ${location.latitude}, ${location.longitude}`);

      // Stream to Socket.IO for real-time monitoring
      socketIOServer.emit('driver:checkin', {
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
      socketIOServer.to(`device:${deviceId}`).emit('device:checkin', {
        device_id: deviceId,
        ...payload,
      });

      // Create new trip with status "Working"
      let tripId = await this.createTripForCheckIn(deviceId, checkInData);
      logger.info(`🔍 DEBUG: After createTripForCheckIn, tripId = ${tripId}`);

      // If trip creation failed, try to get existing active trip
      if (!tripId) {
        logger.info(`Trip creation failed, attempting to get existing active trip for ${deviceId}`);
        const vehicleId = "770e8400-e29b-41d4-a716-446655440002"; // TODO: Map deviceId to vehicleId
        const existingTrip = await tripService.getLatestTrip(vehicleId);
        if (existingTrip && !existingTrip.endTime) {
          tripId = existingTrip.id;
          logger.info(`Using existing active trip: ${tripId}`);
        } else {
          logger.warn(`⚠️ No active trip found! tripId will be undefined`);
        }
      }

      logger.info(`🔍 DEBUG: Final tripId before logging event = ${tripId}`);

      // Log check-in event
      await eventLogService.logCheckInEvent(
        payload.message_id,
        "770e8400-e29b-41d4-a716-446655440002", // TODO: Map deviceId to vehicleId
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
          address: `Lat: ${location.latitude.toFixed(6)}, Lon: ${location.longitude.toFixed(6)}`,
        },
        tripId
      );

      logger.info(`Driver check-in processed successfully for ${deviceId}`);

    } catch (error) {
      logger.error('Error handling driver check-in:', error);
    }
  }

  /**
   * Create a new trip when driver checks in
   * @returns tripId if trip was created successfully, undefined otherwise
   */
  private async createTripForCheckIn(deviceId: string, checkInData: any): Promise<string | undefined> {
    try {
      logger.info(`Creating trip for device: ${deviceId}`);

      // TODO: Map deviceId to vehicleId (UUID from API)
      // For now, use deviceId as vehicleId
      const vehicleId = "770e8400-e29b-41d4-a716-446655440002";

      // TODO: Get driverId from driver_license_number
      // For now, use hardcoded UUID
      const driverId = '880e8400-e29b-41d4-a716-446655440001';

      // Convert Unix milliseconds to UTC+7
      const startTimeMs = checkInData.check_in_timestamp + (7 * 60 * 60 * 1000);
      const startTime = new Date(startTimeMs).toISOString();

      // Generate trip number
      const tripNumber = tripService.generateTripNumber(deviceId);

      // Format start address from location
      const startAddress = `Lat: ${checkInData.CheckInLocation.latitude.toFixed(6)}, Lon: ${checkInData.CheckInLocation.longitude.toFixed(6)}`;

      // Create trip request
      const tripRequest = {
        vehicleId: vehicleId,
        driverId: driverId,
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
        socketIOServer.emit('trip:created', {
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
      logger.error('Error creating trip for check-in:', error.message);

      // If error is about ongoing trip, log but don't throw
      if (error.message?.includes('chưa kết thúc')) {
        logger.warn(`Vehicle ${deviceId} has ongoing trip. Check-in recorded but new trip not created.`);
      } else {
        // For other errors, still continue processing (don't block check-in)
        logger.error('Failed to create trip, but check-in was recorded successfully');
      }

      return undefined;
    }
  }

  /**
   * Handle driver check-out confirm request
   * Find latest trip, if no end time, respond with is_confirm = true
   */
  private async handleCheckOutConfirmRequest(deviceId: string, payload: CheckOutConfirmRequestPayload): Promise<void> {
    try {
      logger.info(`Received check-out confirm request from device: ${deviceId}`);

      const requestData = payload.request_data;

      // Validate request data (at least one of driver_image or driver_rfid required)
      if (!requestData.driver_image && !requestData.driver_rfid) {
        logger.warn(`Invalid check-out confirm request from ${deviceId}: missing driver_image or driver_rfid`);
        await this.publishCheckOutConfirmResponse(deviceId, payload.message_id, false);
        return;
      }

      // Get latest trip for vehicle
      // TODO: Map deviceId to vehicleId (UUID from API)
      const vehicleId = "770e8400-e29b-41d4-a716-446655440002";
      const latestTrip = await tripService.getLatestTrip(vehicleId);

      // Check if trip exists and has no end time
      const isConfirm = latestTrip !== null && !latestTrip.endTime;

      if (isConfirm) {
        logger.info(`Ongoing trip found for ${deviceId}: ${latestTrip!.id}. Confirming check-out.`);
      } else if (latestTrip === null) {
        logger.warn(`No trip found for ${deviceId}. Cannot confirm check-out.`);
      } else {
        logger.warn(`Latest trip for ${deviceId} already has end time. Cannot confirm check-out.`);
      }

      // Publish confirmation response
      await this.publishCheckOutConfirmResponse(deviceId, payload.message_id, isConfirm);

      // Emit to Socket.IO
      socketIOServer.emit('checkout:confirm:request', {
        device_id: deviceId,
        message_id: payload.message_id,
        is_confirm: isConfirm,
        has_trip: latestTrip !== null,
        trip_id: latestTrip?.id,
        time_stamp: payload.time_stamp,
      });

    } catch (error) {
      logger.error('Error handling check-out confirm request:', error);
      // On error, respond with is_confirm = false
      await this.publishCheckOutConfirmResponse(deviceId, payload.message_id, false);
    }
  }

  /**
   * Publish check-out confirm response to MQTT
   */
  private async publishCheckOutConfirmResponse(deviceId: string, requestMessageId: string, isConfirm: boolean): Promise<void> {
    try {
      if (!this.client) {
        logger.error('MQTT client not connected');
        return;
      }

      const responseTopic = config.mqtt.topics.checkoutConfirmResponse.replace('+', deviceId);

      // Convert to UTC+7 milliseconds
      const utc7Ms = Date.now() + (7 * 60 * 60 * 1000);

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
            logger.error(`Error publishing check-out confirm response to ${responseTopic}:`, err);
          } else {
            logger.info(`Check-out confirm response sent to ${deviceId}: is_confirm=${isConfirm}`);
          }
        }
      );

    } catch (error) {
      logger.error('Error publishing check-out confirm response:', error);
    }
  }

  /**
   * Handle driver check-out
   * Update the latest trip with end time and duration
   */
  private async handleDriverCheckOut(deviceId: string, payload: DriverCheckOutPayload): Promise<void> {
    try {
      logger.info(`Received driver check-out from device: ${deviceId}`);

      const checkOutData = payload.check_out_data;
      const driverInfo = checkOutData.driver_information;
      const location = checkOutData.CheckOutLocation;

      logger.info(`Driver: ${driverInfo.driver_name} (${driverInfo.driver_license_number})`);

      // Convert Unix milliseconds to UTC+7
      const checkOutTimestampMs = checkOutData.check_out_timestamp + (7 * 60 * 60 * 1000);
      logger.info(`Check-out time: ${new Date(checkOutTimestampMs).toISOString()}`);
      logger.info(`Working duration: ${checkOutData.working_duration} minutes`);
      logger.info(`Location: ${location.latitude}, ${location.longitude}`);

      // Stream to Socket.IO for real-time monitoring
      socketIOServer.emit('driver:checkout', {
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
      socketIOServer.to(`device:${deviceId}`).emit('device:checkout', {
        device_id: deviceId,
        ...payload,
      });

      // Update latest trip with check-out data
      const tripId = await this.updateTripWithCheckOut(deviceId, checkOutData);

      // Log check-out event
      await eventLogService.logCheckOutEvent(
        payload.message_id,
        "770e8400-e29b-41d4-a716-446655440002", // TODO: Map deviceId to vehicleId
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
          address: `Lat: ${location.latitude.toFixed(6)}, Lon: ${location.longitude.toFixed(6)}`,
        },
        tripId
      );

      logger.info(`Driver check-out processed successfully for ${deviceId}`);

    } catch (error) {
      logger.error('Error handling driver check-out:', error);
    }
  }

  /**
   * Update the latest trip with check-out data
   * @returns tripId if trip was updated successfully, undefined otherwise
   */
  private async updateTripWithCheckOut(deviceId: string, checkOutData: any): Promise<string | undefined> {
    try {
      logger.info(`Updating trip for device: ${deviceId} with check-out data`);

      // TODO: Map deviceId to vehicleId (UUID from API)
      const vehicleId = "770e8400-e29b-41d4-a716-446655440002";

      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(vehicleId);

      if (!latestTrip) {
        logger.warn(`No trip found for vehicle ${deviceId}. Cannot update with check-out data.`);
        return undefined;
      }

      if (latestTrip.endTime) {
        logger.warn(`Latest trip ${latestTrip.id} already has end time. Cannot update with check-out data.`);
        return latestTrip.id;
      }

      // Convert Unix milliseconds to UTC+7
      const endTimeMs = checkOutData.check_out_timestamp + (7 * 60 * 60 * 1000);
      const endTime = new Date(endTimeMs).toISOString();

      // Format end address from location
      const endAddress = `Lat: ${checkOutData.CheckOutLocation.latitude.toFixed(6)}, Lon: ${checkOutData.CheckOutLocation.longitude.toFixed(6)}`;

      // Update trip with check-out data
      const updatedTrip = await tripService.updateTripCheckOut(latestTrip.id, {
        startTime: latestTrip.startTime, // Required by API
        endTime: endTime,
        endAddress: endAddress,
        durationMinutes: checkOutData.working_duration,
        status: 'Completed',
        notes: "note",
      });
      // const updatedTrip = await tripService.endDrivingSession(vehicleId);

      if (updatedTrip) {
        logger.info(` Trip ${latestTrip.id} updated successfully with check-out data`);

        // Emit trip completion event via Socket.IO
        socketIOServer.emit('trip:completed', {
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

      return latestTrip.id;

    } catch (error: any) {
      logger.error('Error updating trip with check-out:', {
        message: error.message,
        stack: error.stack,
      });
      return undefined;
    }
  }

  /**
   * Handle parking state messages
   */
  private async handleParkingState(deviceId: string, payload: ParkingStateEvent): Promise<void> {
    try {
      logger.info(`Received parking state from device: ${deviceId}`);
      logger.info(`Parking ID: ${payload.parking_id}, State: ${payload.parking_status === 0 ? 'PARKED' : 'MOVING'}, Duration: ${payload.parking_duration} seconds`);

      // TODO: Map deviceId to vehicleId (UUID from API)
      const vehicleId = "770e8400-e29b-41d4-a716-446655440002";

      // get latest trip
      const latestTrip = await tripService.getLatestTrip(vehicleId);

      if (!latestTrip) {
        logger.info(`No active trip found for vehicle ${vehicleId}. Cannot update with parking state.`);
        return;
      }

      // Convert Unix milliseconds to UTC+7
      const timestampMs = payload.time_stamp + (7 * 60 * 60 * 1000);
      const timestamp = new Date(timestampMs).toISOString();

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

        // Create parking start event
        const parkingEvent = await eventLogService.logParkingStartEvent(
          payload.message_id,
          vehicleId,
          {
            parkingId: payload.parking_id,
            timestamp: timestamp,
          },
          latestTrip.id
        );

        // Cache the MongoDB event ID for later update
        if (parkingEvent && parkingEvent.id) {
          await redisClient.cacheParkingEventId(payload.parking_id, parkingEvent.id);
          logger.info(`Cached parking event ID: ${parkingEvent.id} for parking ${payload.parking_id}`);
        }

      } else {
        // Vehicle MOVING - Update existing parking event
        logger.info(`Vehicle ${deviceId} resumed movement. Updating parking event.`);

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

        // Update trip status to MOVING
        await tripService.updateTrip(latestTrip.id, {
          startTime: latestTrip.startTime, // Required by API
          status: VehicleState.MOVING,
        });

        // Get the cached parking event MongoDB ID
        const parkingEventId = await redisClient.getParkingEventId(payload.parking_id);

        if (parkingEventId) {
          // Update the parking event with end time and duration
          await eventLogService.updateParkingEndEvent(
            parkingEventId,
            {
              parkingDuration: payload.parking_duration,
              endTime: timestamp,
            }
          );

          // Delete the cached event ID
          await redisClient.deleteParkingEventId(payload.parking_id);
          logger.info(`Updated and cleaned up parking event: ${parkingEventId}`);
        } else {
          logger.warn(`No cached parking event ID found for parking ${payload.parking_id}. Cannot update event.`);
        }
      }

      // Count total parking events in this session
      const parkingCount = await eventLogService.countParkingEventsBySession(latestTrip.id);

      // Stream to Socket.IO for real-time monitoring
      socketIOServer.emit('parking:state', {
        device_id: deviceId,
        parking_id: payload.parking_id,
        parking_state: payload.parking_status,
        parking_duration: payload.parking_duration,
        parking_count: parkingCount,
        trip_id: latestTrip.id,
        trip_number: latestTrip.tripNumber,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      logger.info(`Parking state processed successfully for ${deviceId}. Total parking events in session: ${parkingCount}`);

    } catch (error) {
      logger.error('Error handling parking state:', error);
    }
  }

  /**
   * Handle continuous driving time messages
   */
  private async handleContinuousDrivingTime(deviceId: string, payload: DrivingTimeEvent): Promise<void> {
    try {
      logger.info(`Received continuous driving time from device: ${deviceId}`);
      logger.info(`Continuous driving time: ${payload.continuous_driving_time} seconds, Total driving duration: ${payload.driving_duration} seconds`);

      // TODO: Map deviceId to vehicleId (UUID from API)
      const vehicleId = "770e8400-e29b-41d4-a716-446655440002";

      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(vehicleId);

      if (!latestTrip) {
        logger.info(`No active trip found for vehicle ${vehicleId}. Cannot update with continuous driving time.`);
        return;
      }

      // Update trip with continuous driving time and total duration
      await tripService.updateTrip(latestTrip.id, {
        startTime: latestTrip.startTime, // Required by API
        continuousDrivingDurationSeconds: payload.continuous_driving_time,
        durationSeconds: payload.driving_duration,
      });

      logger.info(`Trip ${latestTrip.id} updated with continuous driving time: ${payload.continuous_driving_time}s`);

      // Stream to Socket.IO for real-time monitoring
      socketIOServer.emit('driving:time', {
        device_id: deviceId,
        continuous_driving_time: payload.continuous_driving_time,
        driving_duration: payload.driving_duration,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
        trip_id: latestTrip.id,
        trip_number: latestTrip.tripNumber,
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit('device:driving:time', {
        device_id: deviceId,
        ...payload,
        trip_id: latestTrip.id,
      });

      logger.info(`Continuous driving time processed successfully for ${deviceId}`);

    } catch (error) {
      logger.error('Error handling continuous driving time:', error);
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
      logger.error('Error caching event:', error);
    }
  }

  /**
   * Stream event to dashboard via Socket.IO
   */
  private streamEvent(event: EdgeEvent): void {
    try {
      // Broadcast to all connected clients
      socketIOServer.emit('edge:event', event);

      // Emit to room for specific device
      socketIOServer.to(`device:${event.device_id}`).emit('edge:device:event', event);
    } catch (error) {
      logger.error('Error streaming event:', error);
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
      logger.error('Error flushing batch to database:', error);
      // Optionally: implement retry logic or dead-letter queue
    }
  }

  /**
   * Disconnect MQTT client
   */
  disconnect(): void {
    if (this.client) {
      this.flushBatch(); // Flush remaining events
      this.client.end();
      logger.info('MQTT client disconnected');
    }
  }
}

export const mqttService = new MQTTService();
