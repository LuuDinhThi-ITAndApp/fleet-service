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
  description: string;
  traceId?: string;
  data: {
    id: string;
    eventId: string;
    eventType: string;
    status: string;
    [key: string]: any;
  };
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
    }
  ): Promise<EventLogResponse['data'] | null> {
    try {
      const eventLog: EventLogRequest = {
        eventId: eventId,
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
        metadata: {
          notes: `Driver ${driverInfo.name} checked in`,
        },
      };

      logger.info('Logging check-in event:', { eventId });
      const response = await this.client.post<EventLogResponse>('/api/event-logs', eventLog);

      if (response.data && response.data.data) {
        logger.info(`Check-in event logged successfully: ${response.data.data.id}`);
        return response.data.data;
      }

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
    }
  ): Promise<EventLogResponse['data'] | null> {
    try {
      const eventLog: EventLogRequest = {
        eventId: eventId,
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
        metadata: {
          notes: `Driver ${driverInfo.name} checked out after ${checkOutData.workingDuration} minutes`,
        },
      };

      logger.info('Logging check-out event:', { eventId });
      const response = await this.client.post<EventLogResponse>('/api/event-logs', eventLog);

      if (response.data && response.data.data) {
        logger.info(`Check-out event logged successfully: ${response.data.data.id}`);
        return response.data.data;
      }

      return null;
    } catch (error: any) {
      logger.error('Error logging check-out event:', error.message);
      // Don't throw - event logging should not block the main flow
      return null;
    }
  }

  /**
   * Log parking state change event
   */
  async logParkingStateEvent(
    eventId: string,
    vehicleId: string,
    parkingData: {
      parkingId: string;
      parkingState: number;
      parkingDuration: number;
      timestamp: string;
    },
    tripId?: string
  ): Promise<EventLogResponse['data'] | null> {
    try {
      const isParked = parkingData.parkingState === 0;
      const status = isParked ? VehicleState.IDLE : VehicleState.MOVING;
      // Parking events always have WARNING severity by default
      const severity = Severity.WARNING;

      const eventLog: EventLogRequest = {
        eventId: eventId,
        eventType: 'PARKING_STATE_CHANGE',
        eventSubType: isParked ? 'PARKING_START' : 'PARKING_END',
        vehicle: {
          vehicleId: vehicleId,
        },
        parking: {
          parkingId: parkingData.parkingId,
          duration: parkingData.parkingDuration,
          status: isParked ? 'PARKED' : 'MOVING',
          startTime: isParked ? parkingData.timestamp : undefined,
          endTime: !isParked ? parkingData.timestamp : undefined,
        },
        status: status,
        severity: severity,
        tags: ['parking', isParked ? 'idle' : 'moving', 'state-change'],
        eventTimestamp: parkingData.timestamp,
        correlationId: tripId,
        metadata: {
          notes: `Vehicle ${isParked ? 'parked' : 'resumed movement'} for ${parkingData.parkingDuration} minutes`,
        },
      };

      logger.info('Logging parking state event:', { eventId, parkingState: parkingData.parkingState });
      const response = await this.client.post<EventLogResponse>('/api/event-logs', eventLog);

      if (response.data && response.data.data) {
        logger.info(`Parking state event logged successfully: ${response.data.data.id}`);
        return response.data.data;
      }

      return null;
    } catch (error: any) {
      logger.error('Error logging parking state event:', error.message);
      // Don't throw - event logging should not block the main flow
      return null;
    }
  }
}

export const eventLogService = new EventLogService();
