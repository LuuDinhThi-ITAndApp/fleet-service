import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { config } from '../config';
import { logger } from '../utils/logger';
import { redisClient } from '../clients/redis';
import { timescaleDB } from '../clients/timescaledb';
import { mqttService } from '../clients/mqtt';

class SocketIOService {
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private io: Server;
  private connectedClients = 0;

  constructor() {
    this.app = express();
    this.httpServer = createServer(this.app);

    this.io = new Server(this.httpServer, {
      cors: {
        origin: '*', // Allow all origins
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    this.setupMiddleware();
    this.setupEventHandlers();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Enable CORS for Express API
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      res.header('Access-Control-Allow-Credentials', 'true');

      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }

      next();
    });

    this.app.use(express.json());

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        connectedClients: this.connectedClients,
      });
    });

    // Get all devices endpoint
    this.app.get('/api/devices', async (req, res) => {
      try {
        const devices = await redisClient.getAllDevices();
        res.json({ devices });
      } catch (error) {
        logger.error('Error fetching devices:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get device history endpoint
    this.app.get('/api/devices/:deviceId/history', async (req, res) => {
      try {
        const { deviceId } = req.params;
        const limit = parseInt(req.query.limit as string) || 100;

        const events = await timescaleDB.getDeviceEvents(deviceId, limit);
        res.json({ events });
      } catch (error) {
        logger.error('Error fetching device history:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Streaming request endpoint
    this.app.post('/api/devices/:deviceId/streaming', async (req, res) => {
      try {
        const { deviceId } = req.params;
        const { streaming_state } = req.body;

        // Validate deviceId
        if (!deviceId || deviceId.trim() === '') {
          return res.status(400).json({
            error: 'Device ID is required',
            success: false
          });
        }

        // Map streaming state to number
        const stateMap: { [key: string]: 0 | 1 | 2 | 3 } = {
          'Oms': 0,
          'Dms': 1,
          'Dash': 2,
          'Off': 3,
          '0': 0,
          '1': 1,
          '2': 2,
          '3': 3
        };

        let stateValue: 0 | 1 | 2 | 3;

        // Accept both string names and numeric values
        if (typeof streaming_state === 'number') {
          if (streaming_state >= 0 && streaming_state <= 3) {
            stateValue = streaming_state as 0 | 1 | 2 | 3;
          } else {
            return res.status(400).json({
              error: 'Invalid streaming_state. Must be 0 (Oms), 1 (Dms), 2 (Dash), or 3 (Off)',
              success: false
            });
          }
        } else if (typeof streaming_state === 'string') {
          const mappedValue = stateMap[streaming_state];
          if (mappedValue === undefined) {
            return res.status(400).json({
              error: 'Invalid streaming_state. Must be one of: Oms (0), Dms (1), Dash (2), Off (3)',
              success: false
            });
          }
          stateValue = mappedValue;
        } else {
          return res.status(400).json({
            error: 'streaming_state is required',
            success: false
          });
        }

        // Publish MQTT message
        const result = await mqttService.publishStreamingRequest(deviceId, stateValue);

        if (result.success) {
          logger.info(`Streaming request sent for device ${deviceId} with state ${stateValue}`);
          res.json({
            success: true,
            message: 'Streaming request published successfully',
            device_id: deviceId,
            streaming_state: stateValue
          });
        } else {
          logger.error(`Failed to publish streaming request for device ${deviceId}:`, result.error);
          res.status(500).json({
            error: result.error || 'Failed to publish streaming request',
            success: false
          });
        }
      } catch (error) {
        logger.error('Error handling streaming request:', error);
        res.status(500).json({
          error: 'Internal server error',
          success: false
        });
      }
    });
  }

  /**
   * Setup Socket.IO event handlers
   */
  private setupEventHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      this.connectedClients++;
      logger.info(`Client connected: ${socket.id} (Total: ${this.connectedClients})`);

      // Send initial data on connection
      this.handleInitialConnection(socket);

      // Handle device subscription
      socket.on('subscribe:device', (deviceId: string) => {
        socket.join(`device:${deviceId}`);
        logger.debug(`Client ${socket.id} subscribed to device: ${deviceId}`);
      });

      // Handle device unsubscription
      socket.on('unsubscribe:device', (deviceId: string) => {
        socket.leave(`device:${deviceId}`);
        logger.debug(`Client ${socket.id} unsubscribed from device: ${deviceId}`);
      });

      // Handle request for device state
      socket.on('get:device:state', async (deviceId: string) => {
        try {
          const state = await redisClient.getDeviceState(deviceId);
          socket.emit('device:state', state);
        } catch (error) {
          logger.error('Error getting device state:', error);
          socket.emit('error', { message: 'Failed to get device state' });
        }
      });

      // Handle disconnect
      socket.on('disconnect', () => {
        this.connectedClients--;
        logger.info(`Client disconnected: ${socket.id} (Total: ${this.connectedClients})`);
      });

      // Handle errors
      socket.on('error', (error) => {
        logger.error(`Socket error for client ${socket.id}:`, error);
      });
    });
  }

  /**
   * Send initial data when client connects
   */
  private async handleInitialConnection(socket: Socket): Promise<void> {
    try {
      // Send all cached devices
      const devices = await redisClient.getAllDevices();
      socket.emit('initial:devices', devices);
    } catch (error) {
      logger.error('Error sending initial data:', error);
    }
  }

  /**
   * Emit event to all connected clients
   */
  emit(event: string, data: any): void {
    this.io.emit(event, data);
  }

  /**
   * Emit event to specific room
   */
  to(room: string) {
    return this.io.to(room);
  }

  /**
   * Start the server
   */
  start(): void {
    this.httpServer.listen(config.socketio.port, () => {
      logger.info(`Socket.IO server listening on port ${config.socketio.port}`);
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.io.close(() => {
        this.httpServer.close(() => {
          logger.info('Socket.IO server stopped');
          resolve();
        });
      });
    });
  }

  /**
   * Get connected clients count
   */
  getConnectedClientsCount(): number {
    return this.connectedClients;
  }
}

export const socketIOServer = new SocketIOService();
