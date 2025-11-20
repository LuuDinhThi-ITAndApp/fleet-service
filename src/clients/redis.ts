import { createClient } from 'redis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { EdgeEvent, CachedDeviceState } from '../types';

class RedisClient {
  private client: ReturnType<typeof createClient>;
  private isConnected = false;

  constructor() {
    // Try URL format first if password contains special characters
    let clientConfig;

    if (config.redis.password) {
      // Use URL format for better special character handling
      const redisUrl = `redis://:${encodeURIComponent(config.redis.password)}@${config.redis.host}:${config.redis.port}`;
      logger.info(`Connecting to Redis at ${config.redis.host}:${config.redis.port}`);
      clientConfig = { url: redisUrl };
    } else {
      clientConfig = {
        socket: {
          host: config.redis.host,
          port: config.redis.port,
        },
      };
    }

    this.client = createClient(clientConfig);

    this.client.on('error', (err) => {
      logger.error('Redis Client Error', err);
    });

    this.client.on('connect', () => {
      logger.info('Redis connected');
      this.isConnected = true;
    });

    this.client.on('disconnect', () => {
      logger.warn('Redis disconnected');
      this.isConnected = false;
    });
  }

  async connect(): Promise<void> {
    if (!this.isConnected) {
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.isConnected) {
      await this.client.quit();
    }
  }

  /**
   * Cache device state by device_id
   */
  async cacheDeviceState(deviceId: string, event: EdgeEvent): Promise<void> {
    try {
      const key = `device:${deviceId}`;
      const state: CachedDeviceState = {
        device_id: deviceId,
        last_seen: new Date(),
        last_event: event,
        status: 'online',
      };

      await this.client.setEx(
        key,
        config.redis.ttl,
        JSON.stringify(state)
      );

      logger.debug(`Cached device state: ${deviceId}`);
    } catch (error) {
      logger.error('Error caching device state:', error);
      throw error;
    }
  }

  /**
   * Get cached device state
   */
  async getDeviceState(deviceId: string): Promise<CachedDeviceState | null> {
    try {
      const key = `device:${deviceId}`;
      const data = await this.client.get(key);

      if (!data) {
        return null;
      }

      return JSON.parse(data);
    } catch (error) {
      logger.error('Error getting device state:', error);
      return null;
    }
  }

  /**
   * Get all cached devices
   */
  async getAllDevices(): Promise<CachedDeviceState[]> {
    try {
      const keys = await this.client.keys('device:*');
      const devices: CachedDeviceState[] = [];

      for (const key of keys) {
        const data = await this.client.get(key);
        if (data) {
          devices.push(JSON.parse(data));
        }
      }

      return devices;
    } catch (error) {
      logger.error('Error getting all devices:', error);
      return [];
    }
  }

  /**
   * Cache latest event for quick access
   */
  async cacheLatestEvent(event: EdgeEvent): Promise<void> {
    try {
      await this.client.lPush('latest_events', JSON.stringify(event));
      await this.client.lTrim('latest_events', 0, 99); // Keep last 100 events
    } catch (error) {
      logger.error('Error caching latest event:', error);
    }
  }

  /**
   * Cache GPS data by device_id
   */
  async cacheGPSData(deviceId: string, data: any, ttl: number): Promise<void> {
    try {
      const key = `gps:${deviceId}:latest`;
      await this.client.setEx(
        key,
        ttl,
        JSON.stringify(data)
      );

      logger.debug(`Cached GPS data: ${deviceId}`);
    } catch (error) {
      logger.error('Error caching GPS data:', error);
      throw error;
    }
  }

  /**
   * Cache parking event MongoDB ID when vehicle parks
   * @param parkingId - The parking ID from MQTT message
   * @param mongoId - MongoDB event log ID
   */
  async cacheParkingEventId(parkingId: string, mongoId: string): Promise<void> {
    try {
      const key = `parking:${parkingId}:event_id`;
      // Cache for 24 hours (parking should not last longer than this)
      await this.client.setEx(key, 86400, mongoId);
      logger.debug(`Cached parking event ID: ${parkingId} -> ${mongoId}`);
    } catch (error) {
      logger.error('Error caching parking event ID:', error);
      throw error;
    }
  }

  /**
   * Get cached parking event MongoDB ID
   * @param parkingId - The parking ID from MQTT message
   * @returns MongoDB event log ID or null if not found
   */
  async getParkingEventId(parkingId: string): Promise<string | null> {
    try {
      const key = `parking:${parkingId}:event_id`;
      const mongoId = await this.client.get(key);
      return mongoId;
    } catch (error) {
      logger.error('Error getting parking event ID:', error);
      return null;
    }
  }

  /**
   * Delete cached parking event ID when parking ends
   * @param parkingId - The parking ID from MQTT message
   */
  async deleteParkingEventId(parkingId: string): Promise<void> {
    try {
      const key = `parking:${parkingId}:event_id`;
      await this.client.del(key);
      logger.debug(`Deleted parking event ID: ${parkingId}`);
    } catch (error) {
      logger.error('Error deleting parking event ID:', error);
    }
  }

  /**
   * Cache violation event MongoDB ID when violation occurs
   * @param deviceId - The device ID
   * @param violationType - Type of violation (CONTINUOUS_DRIVING or PARKING_DURATION)
   * @param mongoId - MongoDB event log ID
   */
  async cacheViolationEventId(deviceId: string, violationType: 'CONTINUOUS_DRIVING' | 'PARKING_DURATION', mongoId: string): Promise<void> {
    try {
      const key = `violation:${deviceId}:${violationType}:event_id`;
      // Cache for 24 hours
      await this.client.setEx(key, 86400, mongoId);
      logger.debug(`Cached violation event ID: ${deviceId}:${violationType} -> ${mongoId}`);
    } catch (error) {
      logger.error('Error caching violation event ID:', error);
      throw error;
    }
  }

  /**
   * Get cached violation event MongoDB ID
   * @param deviceId - The device ID
   * @param violationType - Type of violation (CONTINUOUS_DRIVING or PARKING_DURATION)
   * @returns MongoDB event log ID or null if not found
   */
  async getViolationEventId(deviceId: string, violationType: 'CONTINUOUS_DRIVING' | 'PARKING_DURATION'): Promise<string | null> {
    try {
      const key = `violation:${deviceId}:${violationType}:event_id`;
      const mongoId = await this.client.get(key);
      return mongoId;
    } catch (error) {
      logger.error('Error getting violation event ID:', error);
      return null;
    }
  }

  /**
   * Delete cached violation event ID
   * @param deviceId - The device ID
   * @param violationType - Type of violation (CONTINUOUS_DRIVING or PARKING_DURATION)
   */
  async deleteViolationEventId(deviceId: string, violationType: 'CONTINUOUS_DRIVING' | 'PARKING_DURATION'): Promise<void> {
    try {
      const key = `violation:${deviceId}:${violationType}:event_id`;
      await this.client.del(key);
      logger.debug(`Deleted violation event ID: ${deviceId}:${violationType}`);
    } catch (error) {
      logger.error('Error deleting violation event ID:', error);
    }
  }


    /**
     * Get latest GPS data from Redis cache for a device
     */
    async getGPSData(deviceId: string): Promise<any | null> {
      try {
        const key = `gps:${deviceId}:latest`;
        const data = await this.client.get(key);
        if (data) {
          return typeof data === 'string' ? JSON.parse(data) : data;
        }
        return null;
      } catch (error) {
        logger.error(`Error getting GPS data from Redis for ${deviceId}:`, error);
        return null;
      }
    }
}

export const redisClient = new RedisClient();
