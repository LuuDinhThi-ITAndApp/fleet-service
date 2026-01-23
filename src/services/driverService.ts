import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface DriverData {
  id: string;
  firstName: string;
  lastName: string;
  licenseNumber: string;
  licenseType: string;
  phone: string;
  email: string;
  status: string;
}

interface DriverResponse {
  description: string;
  traceId?: string;
  data: DriverData;
}

interface CreateDriverRequest {
  organizationId?: string;
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  address?: string;
  licenseNumber: string;
  licenseType?: string;
  licenseExpiry: string;
  licenseIssueDate?: string;
  employeeId?: string;
  hireDate?: string;
  medicalCertificateExpiry?: string;
  lastTrainingDate?: string;
  behaviorScore?: number;
  status?: string;
  photoUrl?: string;
  notes?: string;
  faceVector?: string;
}

interface CheckDuplicateRequest {
  faceVector: string;
  threshold: number;
}

interface CheckDuplicateResponse {
  description: string;
  traceId?: string;
  data: DriverData[];
}

class DriverService {
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
   * Get driver information by ID from Fleet API
   */
  async getDriverById(driverId: string): Promise<DriverResponse['data'] | null> {
    try {
      const response = await this.client.get<DriverResponse>(`/api/drivers/${driverId}`);

      if (response.data && response.data.data) {
        logger.info(`Driver info fetched successfully: ${driverId}`);
        return response.data.data;
      }

      return null;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.warn(`Driver not found: ${driverId}`);
        return null;
      }

      logger.error(`Error fetching driver info for ${driverId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get mock driver info for testing with predefined UUIDs
   */
  getMockDriverInfo(index: number = 0): DriverResponse['data'] {
    const mockDrivers = [
      {
        id: '880e8400-e29b-41d4-a716-446655440001',
        firstName: 'Nguyen',
        lastName: 'Van A',
        licenseNumber: 'B2-123456789',
        licenseType: 'B2',
        phone: '+84123456789',
        email: 'nguyenvana@example.com',
        status: 'active',
      },
      {
        id: '880e8400-e29b-41d4-a716-446655440002',
        firstName: 'Tran',
        lastName: 'Thi B',
        licenseNumber: 'C-987654321',
        licenseType: 'C',
        phone: '+84987654321',
        email: 'tranthib@example.com',
        status: 'active',
      },
    ];

    return mockDrivers[index % mockDrivers.length];
  }

  /**
   * Check for duplicate biometric (face vector)
   * POST /api/face-recognition/check-duplicate
   */
  async checkDuplicateBiometric(faceVector: string, threshold: number = 0.95): Promise<CheckDuplicateResponse | null> {
    try {
      const response = await this.client.post<CheckDuplicateResponse>('/api/face-recognition/check-duplicate', {
        faceVector,
        threshold
      });

      logger.info(`Check duplicate biometric completed, found ${response.data.data?.length || 0} matches`);
      return response.data;
    } catch (error: any) {
      logger.error('Error checking duplicate biometric:', error.message);
      return null;
    }
  }

  /**
   * Create a new driver
   * POST /api/drivers
   */
  async createDriver(driverData: CreateDriverRequest): Promise<DriverData | null> {
    try {
      const response = await this.client.post<DriverResponse>('/api/drivers', driverData);

      if (response.data && response.data.data) {
        logger.info(`Driver created successfully: ${response.data.data.id}`);
        return response.data.data;
      }

      return null;
    } catch (error: any) {
      logger.error('Error creating driver:', error.message);
      throw error;
    }
  }
}

export const driverService = new DriverService();
