import mqtt, { MqttClient } from 'mqtt';
import { config } from '../config';
import { logger } from '../utils/logger';
import { EdgeEvent, GPSDataPayload, GPSDataPoint, DriverRequestPayload, DriverInfoPayload } from '../types';
import { redisClient } from './redis';
import { timescaleDB } from './timescaledb';
import { socketIOServer } from '../server/socketio';

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
      logger.debug(`Driver RFID: ${payload.request_data.driver_rfid}`);

      const driverInfo: DriverInfoPayload = {
        time_stamp: Math.floor(Date.now() / 1000),
        message_id: payload.message_id,
        driver_information: {
          driver_information: {
            driver_name: 'Jane Doe',
            driver_license_number: 'DL123456789',
          },
        },
      };

      await this.publishDriverInfo(deviceId, driverInfo);

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
