import dotenv from 'dotenv';

dotenv.config();

export const config = {
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    topics: {
      gpsData: process.env.MQTT_TOPIC_GPS || 'fms/+/operation_monitoring/gps_data',
      driverRequest: process.env.MQTT_TOPIC_DRIVER_REQUEST || 'fms/+/driving_session/driver_request',
    },
    clientId: `mqtt_service_${Math.random().toString(16).slice(3)}`,
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    ttl: parseInt(process.env.REDIS_TTL || '3600'),
  },
  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'fleet_telemetry',
    user: process.env.POSTGRES_USER || 'fleet',
    password: process.env.POSTGRES_PASSWORD || '098poiA#',
  },
  socketio: {
    port: parseInt(process.env.SOCKETIO_PORT || '3000'),
    corsOrigin: process.env.SOCKETIO_CORS_ORIGIN || 'http://localhost:5173',
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};
