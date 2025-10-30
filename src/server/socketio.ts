import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { config } from '../config';
import { logger } from '../utils/logger';
import { redisClient } from '../clients/redis';
import { timescaleDB } from '../clients/timescaledb';

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
        origin: config.socketio.corsOrigin,
        methods: ['GET', 'POST'],
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
