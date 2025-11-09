import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface CreateTripRequest {
  organizationId?: string;
  vehicleId?: string;
  driverId?: string;
  routeId?: string;
  tripNumber?: string;
  startTime: string; // ISO 8601 format with timezone
  endTime?: string;
  startAddress?: string;
  endAddress?: string;
  distanceKm?: number;
  durationMinutes?: number;
  idleTimeMinutes?: number;
  durationSeconds?: number;
  idleTimeSeconds?: number;
  avgSpeedKmh?: number;
  maxSpeedKmh?: number;
  fuelConsumedLiters?: number;
  startOdometer?: number;
  endOdometer?: number;
  harshAccelerationCount?: number;
  harshBrakingCount?: number;
  sharpTurnCount?: number;
  speedingCount?: number;
  totalAlerts?: number;
  criticalAlerts?: number;
  status?: string;
  notes?: string;
  continuousDrivingDurationSeconds?: number;
}

interface TripResponse {
  description: string;
  traceId?: string;
  data: {
    id: string;
    vehicleId: string;
    driverId: string;
    tripNumber: string;
    startTime: string;
    endTime?: string;
    status: string;
    [key: string]: any;
  };
}

interface ErrorResponse {
  errorType: string;
  responseCode: string;
  description: string;
}

class TripService {
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
   * Create a new trip with status "Working"
   */
  async createTrip(request: CreateTripRequest): Promise<TripResponse['data'] | null> {
    try {
      logger.info('Creating new trip:', {
        vehicleId: request.vehicleId,
        driverId: request.driverId,
        startTime: request.startTime,
      });

      const response = await this.client.post<TripResponse>('/api/trips', request);

      if (response.data && response.data.data) {
        logger.info(`Trip created successfully: ${response.data.data.id}`);
        return response.data.data;
      }

      return null;
    } catch (error: any) {
      if (error.response?.status === 400) {
        const errorData: ErrorResponse = error.response.data;
        logger.error(`Failed to create trip: ${errorData.description}`);

        // Log specific error about ongoing trip
        if (errorData.description?.includes('chưa kết thúc')) {
          logger.warn('Vehicle has ongoing trip. Cannot create new trip.');
        }

        throw new Error(errorData.description);
      }

      logger.error('Error creating trip:', error.message);
      throw error;
    }
  }

  /**
   * End driving session for a vehicle
   */
  async endDrivingSession(vehicleId: string): Promise<TripResponse['data'] | null> {
    try {
      logger.info(`Ending driving session for vehicle: ${vehicleId}`);

      const response = await this.client.put<TripResponse>(
        `/api/trips/vehicle/${vehicleId}/end-session`
      );

      if (response.data && response.data.data) {
        logger.info(`Driving session ended successfully for vehicle: ${vehicleId}`);
        return response.data.data;
      }

      return null;
    } catch (error: any) {
      if (error.response?.status === 400) {
        const errorData: ErrorResponse = error.response.data;
        logger.warn(`Cannot end session: ${errorData.description}`);
        return null;
      }

      logger.error('Error ending driving session:', error.message);
      throw error;
    }
  }

  /**
   * Get latest trip for a vehicle
   */
  async getLatestTrip(vehicleId: string): Promise<TripResponse['data'] | null> {
    try {
      const response = await this.client.get<TripResponse>(
        `/api/trips/vehicle/${vehicleId}/latest`
      );

      if (response.data && response.data.data) {
        return response.data.data;
      }

      return null;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.info(`No trips found for vehicle: ${vehicleId}`);
        return null;
      }

      logger.error('Error fetching latest trip:', error.message);
      throw error;
    }
  }

  /**
   * Update trip with check-out data (end time, duration, location)
   * Fetches existing trip, merges with new data, then sends complete object
   */
  async updateTripCheckOut(
    tripId: string,
    checkOutData: {
      startTime: string;
      endTime: string;
      endAddress: string;
      durationMinutes: number;
      status?: string;
      notes?: string;
    }
  ): Promise<TripResponse['data'] | null> {
    try {
      logger.info(`Updating trip ${tripId} with check-out data:`, {
        endTime: checkOutData.endTime,
        durationMinutes: checkOutData.durationMinutes,
      });

      // Step 1: Fetch existing trip
      const getResponse = await this.client.get<TripResponse>(`/api/trips/${tripId}`);

      if (!getResponse.data || !getResponse.data.data) {
        logger.error('Failed to fetch existing trip for update');
        return null;
      }

      const existingTrip = getResponse.data.data;
      logger.info('Existing trip fetched successfully:', {
        id: existingTrip.id,
        hasVehicleId: !!existingTrip.vehicleId,
        hasDriverId: !!existingTrip.driverId,
      });

      // Step 2: Merge existing data with updates
      const updatedTrip = {
        ...existingTrip,
        ...checkOutData,
        status: checkOutData.status || 'Completed',
      };

      // Step 3: Send complete updated object
      const response = await this.client.put<TripResponse>(`/api/trips/${tripId}`, updatedTrip);

      if (response.data && response.data.data) {
        logger.info(`Trip ${tripId} updated successfully with check-out data`);
        return response.data.data;
      }

      return null;
    } catch (error: any) {
      if (error.response) {
        const errorData: ErrorResponse = error.response.data;
        logger.error(`Failed to update trip [${error.response.status}]: ${errorData?.description || 'Unknown error'}`, {
          status: error.response.status,
          data: error.response.data,
        });
        throw new Error(errorData?.description || `HTTP ${error.response.status} error`);
      }

      logger.error('Error updating trip with check-out:', error.message);
      throw error;
    }
  }

  /**
   * Update trip with partial data
   * Fetches existing trip, merges with new data, then sends complete object
   */
  async updateTrip(tripId: string, updateData: Partial<CreateTripRequest>): Promise<TripResponse['data'] | null> {
    try {
      logger.info(`Updating trip ${tripId} with data:`, updateData);

      // Step 1: Fetch existing trip
      const getResponse = await this.client.get<TripResponse>(`/api/trips/${tripId}`);

      if (!getResponse.data || !getResponse.data.data) {
        logger.error('Failed to fetch existing trip for update');
        return null;
      }

      const existingTrip = getResponse.data.data;
      logger.info('Existing trip fetched successfully:', {
        id: existingTrip.id,
        status: existingTrip.status,
      });

      // Step 2: Merge existing data with updates
      const updatedTrip = {
        ...existingTrip,
        ...updateData,
      };

      // Step 3: Send complete updated object
      const response = await this.client.put<TripResponse>(`/api/trips/${tripId}`, updatedTrip);

      if (response.data && response.data.data) {
        logger.info(`Trip ${tripId} updated successfully`);
        return response.data.data;
      }

      return null;
    } catch (error: any) {
      if (error.response) {
        const errorData: ErrorResponse = error.response.data;
        logger.error(`Failed to update trip [${error.response.status}]: ${errorData?.description || 'Unknown error'}`, {
          status: error.response.status,
          data: error.response.data,
        });
        throw new Error(errorData?.description || `HTTP ${error.response.status} error`);
      }

      logger.error('Error updating trip:', error.message);
      throw error;
    }
  }

  /**
   * Generate trip number based on device ID and timestamp
   */
  generateTripNumber(deviceId: string): string {
    const timestamp = Date.now();
    const shortId = deviceId.substring(0, 8).toUpperCase();
    return `TRIP-${shortId}-${timestamp}`;
  }
}

export const tripService = new TripService();
