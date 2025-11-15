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

interface ViolationOperation {
  timeStamp: number;
  messageId: string;
  violationValue: number;
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
  violationOperation?: ViolationOperation;
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
    latestLocation: any,
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
        location: {
          coordinates: {
            lat: latestLocation.gps_data.latitude,
            lng: latestLocation.gps_data.longitude,
          }
        }
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

  /**
   * Count speed limit violations by session ID
   * Uses the new API endpoint that filters by eventSubType
   * @param sessionId - Trip/Session ID
   * @returns Number of speed limit violation events in the session
   */
  async countSpeedViolationsBySession(sessionId: string): Promise<number> {
    try {
      const response = await this.client.get<number>(
        '/api/event-logs/stats/count-by-session-and-subtype',
        {
          params: {
            sessionId: sessionId,
            eventSubType: 'speed_limit_violate',
          },
        }
      );

      logger.info(`Speed limit violations count for session ${sessionId}: ${response.data}`);
      return response.data || 0;
    } catch (error: any) {
      logger.error('Error counting speed violations:', error.message);
      return 0; // Return 0 on error
    }
  }

  /**
   * Log vehicle operation violation event
   * According to EVENT_LOG_API.md documentation
   */
  async logViolationEvent(
    eventId: string,
    vehicleId: string,
    violationData: {
      timestamp: string;
      messageId: string;
      violationType: 'CONTINUOUS_DRIVING' | 'PARKING_DURATION' | 'SPEED_LIMIT';
      violationValue: number;
      violationUnit: string;
    },
    tripId?: string
  ): Promise<EventLogResponse | null> {
    try {
      // Map violation type to eventSubType according to API docs
      const eventSubTypeMap = {
        'SPEED_LIMIT': 'speed_limit_violate',
        'CONTINUOUS_DRIVING': 'continuous_driving_time_violate',
        'PARKING_DURATION': 'parking_duration_violate',
      };

      const eventLog: EventLogRequest = {
        eventId: eventId,
        sessionId: tripId,
        eventType: 'vehicle_movement',
        eventSubType: eventSubTypeMap[violationData.violationType],
        vehicle: {
          vehicleId: vehicleId,
        },
        violationOperation: {
          timeStamp: Math.floor(new Date(violationData.timestamp).getTime() / 1000), // Convert to Unix timestamp in seconds
          messageId: violationData.messageId,
          violationValue: violationData.violationValue,
        },
        status: VehicleState.MOVING,
        severity: Severity.WARNING,
        tags: ['violation', violationData.violationType.toLowerCase()],
        eventTimestamp: violationData.timestamp,
        correlationId: tripId,
        metadata: {
          sessionId: tripId,
          notes: `${violationData.violationType} violation: ${violationData.violationValue} ${violationData.violationUnit}`,
        },
      };

      logger.info('Logging violation event:', {
        eventId,
        violationType: violationData.violationType,
        violationValue: violationData.violationValue,
      });
      const response = await this.client.post<EventLogResponse>('/api/event-logs', eventLog);

      if (response.data && response.data.id) {
        logger.info(`Violation event logged successfully: ${response.data.id}`, {
          sessionId: response.data.sessionId,
          correlationId: response.data.correlationId,
        });
        return response.data;
      }

      return null;
    } catch (error: any) {
      logger.error('Error logging violation event:', error.message);
      // Don't throw - event logging should not block the main flow
      return null;
    }
  }

  /**
   * Log DMS (Driver Monitoring System) violation event
   */
  async logDMSEvent(
    eventId: string,
    vehicleId: string,
    dmsData: {
      timestamp: string;
      messageId: string;
      behaviorViolate: string;
      speed: number;
      location: { latitude: number; longitude: number; gpsTimestamp: string };
      imageUrl: string;
      driverName: string;
      driverLicenseNumber: string;
    },
    tripId?: string
  ): Promise<EventLogResponse | null> {
    try {
      // Create eventSubType with behavior (e.g., "drowsiness_detected", "phone_usage")
      const behaviorSlug = dmsData.behaviorViolate.toLowerCase().replace(/\s+/g, '_');
      const eventSubType = `driver_behavior_${behaviorSlug}`;

      const eventLog: EventLogRequest = {
        eventId: eventId,
        sessionId: tripId,
        eventType: 'vehicle_movement',
        eventSubType: eventSubType,
        vehicle: {
          vehicleId: vehicleId,
        },
        driver: {
          driverId: '', // TODO: Map license number to driver ID
          name: dmsData.driverName,
          licenseNumber: dmsData.driverLicenseNumber,
        },
        location: {
          address: `Lat: ${dmsData.location.latitude.toFixed(6)}, Lon: ${dmsData.location.longitude.toFixed(6)}`,
          coordinates: {
            lat: dmsData.location.latitude,
            lng: dmsData.location.longitude,
          },
        },
        status: VehicleState.MOVING,
        severity: Severity.WARNING,
        tags: ['dms', 'violation', 'driver_behavior', dmsData.behaviorViolate.toLowerCase().replace(/\s+/g, '_')],
        eventTimestamp: dmsData.timestamp,
        correlationId: tripId,
        metadata: {
          sessionId: tripId,
          notes: `DMS Violation: ${dmsData.behaviorViolate} at ${dmsData.speed} km/h`,
          attachments: dmsData.imageUrl ? [dmsData.imageUrl] : [],
        },
      };

      logger.info('Logging DMS violation event:', {
        eventId,
        behavior: dmsData.behaviorViolate,
        speed: dmsData.speed,
        driver: dmsData.driverName,
      });

      const response = await this.client.post<EventLogResponse>('/api/event-logs', eventLog);

      if (response.data && response.data.id) {
        logger.info(`DMS violation event logged successfully: ${response.data.id}`, {
          sessionId: response.data.sessionId,
          correlationId: response.data.correlationId,
        });
        return response.data;
      }

      return null;
    } catch (error: any) {
      logger.error('Error logging DMS violation event:', error.message);
      // Don't throw - event logging should not block the main flow
      return null;
    }
  }

  /**
   * Count DMS violations for a specific session/trip
   */
  async countDMSViolationsBySession(sessionId: string): Promise<number> {
    try {
      const response = await this.client.get<{ total: number }>(
        `/api/event-logs/count?sessionId=${sessionId}&eventType=vehicle_movement&eventSubType=driver_behavior_violation`
      );

      if (response.data && typeof response.data.total === 'number') {
        return response.data.total;
      }

      return 0;
    } catch (error: any) {
      logger.error('Error counting DMS violations:', error.message);
      return 0;
    }
  }
}

export const eventLogService = new EventLogService();
