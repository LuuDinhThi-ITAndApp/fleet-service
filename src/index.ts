import { logger } from './utils/logger';
import { redisClient } from './clients/redis';
import { timescaleDB } from './clients/timescaledb';
import { mqttService } from './clients/mqtt';
import { socketIOServer } from './server/socketio';

/**
 * Initialize all services
 */
async function initialize() {
  try {
    logger.info('Starting MQTT Edge Service...');

    // Initialize Redis
    logger.info('Connecting to Redis...');
    await redisClient.connect();

    // Initialize TimescaleDB
    logger.info('Initializing TimescaleDB...');
    // await timescaleDB.initialize();

    // Start Socket.IO server
    logger.info('Starting Socket.IO server...');
    socketIOServer.start();

    // Connect to MQTT broker
    logger.info('Connecting to MQTT broker...');
    mqttService.connect();

    logger.info('✅ All services started successfully');
  } catch (error) {
    logger.error('Failed to initialize services:', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  logger.info('Shutting down gracefully...');

  try {
    // Disconnect MQTT
    mqttService.disconnect();

    // Stop Socket.IO server
    await socketIOServer.stop();

    // Close Redis connection
    await redisClient.disconnect();

    // Close TimescaleDB connection
    await timescaleDB.close();

    logger.info('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Handle process signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown();
});

// Start the application
initialize();
