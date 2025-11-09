import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { VehicleState, Severity } from '../utils/constants';

interface Coordinates {
  lat: number;
  lng: number;
}

interface Location {
  type?: string;
  locationId?: string;
  locationName?: string;
  address?: string;
  coordinates?: Coordinates;
  geoHash?: string;
  zone?: string;
  city?: string;
  district?: string;
}

interface CheckInOut {
  type: string;
  checkpoint?: string;
  expectedTime?: string;
  actualTime: string;
  delay?: number;
  reason?: string;
  verifiedBy?: string;
  odometerReading?: number;
  fuelLevel?: number;
  images?: string[];
}

interface Parking {
  parkingId: string;
  parkingLotId?: string;
  parkingLotName?: string;
  slotNumber?: string;
  parkingType?: string;
  startTime?: string;
  endTime?: string;
  duration: number;
  cost?: number;
  status: string;
  violations?: Array<{
    type: string;
    description: string;
    timestamp: string;
  }>;
}

interface Vehicle {
  vehicleId: string;
  licensePlate?: string;
  vehicleType?: string;
  capacity?: number;
  fleetNumber?: string;
}

interface Driver {
  driverId: string;
  name: string;
  phoneNumber?: string;
  licenseNumber: string;
  employeeId?: string;
}

interface EventLogRequest {
  id?: string;
  eventId: string;
  sessionId?: string;
  eventType: string;
  eventSubType?: string;
  vehicle?: Vehicle;
  driver?: Driver;
  order?: any;
  dispatch?: any;
  location?: Location;
  checkInOut?: CheckInOut;
  parking?: Parking;
  status: string;
  severity: string;
  tags?: string[];
  eventTimestamp: string;
  createdAt?: string;
  updatedAt?: string;
  parentEventId?: string;
  relatedEventIds?: string[];
  correlationId?: string;
  metadata?: {
    sessionId?: string;
    weather?: string;
    trafficCondition?: string;
    notes?: string;
    attachments?: string[];
    exceptions?: Array<{
      type: string;
      description: string;
      resolvedBy?: string;
      resolvedAt?: string;
    }>;
  };
}

interface EventLogResponse {
  id: string;
  eventId: string;
  sessionId?: string;
  eventType: string;
  status: string;
  correlationId?: string;
  [key: string]: any;
}

class EventLogService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.api.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Log driver check-in event
   */
  async logCheckInEvent(
    eventId: string,
    vehicleId: string,
    driverInfo: { name: string; licenseNumber: string },
    checkInData: {
      checkInTimestamp: string;
      location: { latitude: number; longitude: number; accuracy: number };
      address?: string;
    },
    tripId?: string
  ): Promise<EventLogResponse | null> {
    try {
      const eventLog: EventLogRequest = {
        eventId: eventId,
        sessionId: tripId,
        eventType: 'DRIVER_CHECKIN',
        eventSubType: 'CHECK_IN',
        vehicle: {
          vehicleId: vehicleId,
        },
        driver: {
          driverId: '', // Will be filled from trip data
          name: driverInfo.name,
          licenseNumber: driverInfo.licenseNumber,
        },
        location: {
          type: 'CHECK_IN_LOCATION',
          address: checkInData.address,
          coordinates: {
            lat: checkInData.location.latitude,
            lng: checkInData.location.longitude,
          },
        },
        checkInOut: {
          type: 'CHECK_IN',
          actualTime: checkInData.checkInTimestamp,
        },
        status: VehicleState.MOVING,
        severity: Severity.INFOR,
        tags: ['driver', 'check-in', 'session-start'],
        eventTimestamp: checkInData.checkInTimestamp,
        correlationId: tripId,
        metadata: {
          sessionId: tripId,
          notes: `Driver ${driverInfo.name} checked in`,
        },
      };

      logger.info('Logging check-in event:', {
        eventId,
        sessionId: tripId,
        hasSessionId: !!eventLog.sessionId,
        payload: JSON.stringify(eventLog)
      });
      const response = await this.client.post<EventLogResponse>('/api/event-logs', eventLog);

      if (response.data && response.data.id) {
        logger.info(`Check-in event logged successfully: ${response.data.id}`, {
          sessionId: response.data.sessionId,
          correlationId: response.data.correlationId
        });
        return response.data;
      }

      logger.warn('⚠️ Event log API returned unexpected response structure');
      return null;
    } catch (error: any) {
      logger.error('Error logging check-in event:', error.message);
      // Don't throw - event logging should not block the main flow
      return null;
    }
  }

  /**
   * Log driver check-out event
   */
  async logCheckOutEvent(
    eventId: string,
    vehicleId: string,
    driverInfo: { name: string; licenseNumber: string },
    checkOutData: {
      checkOutTimestamp: string;
      workingDuration: number;
      location: { latitude: number; longitude: number; accuracy: number };
      address?: string;
    },
    tripId?: string
  ): Promise<EventLogResponse | null> {
    try {
      const eventLog: EventLogRequest = {
        eventId: eventId,
        sessionId: tripId,
        eventType: 'DRIVER_CHECKOUT',
        eventSubType: 'CHECK_OUT',
        vehicle: {
          vehicleId: vehicleId,
        },
        driver: {
          driverId: '', // Will be filled from trip data
          name: driverInfo.name,
          licenseNumber: driverInfo.licenseNumber,
        },
        location: {
          type: 'CHECK_OUT_LOCATION',
          address: checkOutData.address,
          coordinates: {
            lat: checkOutData.location.latitude,
            lng: checkOutData.location.longitude,
          },
        },
        checkInOut: {
          type: 'CHECK_OUT',
          actualTime: checkOutData.checkOutTimestamp,
        },
        status: VehicleState.COMPLETED,
        severity: Severity.INFOR,
        tags: ['driver', 'check-out', 'session-end'],
        eventTimestamp: checkOutData.checkOutTimestamp,
        correlationId: tripId,
        metadata: {
          sessionId: tripId,
          notes: `Driver ${driverInfo.name} checked out after ${checkOutData.workingDuration} minutes`,
        },
      };

      logger.info('Logging check-out event:', { eventId });
      const response = await this.client.post<EventLogResponse>('/api/event-logs', eventLog);

      if (response.data && response.data.id) {
        logger.info(`Check-out event logged successfully: ${response.data.id}`, {
          sessionId: response.data.sessionId,
          correlationId: response.data.correlationId
        });
        return response.data;
      }

      return null;
    } catch (error: any) {
      logger.error('Error logging check-out event:', error.message);
      // Don't throw - event logging should not block the main flow
      return null;
    }
  }

  /**
   * Log parking start event (when vehicle stops)
   */
  async logParkingStartEvent(
    eventId: string,
    vehicleId: string,
    parkingData: {
      parkingId: string;
      timestamp: string;
    },
    tripId?: string
  ): Promise<EventLogResponse | null> {
    try {
      const eventLog: EventLogRequest = {
        eventId: eventId,
        sessionId: tripId,
        eventType: 'PARKING_STATE_CHANGE',
        eventSubType: 'PARKING_START',
        vehicle: {
          vehicleId: vehicleId,
        },
        parking: {
          parkingId: parkingData.parkingId,
          duration: 0, // Will be updated when vehicle resumes
          status: 'PARKED',
          startTime: parkingData.timestamp,
        },
        status: VehicleState.IDLE,
        severity: Severity.WARNING,
        tags: ['parking', 'idle', 'state-change'],
        eventTimestamp: parkingData.timestamp,
        correlationId: tripId,
        metadata: {
          sessionId: tripId,
          notes: `Vehicle parked`,
        },
      };

      logger.info('Logging parking start event:', { eventId, parkingId: parkingData.parkingId });
      const response = await this.client.post<EventLogResponse>('/api/event-logs', eventLog);

      if (response.data && response.data.id) {
        logger.info(`Parking start event logged successfully: ${response.data.id}`, {
          sessionId: response.data.sessionId,
          correlationId: response.data.correlationId
        });
        return response.data;
      }

      return null;
    } catch (error: any) {
      logger.error('Error logging parking start event:', error.message);
      // Don't throw - event logging should not block the main flow
      return null;
    }
  }

  /**
   * Update parking event when vehicle resumes movement
   * Fetches the existing event, updates only necessary fields, then sends the complete object
   * This preserves all existing data like sessionId, correlationId, metadata.sessionId, etc.
   */
  async updateParkingEndEvent(
    mongoId: string,
    parkingData: {
      parkingDuration: number;
      endTime: string;
    }
  ): Promise<EventLogResponse | null> {
    try {
      // Step 1: Fetch the existing event
      logger.info('Fetching existing parking event:', { mongoId });
      const getResponse = await this.client.get<EventLogResponse>(`/api/event-logs/${mongoId}`);

      if (!getResponse.data || !getResponse.data.id) {
        logger.error('Failed to fetch existing parking event');
        return null;
      }

      const existingEvent = getResponse.data;
      logger.info('Existing event fetched successfully:', {
        id: existingEvent.id,
        hasSessionId: !!existingEvent.sessionId,
        hasParking: !!(existingEvent as any).parking,
      });

      // Step 2: Merge existing data with updates
      const updatedEvent = {
        ...existingEvent,
        eventSubType: 'PARKING_END',
        status: VehicleState.MOVING,
        parking: {
          ...(existingEvent as any).parking,
          duration: parkingData.parkingDuration,
          status: 'COMPLETED',
          endTime: parkingData.endTime,
        },
        metadata: {
          ...(existingEvent as any).metadata,
          notes: `Vehicle resumed movement after ${parkingData.parkingDuration} seconds`,
        },
      };

      // Step 3: Send the complete updated object
      logger.info('Updating parking event with merged data:', {
        mongoId,
        parkingDuration: parkingData.parkingDuration,
        hasSessionId: !!updatedEvent.sessionId,
      });
      const response = await this.client.put<EventLogResponse>(`/api/event-logs/${mongoId}`, updatedEvent);

      if (response.data && response.data.id) {
        logger.info(`Parking event updated successfully: ${response.data.id}`, {
          sessionId: response.data.sessionId,
          correlationId: response.data.correlationId
        });
        return response.data;
      }

      return null;
    } catch (error: any) {
      logger.error('Error updating parking event:', error.message);
      // Don't throw - event logging should not block the main flow
      return null;
    }
  }

  /**
   * Count parking events by session ID
   * @param sessionId - Trip/Session ID
   * @returns Number of parking events in the session
   */
  async countParkingEventsBySession(sessionId: string): Promise<number> {
    try {
      const response = await this.client.get<number>(
        '/api/event-logs/stats/count-by-type-and-session',
        {
          params: {
            eventType: 'PARKING_STATE_CHANGE',
            sessionId: sessionId,
          },
        }
      );

      logger.info(`Parking events count for session ${sessionId}: ${response.data}`);
      return response.data;
    } catch (error: any) {
      logger.error('Error counting parking events:', error.message);
      return 0; // Return 0 on error
    }
  }
}

export const eventLogService = new EventLogService();
