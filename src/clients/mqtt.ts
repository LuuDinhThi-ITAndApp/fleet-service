import mqtt, { MqttClient } from 'mqtt';
import { config } from '../config';
import { logger } from '../utils/logger';
import { EdgeEvent, GPSDataPayload, GPSDataPoint, DriverRequestPayload, DriverInfoPayload, DriverCheckInPayload, CheckOutConfirmRequestPayload, CheckOutConfirmResponsePayload, DriverCheckOutPayload, ParkingStateEvent, DrivingTimeEvent, VehicleOperationManagerEvent } from '../types';
import { GpsPoint, SnapResultData } from '../types/tracking';
import { redisClient } from './redis';
import { timescaleDB } from './timescaledb';
import { socketIOServer } from '../server/socketio';
import { driverService } from '../services/driverService';
import { tripService } from '../services/tripService';
import { eventLogService } from '../services/eventLogService';
import { CacheKeys, VehicleState } from '../utils/constants';
import { osrmClient } from './osrm_client';

class MQTTService {
  private client: MqttClient | null = null;
  private messageBuffer: EdgeEvent[] = [];
  private batchSize = 50;
  private batchTimeout = 5000; // 5 seconds
  private batchTimer: NodeJS.Timeout | null = null;
  private ttlGPSCache = 30; // 30 seconds

  // GPS Buffer for snap-to-road
  private gpsBuffers: Map<string, GPSDataPoint[]> = new Map();
  private gpsBufferSize = 8; // Base buffer size - will be adjusted dynamically based on speed
  private gpsBufferTimeout = 4000; // 4 seconds
  private gpsBufferTimers: Map<string, NodeJS.Timeout> = new Map();
  private minConfidenceThreshold = 0.5; // 50% minimum confidence - more lenient to reduce zigzag from frequent fallback
  private lastStreamedSnappedPoint: Map<string, [number, number]> = new Map(); // Track last streamed point per device

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
      config.mqtt.topics.vehicleOperationManager,
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
      // Check if this is a vehicle operation manager message
      else if (topic.includes('driving_session/vehicle_operation_manager')) {
        await this.handleVehicleOperationManager(deviceId, message as VehicleOperationManagerEvent);
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

      // Add GPS points to buffer
      this.addToGPSBuffer(deviceId, payload.gps_data);

      // Process GPS data in parallel - cache and stream raw data
      await Promise.allSettled([
        this.cacheGPSData(deviceId, payload),
        this.streamRawGPSData(deviceId, payload),
        this.storeGPSData(deviceId, payload),
      ]);

    } catch (error) {
      logger.error('Error handling GPS data:', error);
    }
  }

    /**
   * Add GPS points to buffer for snap-to-road processing
   */
  private addToGPSBuffer(deviceId: string, points: GPSDataPoint[]): void {
    try {
      // Get or create buffer for this device
      let buffer = this.gpsBuffers.get(deviceId);
      if (!buffer) {
        buffer = [];
        this.gpsBuffers.set(deviceId, buffer);
      }

      // Filter out low accuracy points and duplicates
      const filteredPoints = points.filter(point => {
        // Skip low accuracy GPS (accuracy > 50m = unreliable)
        // Reduced from 80m to 50m to be stricter - prevents matching wrong roads
        if (point.accuracy > 50) {
          logger.warn(`Filtering out low accuracy GPS point (${point.accuracy}m) for ${deviceId}`);
          return false;
        }
        
        // Skip only completely stationary points (speed < 0.5 km/h = 0.14 m/s)
        // Reduced threshold to keep more points
        // if (point.speed < 0.14) {
        //   logger.debug(`Skipping stationary point (speed: ${(point.speed * 3.6).toFixed(1)} km/h) for ${deviceId}`);
        //   return false;
        // }
        
        // Check distance from last buffered point - reduced threshold
        // Skip if too close (< 3m) instead of 5m
        if (buffer!.length > 0) {
          const lastPoint = buffer![buffer!.length - 1];
          const latDiff = Math.abs(lastPoint.latitude - point.latitude);
          const lonDiff = Math.abs(lastPoint.longitude - point.longitude);
          
          // Approximate distance check (3m ~ 0.00003 degrees)
          if (latDiff < 0.00003 && lonDiff < 0.00003) {
            logger.debug(`Skipping close point (< 3m from last) for ${deviceId}`);
            return false;
          }
        }
        
        return true;
      });

      if (filteredPoints.length === 0) {
        logger.debug(`All GPS points filtered out for ${deviceId} (stationary/low accuracy/too close)`);
        return;
      }

      // Add filtered points to buffer
      buffer.push(...filteredPoints);

      logger.debug(`GPS buffer for ${deviceId}: ${buffer.length} points (${filteredPoints.length} added, ${points.length - filteredPoints.length} filtered)`);

      // Calculate dynamic buffer size based on current average speed
      const dynamicBufferSize = this.calculateDynamicBufferSize(buffer);

      // Check if we should trigger snap-to-road
      if (buffer.length >= dynamicBufferSize) {
        // Buffer is full, trigger snap immediately
        logger.debug(`Dynamic buffer size reached (${buffer.length}/${dynamicBufferSize}) for ${deviceId}`);
        this.triggerSnapToRoad(deviceId);
      } else {
        // Set/reset timeout for this device
        this.resetGPSBufferTimeout(deviceId);
      }

    } catch (error) {
      logger.error('Error adding to GPS buffer:', error);
    }
  }

  /**
   * Calculate dynamic buffer size based on vehicle speed
   * High speed = need more points for smooth curves
   * Low speed = fewer points needed
   */
  private calculateDynamicBufferSize(buffer: GPSDataPoint[]): number {
    if (buffer.length === 0) {
      return this.gpsBufferSize; // Default 8
    }

    // Calculate average speed from recent points (last 3-5 points)
    const recentPoints = buffer.slice(-Math.min(5, buffer.length));
    const avgSpeed = recentPoints.reduce((sum, p) => sum + p.speed, 0) / recentPoints.length;
    const speedKmh = avgSpeed * 3.6;

    let bufferSize: number;

    if (speedKmh < 10) {
      // Very slow/parking - fewer points needed (6-7 points, increased from 4)
      bufferSize = 6;
    } else if (speedKmh < 30) {
      // City speed - moderate points (8-9 points, increased from 5)
      bufferSize = 8;
    } else if (speedKmh < 60) {
      // Higher city speed - more points for smooth curves (10-11 points, increased from 6)
      bufferSize = 10;
    } else {
      // Highway speed - maximum points for very smooth rendering (12-14 points, increased from 7)
      bufferSize = 14;
    }

    logger.debug(`Dynamic buffer size for speed ${speedKmh.toFixed(1)} km/h: ${bufferSize} points`);
    return bufferSize;
  }

  /**
   * Reset GPS buffer timeout for a device
   */
  private resetGPSBufferTimeout(deviceId: string): void {
    // Clear existing timeout
    const existingTimer = this.gpsBufferTimers.get(deviceId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timeout
    const timer = setTimeout(() => {
      this.triggerSnapToRoad(deviceId);
    }, this.gpsBufferTimeout);

    this.gpsBufferTimers.set(deviceId, timer);
  }

  /**
   * Trigger snap-to-road processing for a device
   */
  private async triggerSnapToRoad(deviceId: string): Promise<void> {
    try {
      const buffer = this.gpsBuffers.get(deviceId);
      if (!buffer || buffer.length < 2) {
        logger.debug(`Not enough GPS points for snapping (${deviceId}): ${buffer?.length || 0}`);
        return;
      }

      // Check if vehicle is stationary/parking - skip snap to avoid clutter
      const isStationary = this.isVehicleStationary(buffer);
      if (isStationary) {
        logger.debug(
          `Vehicle ${deviceId} is stationary/parking - skipping snap-to-road to avoid clutter`
        );
        // Clear buffer since we're not processing
        this.gpsBuffers.set(deviceId, []);
        return;
      }

      logger.info(`Triggering snap-to-road for ${deviceId} with ${buffer.length} points`);

      // Clear timeout
      const timer = this.gpsBufferTimers.get(deviceId);
      if (timer) {
        clearTimeout(timer);
        this.gpsBufferTimers.delete(deviceId);
      }

      // Convert GPSDataPoint to GpsPoint format for OSRM
      const gpsPoints: GpsPoint[] = buffer.map(point => ({
        latitude: point.latitude,
        longitude: point.longitude,
        speed: point.speed,
        accuracy: point.accuracy,
        timestamp: point.gps_timestamp,
      }));

      // Call OSRM snap-to-road
      const snapResult = await osrmClient.snapToRoad(gpsPoints);

      if (snapResult.success && snapResult.geometry) {
        const confidence = snapResult.confidence || 0;
        const snappedCount = snapResult.snappedPointsCount || 0;
        
        logger.info(
          `Snap-to-road success for ${deviceId}: ` +
          `confidence=${(confidence * 100).toFixed(1)}%, ` +
          `${snapResult.originalPointsCount}→${snappedCount} points`
        );

        // Warn if too few snapped points (geometry simplified too much)
        if (snappedCount < snapResult.originalPointsCount / 2) {
          logger.warn(
            `⚠️ OSRM simplified geometry too much for ${deviceId}: ` +
            `${snapResult.originalPointsCount} → ${snappedCount} points. May cause straight lines!`
          );
        }

        // Detect highway/expressway conditions
        const avgSpeed = gpsPoints.reduce((sum, p) => sum + p.speed, 0) / gpsPoints.length;
        const avgAccuracy = gpsPoints.reduce((sum, p) => sum + p.accuracy, 0) / gpsPoints.length;
        const isHighwayCondition = avgSpeed > 60 && avgAccuracy < 20; // Highway: high speed + good GPS accuracy
        
        // Dynamic confidence threshold based on conditions
        let confidenceThreshold = this.minConfidenceThreshold; // Default: 0.5 (50%)
        
        if (isHighwayCondition) {
          // For highway with many lanes, OSRM often gives low confidence due to lane ambiguity
          // But if GPS accuracy is good and path is relatively straight, we can trust the snap
          confidenceThreshold = 0.3; // Reduce to 30% for highway
          logger.debug(
            `🛣️ Highway detected for ${deviceId} (speed: ${avgSpeed.toFixed(1)} km/h, accuracy: ${avgAccuracy.toFixed(1)}m). ` +
            `Using relaxed confidence threshold: ${(confidenceThreshold * 100).toFixed(0)}%`
          );
        }
        
        // Check confidence threshold with dynamic adjustment
        if (confidence < confidenceThreshold) {
          logger.warn(
            `Low confidence (${(confidence * 100).toFixed(1)}%) for ${deviceId} (threshold: ${(confidenceThreshold * 100).toFixed(0)}%). ` +
            `Using raw GPS path instead of unreliable snap result.`
          );
          
          // Stream raw GPS geometry instead of low-confidence snap
          this.streamRawGPSAsPath(deviceId, buffer);
          
          // Clear buffer after using raw path
          this.gpsBuffers.set(deviceId, []);
          return;
        }

        // Additional validation: Check if matched distance is reasonable
        // Calculate approximate straight-line distance between first and last GPS points
        const firstPoint = gpsPoints[0];
        const lastPoint = gpsPoints[gpsPoints.length - 1];
        const latDiff = (lastPoint.latitude - firstPoint.latitude) * 111000; // meters
        const lngDiff = (lastPoint.longitude - firstPoint.longitude) * 111000 * Math.cos(firstPoint.latitude * Math.PI / 180);
        const straightDistance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
        
        const matchedDistance = snapResult.distance || 0;
        
        // Validation 1: If matched distance is more than 3x straight distance, likely matched wrong road
        if (matchedDistance > straightDistance * 3 && straightDistance > 20) {
          logger.warn(
            `⚠️ Suspicious match distance for ${deviceId}: ` +
            `matched=${matchedDistance.toFixed(0)}m vs straight=${straightDistance.toFixed(0)}m. ` +
            `Using raw GPS path instead.`
          );
          
          // Stream raw GPS geometry instead of wrong snap
          this.streamRawGPSAsPath(deviceId, buffer);
          this.gpsBuffers.set(deviceId, []);
          return;
        }

        // Validation 2: Check heading/bearing consistency
        // Calculate raw GPS heading (first to last point)
        const rawHeading = Math.atan2(
          lngDiff,
          latDiff
        ) * 180 / Math.PI;
        
        // Calculate snapped path heading (first to last snapped point)
        const snappedCoords = snapResult.geometry!.coordinates;
        const firstSnapped = snappedCoords[0];
        const lastSnapped = snappedCoords[snappedCoords.length - 1];
        const snappedLatDiff = (lastSnapped[1] - firstSnapped[1]) * 111000;
        const snappedLngDiff = (lastSnapped[0] - firstSnapped[0]) * 111000 * Math.cos(firstSnapped[1] * Math.PI / 180);
        const snappedHeading = Math.atan2(
          snappedLngDiff,
          snappedLatDiff
        ) * 180 / Math.PI;
        
        // Calculate heading difference (normalize to -180 to 180)
        let headingDiff = ((snappedHeading - rawHeading + 540) % 360) - 180;
        headingDiff = Math.abs(headingDiff);
        
        // Dynamic heading threshold based on conditions
        let headingThreshold = 45; // Default: 45 degrees
        
        if (isHighwayCondition && straightDistance > 100) {
          // On long straight highway segments, heading should be very consistent
          // Reduce threshold to detect wrong road matches earlier
          headingThreshold = 30; // 30 degrees for highway
        }
        
        // If heading differs by more than threshold, likely wrong road (parallel/perpendicular road)
        if (headingDiff > headingThreshold && straightDistance > 30) {
          logger.warn(
            `⚠️ Suspicious heading difference for ${deviceId}: ` +
            `raw=${rawHeading.toFixed(0)}°, snapped=${snappedHeading.toFixed(0)}°, diff=${headingDiff.toFixed(0)}° (threshold: ${headingThreshold}°). ` +
            `Possibly matched wrong parallel/perpendicular road - using raw GPS.`
          );
          
          this.streamRawGPSAsPath(deviceId, buffer);
          this.gpsBuffers.set(deviceId, []);
          return;
        }

        // Validation 3: Check path curvature ratio
        // If raw GPS is relatively straight but snapped path is too curved, reject
        const curvatureRatio = matchedDistance / Math.max(straightDistance, 1);
        
        // Dynamic curvature threshold based on conditions
        let curvatureThreshold = 1.3; // Default: 1.3x
        
        if (isHighwayCondition) {
          // Highway roads are generally straighter, allow slightly more tolerance
          // for lane changes and ramp merges
          curvatureThreshold = 1.5; // 1.5x for highway
        }
        
        // For straight segments (straightDistance > 50m), reject if snapped path is too curved
        // This catches cases where OSRM matches to curved/winding parallel road
        if (straightDistance > 50 && curvatureRatio > curvatureThreshold) {
          logger.warn(
            `⚠️ Suspicious curvature for ${deviceId}: ` +
            `straight=${straightDistance.toFixed(0)}m, matched=${matchedDistance.toFixed(0)}m, ` +
            `ratio=${curvatureRatio.toFixed(2)} (threshold: ${curvatureThreshold}). Raw GPS appears straight but snap is too curved - using raw GPS.`
          );
          
          this.streamRawGPSAsPath(deviceId, buffer);
          this.gpsBuffers.set(deviceId, []);
          return;
        }

        // Validation 4: Check perpendicular deviation (NEW - most important!)
        // Calculate average perpendicular distance of raw GPS points from snapped path
        const avgPerpendicularDeviation = this.calculateAveragePerpendicularDeviation(
          gpsPoints,
          snappedCoords
        );
        
        // Dynamic perpendicular deviation threshold based on conditions
        let perpendicularThreshold = 12; // Default: 12m
        
        if (isHighwayCondition) {
          // On highway with multiple lanes, GPS can drift between lanes (each lane ~3.5m wide)
          // Allow larger deviation: up to 20m (about 5-6 lanes)
          perpendicularThreshold = 20;
        }
        
        // Log perpendicular deviation for debugging
        logger.info(
          `📏 Perpendicular deviation for ${deviceId}: ${avgPerpendicularDeviation.toFixed(1)}m ` +
          `(threshold: ${perpendicularThreshold}m, confidence: ${(snapResult.confidence! * 100).toFixed(1)}%, ` +
          `highway: ${isHighwayCondition})`
        );
        
        // If raw GPS points deviate more than threshold perpendicular from snapped path,
        // likely matched to parallel/wrong road
        if (avgPerpendicularDeviation > perpendicularThreshold) {
          logger.warn(
            `⚠️ High perpendicular deviation for ${deviceId}: ` +
            `avgDeviation=${avgPerpendicularDeviation.toFixed(1)}m (threshold: ${perpendicularThreshold}m). ` +
            `Snapped path deviates too far from raw GPS - using raw GPS.`
          );
          
          this.streamRawGPSAsPath(deviceId, buffer);
          this.gpsBuffers.set(deviceId, []);
          return;
        }

        // Good confidence and reasonable distance - stream snapped data to Socket.IO
        this.streamSnappedGPSData(deviceId, {
          originalPoints: buffer,
          snapResult: snapResult,
          timestamp: Date.now(),
        });

        // Clear buffer after successful processing
        this.gpsBuffers.set(deviceId, []);
      } else {
        logger.warn(`Snap-to-road failed for ${deviceId}: ${snapResult.error}`);
        
        // Keep some points for next attempt instead of clearing completely
        if (buffer.length > 10) {
          const keepPoints = buffer.slice(-10);
          this.gpsBuffers.set(deviceId, keepPoints);
          logger.debug(`Kept last 10 points for next snap attempt`);
        } else {
          this.gpsBuffers.set(deviceId, []);
        }
      }

    } catch (error) {
      logger.error('Error in snap-to-road processing:', error);
      // Clear buffer on error
      this.gpsBuffers.set(deviceId, []);
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
        };

        // Emit to channel by device ID
        socketIOServer.emit(deviceId, streamData);

        // Also emit to generic GPS channel for monitoring all devices
        socketIOServer.emit('gps:all', streamData);

        // Emit raw GPS data
        socketIOServer.emit('gps:raw', streamData);
      }
    } catch (error) {
      logger.error('Error streaming raw GPS data:', error);
    }
  }

  /**
   * Stream raw GPS data as path when snap confidence is too low
   * Converts raw GPS points to GeoJSON LineString format like snapped data
   * Applies smoothing to reduce zigzag/jitter
   * Skips if vehicle is stationary/parking (avoid clutter in parking lots)
   */
  private streamRawGPSAsPath(deviceId: string, points: GPSDataPoint[]): void {
    try {
      if (points.length === 0) {
        logger.warn(`No raw GPS points to stream for ${deviceId}`);
        return;
      }

      // Check if vehicle is stationary/parking - don't stream path to avoid clutter
      const isStationary = this.isVehicleStationary(points);
      if (isStationary) {
        logger.debug(
          `Vehicle ${deviceId} is stationary/parking - skipping raw path to avoid clutter in parking lot`
        );
        return;
      }

      // Apply smoothing to raw GPS to reduce zigzag
      const smoothedPoints = this.smoothGPSPoints(points);
      
      // Convert smoothed GPS points to GeoJSON LineString (longitude, latitude format)
      const coordinates = smoothedPoints.map(p => [p.longitude, p.latitude]);
      
      // Calculate total distance between smoothed points
      let totalDistance = 0;
      for (let i = 1; i < smoothedPoints.length; i++) {
        const p1 = smoothedPoints[i - 1];
        const p2 = smoothedPoints[i];
        const latDiff = (p2.latitude - p1.latitude) * 111000;
        const lngDiff = (p2.longitude - p1.longitude) * 111000 * Math.cos(p1.latitude * Math.PI / 180);
        totalDistance += Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
      }

      const streamData = {
        device_id: deviceId,
        timestamp: Date.now(),
        original_points: points,
        snapped_geometry: {
          type: 'LineString',
          coordinates: coordinates
        },
        confidence: 0.0, // 0% confidence to indicate this is raw GPS, not snapped
        distance: totalDistance,
        duration: 0,
        original_count: points.length,
        snapped_count: smoothedPoints.length,
        is_raw_fallback: true, // Flag to indicate this is raw GPS fallback
      };

      // Emit as snapped data (same channel) but with 0% confidence
      socketIOServer.emit('gps:snapped', streamData);
      socketIOServer.emit(`${deviceId}:snapped`, streamData);

      logger.info(
        `Streamed raw GPS as fallback path for ${deviceId}: ${points.length} points, ` +
        `distance=${totalDistance.toFixed(0)}m (confidence=0% - raw GPS)`
      );

    } catch (error) {
      logger.error('Error streaming raw GPS as path:', error);
    }
  }

  /**
   * Check if vehicle is stationary/parking based on GPS points
   * Returns true if vehicle is not moving significantly
   */
  private isVehicleStationary(points: GPSDataPoint[]): boolean {
    if (points.length < 2) {
      return false;
    }

    // Check average speed
    const avgSpeed = points.reduce((sum, p) => sum + p.speed, 0) / points.length;
    const avgSpeedKmh = avgSpeed;

    // Check maximum displacement (bounding box)
    const lats = points.map(p => p.latitude);
    const lngs = points.map(p => p.longitude);
    const latRange = Math.max(...lats) - Math.min(...lats);
    const lngRange = Math.max(...lngs) - Math.min(...lngs);
    const maxDisplacement = Math.max(latRange, lngRange) * 111000; // meters

    // Stationary if:
    // 1. Average speed < 5 km/h AND
    // 2. Max displacement < 20 meters (GPS drift range)
    const isStationary = avgSpeedKmh < 5 && maxDisplacement < 20;

    if (isStationary) {
      logger.debug(
        `Stationary detected: avgSpeed=${avgSpeedKmh.toFixed(1)} km/h, ` +
        `maxDisplacement=${maxDisplacement.toFixed(1)}m`
      );
    }

    return isStationary;
  }

  /**
   * Smooth GPS points using advanced multi-pass filtering to reduce zigzag
   * 1. Remove outliers (sudden jumps)
   * 2. Apply Gaussian smoothing (7-point window) - INCREASED from 5
   * 3. Second pass Gaussian smoothing
   * 4. Douglas-Peucker simplification to remove unnecessary points
   * 5. Kalman-like prediction smoothing
   */
  private smoothGPSPoints(points: GPSDataPoint[]): GPSDataPoint[] {
    if (points.length <= 2) {
      return points; // Not enough points to smooth
    }

    // Step 1: Remove outliers - points that jump too far from trajectory
    const filtered = this.removeGPSOutliers(points);
    
    if (filtered.length <= 2) {
      return filtered;
    }

    // Step 2: First pass - Gaussian smoothing with 7-point window (upgraded from 5)
    let smoothed = this.applyGaussianSmooth7Point(filtered);
    
    // Step 3: Second pass - Gaussian smoothing again for extra smoothness
    if (smoothed.length > 6) {
      smoothed = this.applyGaussianSmooth7Point(smoothed);
    }

    // Step 4: Douglas-Peucker simplification - remove points that don't add curvature
    smoothed = this.douglasPeuckerSimplify(smoothed, 3); // 3 meter tolerance

    // Step 5: Kalman-like prediction smoothing for final polish
    smoothed = this.applyPredictiveSmoothing(smoothed);

    logger.debug(
      `Smoothed GPS: ${points.length} → ${filtered.length} (outliers) → ${smoothed.length} (final)`
    );
    
    return smoothed;
  }

  /**
   * Remove GPS outliers - points that deviate too much from expected trajectory
   */
  private removeGPSOutliers(points: GPSDataPoint[]): GPSDataPoint[] {
    if (points.length <= 2) {
      return points;
    }

    const result: GPSDataPoint[] = [points[0]]; // Keep first point

    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];

      // Calculate distances
      const distToPrev = this.calculateDistance(prev, curr);
      const distToNext = this.calculateDistance(curr, next);
      const prevToNext = this.calculateDistance(prev, next);

      // Check if current point creates sharp angle (outlier)
      // If distance(prev->curr->next) >> distance(prev->next), curr is likely outlier
      const detourRatio = (distToPrev + distToNext) / Math.max(prevToNext, 1);

      // If detour ratio > 2.5, this point is likely GPS spike/outlier
      if (detourRatio < 2.5) {
        result.push(curr);
      } else {
        logger.debug(`Removed GPS outlier: detour ratio ${detourRatio.toFixed(2)}`);
      }
    }

    result.push(points[points.length - 1]); // Keep last point
    return result;
  }

  /**
   * Apply Gaussian smoothing with 7-point window (UPGRADED from 5-point)
   * Gaussian weights: [0.03, 0.11, 0.22, 0.28, 0.22, 0.11, 0.03]
   * Stronger smoothing to eliminate zigzag
   */
  private applyGaussianSmooth7Point(points: GPSDataPoint[]): GPSDataPoint[] {
    if (points.length <= 6) {
      return points;
    }

    const smoothed: GPSDataPoint[] = [];
    
    // Keep first 3 points
    smoothed.push(points[0]);
    smoothed.push(points[1]);
    smoothed.push(points[2]);

    // Gaussian weights for 7-point window (sigma = 1.2)
    const weights = [0.03, 0.11, 0.22, 0.28, 0.22, 0.11, 0.03];

    // Apply Gaussian smoothing for middle points
    for (let i = 3; i < points.length - 3; i++) {
      let lat = 0;
      let lng = 0;

      // 7-point weighted average
      for (let j = -3; j <= 3; j++) {
        const point = points[i + j];
        const weight = weights[j + 3];
        lat += point.latitude * weight;
        lng += point.longitude * weight;
      }

      smoothed.push({
        ...points[i],
        latitude: lat,
        longitude: lng
      });
    }

    // Keep last 3 points
    smoothed.push(points[points.length - 3]);
    smoothed.push(points[points.length - 2]);
    smoothed.push(points[points.length - 1]);

    return smoothed;
  }

  /**
   * Douglas-Peucker algorithm to simplify path by removing unnecessary points
   * Keeps only points that contribute to the shape (reduce zigzag)
   */
  private douglasPeuckerSimplify(points: GPSDataPoint[], tolerance: number): GPSDataPoint[] {
    if (points.length <= 2) {
      return points;
    }

    // Find point with maximum distance from line (first to last)
    let maxDistance = 0;
    let maxIndex = 0;
    const first = points[0];
    const last = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
      const distance = this.perpendicularDistance(points[i], first, last);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }

    // If max distance is greater than tolerance, recursively simplify
    if (maxDistance > tolerance) {
      // Recursive call for both segments
      const left = this.douglasPeuckerSimplify(points.slice(0, maxIndex + 1), tolerance);
      const right = this.douglasPeuckerSimplify(points.slice(maxIndex), tolerance);
      
      // Combine results (remove duplicate middle point)
      return [...left.slice(0, -1), ...right];
    } else {
      // If all points are within tolerance, just keep first and last
      return [first, last];
    }
  }

  /**
   * Calculate perpendicular distance from point to line segment
   */
  private perpendicularDistance(point: GPSDataPoint, lineStart: GPSDataPoint, lineEnd: GPSDataPoint): number {
    const x0 = point.latitude;
    const y0 = point.longitude;
    const x1 = lineStart.latitude;
    const y1 = lineStart.longitude;
    const x2 = lineEnd.latitude;
    const y2 = lineEnd.longitude;

    const numerator = Math.abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1);
    const denominator = Math.sqrt(Math.pow(y2 - y1, 2) + Math.pow(x2 - x1, 2));
    
    return (numerator / denominator) * 111000; // Convert to meters
  }

  /**
   * Apply predictive smoothing (Kalman-like filter)
   * Uses velocity and heading to predict next position, then blend with actual
   */
  private applyPredictiveSmoothing(points: GPSDataPoint[]): GPSDataPoint[] {
    if (points.length <= 2) {
      return points;
    }

    const smoothed: GPSDataPoint[] = [points[0]]; // Keep first point

    for (let i = 1; i < points.length; i++) {
      const prev = smoothed[i - 1];
      const curr = points[i];

      if (i === 1) {
        // No prediction for second point
        smoothed.push(curr);
        continue;
      }

      // Calculate velocity from previous smoothed points
      const prevPrev = smoothed[i - 2];
      const latVelocity = prev.latitude - prevPrev.latitude;
      const lngVelocity = prev.longitude - prevPrev.longitude;

      // Predict next position based on velocity
      const predictedLat = prev.latitude + latVelocity;
      const predictedLng = prev.longitude + lngVelocity;

      // Blend prediction with actual measurement (70% prediction, 30% actual)
      // This smooths out sudden direction changes
      const blendedLat = predictedLat * 0.7 + curr.latitude * 0.3;
      const blendedLng = predictedLng * 0.7 + curr.longitude * 0.3;

      smoothed.push({
        ...curr,
        latitude: blendedLat,
        longitude: blendedLng
      });
    }

    return smoothed;
  }

  /**
   * Apply Gaussian smoothing with 5-point window (LEGACY - keeping for backward compatibility)
   * Gaussian weights: [0.06, 0.24, 0.40, 0.24, 0.06]
   */
  private applyGaussianSmooth(points: GPSDataPoint[]): GPSDataPoint[] {
    if (points.length <= 4) {
      return points;
    }

    const smoothed: GPSDataPoint[] = [];
    
    // Keep first 2 points
    smoothed.push(points[0]);
    smoothed.push(points[1]);

    // Gaussian weights for 5-point window (sigma = 1.0)
    const weights = [0.06, 0.24, 0.40, 0.24, 0.06];

    // Apply Gaussian smoothing for middle points
    for (let i = 2; i < points.length - 2; i++) {
      let lat = 0;
      let lng = 0;

      // 5-point weighted average
      for (let j = -2; j <= 2; j++) {
        const point = points[i + j];
        const weight = weights[j + 2];
        lat += point.latitude * weight;
        lng += point.longitude * weight;
      }

      smoothed.push({
        ...points[i],
        latitude: lat,
        longitude: lng
      });
    }

    // Keep last 2 points
    smoothed.push(points[points.length - 2]);
    smoothed.push(points[points.length - 1]);

    return smoothed;
  }

  /**
   * Calculate distance between two GPS points in meters
   */
  private calculateDistance(p1: GPSDataPoint, p2: GPSDataPoint): number {
    const latDiff = (p2.latitude - p1.latitude) * 111000;
    const lngDiff = (p2.longitude - p1.longitude) * 111000 * Math.cos(p1.latitude * Math.PI / 180);
    return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
  }

  /**
   * Calculate average perpendicular deviation of raw GPS points from snapped path
   * This detects when raw GPS is on a different road (e.g., bridge vs ground level)
   */
  private calculateAveragePerpendicularDeviation(
    rawPoints: GpsPoint[],
    snappedCoords: number[][]
  ): number {
    if (rawPoints.length === 0 || snappedCoords.length < 2) {
      return 0;
    }

    let totalDeviation = 0;
    let count = 0;

    // For each raw GPS point, find closest snapped path segment and calculate perpendicular distance
    for (const rawPoint of rawPoints) {
      let minDistance = Infinity;

      // Check distance to each segment of snapped path
      for (let i = 0; i < snappedCoords.length - 1; i++) {
        const segStart = snappedCoords[i];
        const segEnd = snappedCoords[i + 1];

        // Convert to comparable format
        const point = {
          latitude: rawPoint.latitude,
          longitude: rawPoint.longitude,
          speed: 0,
          accuracy: 0,
          gps_timestamp: 0
        };
        const start = {
          latitude: segStart[1],
          longitude: segStart[0],
          speed: 0,
          accuracy: 0,
          gps_timestamp: 0
        };
        const end = {
          latitude: segEnd[1],
          longitude: segEnd[0],
          speed: 0,
          accuracy: 0,
          gps_timestamp: 0
        };

        const distance = this.perpendicularDistanceToSegment(point, start, end);
        minDistance = Math.min(minDistance, distance);
      }

      totalDeviation += minDistance;
      count++;
    }

    return count > 0 ? totalDeviation / count : 0;
  }

  /**
   * Calculate perpendicular distance from point to line segment (not infinite line)
   */
  private perpendicularDistanceToSegment(
    point: GPSDataPoint,
    segStart: GPSDataPoint,
    segEnd: GPSDataPoint
  ): number {
    const x0 = point.latitude;
    const y0 = point.longitude;
    const x1 = segStart.latitude;
    const y1 = segStart.longitude;
    const x2 = segEnd.latitude;
    const y2 = segEnd.longitude;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const segmentLength = Math.sqrt(dx * dx + dy * dy);

    if (segmentLength === 0) {
      // Segment is a point
      return Math.sqrt(Math.pow(x0 - x1, 2) + Math.pow(y0 - y1, 2)) * 111000;
    }

    // Calculate projection of point onto line
    const t = Math.max(0, Math.min(1, ((x0 - x1) * dx + (y0 - y1) * dy) / (segmentLength * segmentLength)));
    
    // Find closest point on segment
    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;

    // Calculate distance
    const latDiff = (x0 - closestX) * 111000;
    const lngDiff = (y0 - closestY) * 111000 * Math.cos(x0 * Math.PI / 180);
    
    return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
  }

  /**
   * Stream snapped GPS data to dashboard via Socket.IO
   * Stream the FULL snapped path geometry to render accurate curves
   */
  private streamSnappedGPSData(
    deviceId: string, 
    data: {
      originalPoints: GPSDataPoint[];
      snapResult: SnapResultData;
      timestamp: number;
    }
  ): void {
    try {
      // Get FULL geometry from OSRM (all matched points)
      const geometry = data.snapResult.geometry;
      if (!geometry || !geometry.coordinates || geometry.coordinates.length === 0) {
        logger.warn(`No geometry to stream for ${deviceId}`);
        return;
      }

      const coordinates = geometry.coordinates; // Use original OSRM coordinates directly

      // Send ALL coordinates from OSRM match, not just the last one
      // This ensures curves, roundabouts, and turns are rendered accurately
      const streamData = {
        device_id: deviceId,
        timestamp: data.timestamp,
        original_points: data.originalPoints,
        snapped_geometry: geometry, // Use original geometry directly
        confidence: data.snapResult.confidence,
        distance: data.snapResult.distance,
        duration: data.snapResult.duration,
        original_count: data.snapResult.originalPointsCount,
        snapped_count: data.snapResult.snappedPointsCount,
      };

      // Emit snapped GPS data to dashboard
      socketIOServer.emit('gps:snapped', streamData);

      // Also emit to device-specific channel
      socketIOServer.emit(`${deviceId}:snapped`, streamData);

      const confidence = data.snapResult.confidence || 0;
      logger.debug(`Streamed snapped GPS for ${deviceId}: ${coordinates.length} points, confidence=${(confidence * 100).toFixed(1)}%`);

    } catch (error) {
      logger.error('Error streaming snapped GPS data:', error);
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
      // updateTrip automatically preserves all existing fields (fetches existing trip first)
      const updatedTrip = await tripService.updateTrip(latestTrip.id, {
        startTime: latestTrip.startTime, // Required by API
        endTime: endTime,
        endAddress: endAddress,
        durationMinutes: checkOutData.working_duration,
        status: 'Completed',
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
   * Handle vehicle operation manager messages (violations)
   * Each message contains only ONE violation at a time (non-violating values are 0)
   */
  private async handleVehicleOperationManager(deviceId: string, payload: VehicleOperationManagerEvent): Promise<void> {
    try {
      logger.info(`Received vehicle operation manager event from device: ${deviceId}`);

      // TODO: Map deviceId to vehicleId (UUID from API)
      const vehicleId = "770e8400-e29b-41d4-a716-446655440002";

      // Get latest trip
      const latestTrip = await tripService.getLatestTrip(vehicleId);

      if (!latestTrip) {
        logger.info(`No active trip found for vehicle ${vehicleId}. Cannot log violation.`);
        return;
      }

      const timestamp = new Date(payload.time_stamp).toISOString();
      const violations = payload.violation_operation;

      // Determine which violation is active (non-zero value)
      let violationType: 'CONTINUOUS_DRIVING' | 'PARKING_DURATION' | 'SPEED_LIMIT' | null = null;
      let violationValue = 0;
      let violationUnit = '';

      if (violations.continuous_driving_time_violate > 0) {
        violationType = 'CONTINUOUS_DRIVING';
        violationValue = violations.continuous_driving_time_violate;
        violationUnit = 'minutes';
      } else if (violations.parking_duration_violate > 0) {
        violationType = 'PARKING_DURATION';
        violationValue = violations.parking_duration_violate;
        violationUnit = 'minutes';
      } else if (violations.speed_limit_violate > 0) {
        violationType = 'SPEED_LIMIT';
        violationValue = violations.speed_limit_violate;
        violationUnit = 'km/h';
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
        vehicleId,
        {
          timestamp,
          messageId: payload.message_id,
          violationType,
          violationValue,
          violationUnit,
        },
        latestTrip.id
      );

      logger.info(`Violation logged: ${violationType} = ${violationValue} ${violationUnit}`);

      // Count speed violations if this is a speed violation
      let speedViolationCount = 0;
      if (violationType === 'SPEED_LIMIT') {
        speedViolationCount = await eventLogService.countSpeedViolationsBySession(latestTrip.id);
      }

      // Emit to Socket.IO - only the active violation, others are 0
      socketIOServer.emit('violation:detected', {
        device_id: deviceId,
        trip_id: latestTrip.id,
        trip_number: latestTrip.tripNumber,
        violation_type: violationType,
        continuous_driving_time_violate: violations.continuous_driving_time_violate,
        parking_duration_violate: violations.parking_duration_violate,
        speed_limit_violate: violations.speed_limit_violate,
        speed_violation_count: speedViolationCount, // Only count speed violations
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      // Emit to specific device room
      socketIOServer.to(`device:${deviceId}`).emit('device:violation', {
        device_id: deviceId,
        violation_type: violationType,
        violation_value: violationValue,
        violation_unit: violationUnit,
        speed_violation_count: speedViolationCount, // Only count speed violations
        trip_id: latestTrip.id,
        message_id: payload.message_id,
        time_stamp: payload.time_stamp,
      });

      logger.info(`Vehicle operation violation processed successfully for ${deviceId}${violationType === 'SPEED_LIMIT' ? `. Speed violations in session: ${speedViolationCount}` : ''}`);

    } catch (error) {
      logger.error('Error handling vehicle operation manager:', error);
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
      this.client.end();
      this.client = null;
      logger.info('MQTT client disconnected');
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
