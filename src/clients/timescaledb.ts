import { Pool, PoolClient } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';
import { EdgeEvent, DatabaseRow, GPSDataPayload, GPSDataRow } from '../types';

class TimescaleDBClient {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client', err);
    });
  }

  /**
   * Initialize database schema
   */
  async initialize(): Promise<void> {
    const client = await this.pool.connect();

    try {
      // Create events table
      await client.query(`
        CREATE TABLE IF NOT EXISTS edge_events (
          id BIGSERIAL,
          device_id VARCHAR(255) NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          event_type VARCHAR(100) NOT NULL,
          data JSONB,
          metadata JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (id, timestamp)
        );
      `);

      // Convert to hypertable (TimescaleDB)
      await client.query(`
        SELECT create_hypertable('edge_events', 'timestamp',
          if_not_exists => TRUE,
          chunk_time_interval => INTERVAL '1 day'
        );
      `);

      // Create indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_edge_events_device_id
        ON edge_events (device_id, timestamp DESC);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_edge_events_event_type
        ON edge_events (event_type, timestamp DESC);
      `);

      // Create GPS data table
      await client.query(`
        CREATE TABLE IF NOT EXISTS gps_data (
          id BIGSERIAL,
          device_id VARCHAR(255) NOT NULL,
          message_id VARCHAR(255) NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          gps_timestamp TIMESTAMPTZ NOT NULL,
          latitude DOUBLE PRECISION NOT NULL,
          longitude DOUBLE PRECISION NOT NULL,
          accuracy DOUBLE PRECISION,
          gnss_status BOOLEAN,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (id, timestamp)
        );
      `);

      // Convert GPS data to hypertable (TimescaleDB)
      await client.query(`
        SELECT create_hypertable('gps_data', 'timestamp',
          if_not_exists => TRUE,
          chunk_time_interval => INTERVAL '1 day'
        );
      `);

      // Create GPS indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_gps_data_device_id
        ON gps_data (device_id, timestamp DESC);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_gps_data_message_id
        ON gps_data (message_id);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_gps_data_location
        ON gps_data (latitude, longitude);
      `);

      logger.info('TimescaleDB schema initialized');
    } catch (error) {
      logger.error('Error initializing database:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Insert single event
   */
  async insertEvent(event: EdgeEvent): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query(
        `INSERT INTO edge_events 
         (device_id, timestamp, event_type, data, metadata) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          event.device_id,
          event.timestamp,
          event.event_type,
          JSON.stringify(event.data),
          JSON.stringify(event.metadata || {}),
        ]
      );

      logger.debug(`Inserted event for device: ${event.device_id}`);
    } catch (error) {
      logger.error('Error inserting event:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Batch insert events (more efficient for high throughput)
   */
  async insertEventsBatch(events: EdgeEvent[]): Promise<void> {
    if (events.length === 0) return;

    const client = await this.pool.connect();

    try {
      const values = events.map((event, index) => {
        const offset = index * 5;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
      }).join(',');

      const params = events.flatMap((event) => [
        event.device_id,
        event.timestamp,
        event.event_type,
        JSON.stringify(event.data),
        JSON.stringify(event.metadata || {}),
      ]);

      await client.query(
        `INSERT INTO edge_events 
         (device_id, timestamp, event_type, data, metadata) 
         VALUES ${values}`,
        params
      );

      logger.debug(`Batch inserted ${events.length} events`);
    } catch (error) {
      logger.error('Error batch inserting events:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get recent events for a device
   */
  async getDeviceEvents(deviceId: string, limit: number = 100): Promise<DatabaseRow[]> {
    const client = await this.pool.connect();

    try {
      const result = await client.query(
        `SELECT * FROM edge_events
         WHERE device_id = $1
         ORDER BY timestamp DESC
         LIMIT $2`,
        [deviceId, limit]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting device events:', error);
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Insert GPS data batch
   */
  async insertGPSDataBatch(deviceId: string, payload: GPSDataPayload, trip_id: string | undefined): Promise<void> {
    if (payload.gps_data.length === 0) return;

    const client = await this.pool.connect();

    try {
      const values = payload.gps_data.map((_, index) => {
        const offset = index * 7;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
      }).join(',');

      const params = payload.gps_data.flatMap((gpsPoint) => {
        // Convert Unix milliseconds to UTC+7 - use gpsPoint.gps_timestamp not payload.time_stamp
        const utc7Ms = gpsPoint.gps_timestamp + (7 * 60 * 60 * 1000);
        const utc7Date = new Date(utc7Ms);

        return [
          deviceId,
          utc7Date,  // Store with Vietnam timezone (+7)
          gpsPoint.latitude,
          gpsPoint.longitude,
          gpsPoint.speed,
          gpsPoint.accuracy,
          trip_id || null,
        ];
      });

      await client.query(
        `INSERT INTO vehicle_telemetry
         (vehicle_id, time, latitude, longitude, vehicle_speed, quality, trip_id)
         VALUES ${values}`,
        params
      );

      logger.debug(`Batch inserted ${payload.gps_data.length} GPS points for device: ${deviceId}`);
    } catch (error) {
      logger.error('Error batch inserting GPS data:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get recent GPS data for a device
   */
  async getDeviceGPSData(deviceId: string, limit: number = 100): Promise<GPSDataRow[]> {
    const client = await this.pool.connect();

    try {
      const result = await client.query(
        `SELECT * FROM gps_data
         WHERE device_id = $1
         ORDER BY timestamp DESC
         LIMIT $2`,
        [deviceId, limit]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting device GPS data:', error);
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Get GPS data within time range
   */
  async getGPSDataByTimeRange(
    deviceId: string,
    startTime: Date,
    endTime: Date
  ): Promise<GPSDataRow[]> {
    const client = await this.pool.connect();

    try {
      const result = await client.query(
        `SELECT * FROM gps_data
         WHERE device_id = $1
         AND timestamp BETWEEN $2 AND $3
         ORDER BY timestamp ASC`,
        [deviceId, startTime, endTime]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting GPS data by time range:', error);
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Close connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
    logger.info('TimescaleDB connection pool closed');
  }
}

export const timescaleDB = new TimescaleDBClient();
