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
      driverCheckIn: process.env.MQTT_TOPIC_DRIVER_CHECKIN || 'fms/+/driving_session/driver_checkin',
      checkoutConfirmRequest: process.env.MQTT_TOPIC_CHECKOUT_CONFIRM_REQUEST || 'fms/+/driving_session/driver_checkout_confirm_request',
      checkoutConfirmResponse: process.env.MQTT_TOPIC_CHECKOUT_CONFIRM_RESPONSE || 'fms/+/driving_session/driver_checkout_confirm_response',
      driverCheckOut: process.env.MQTT_TOPIC_DRIVER_CHECKOUT || 'fms/+/driving_session/driver_checkout',
      parkingState: process.env.MQTT_TOPIC_PARKING_STATE || 'fms/+/driving_session/parking_state',
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
  api: {
    baseUrl: process.env.API_BASE_URL || 'http://103.216.116.186:8086',
  },
};
