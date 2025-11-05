import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface DriverResponse {
  description: string;
  traceId?: string;
  data: {
    id: string;
    firstName: string;
    lastName: string;
    licenseNumber: string;
    licenseType: string;
    phone: string;
    email: string;
    status: string;
  };
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
}

export const driverService = new DriverService();
