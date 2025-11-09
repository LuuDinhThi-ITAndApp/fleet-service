/**
 * OSRM Client - Interface with OSRM Match API
 */

import axios, { AxiosInstance } from 'axios';
import {
  GpsPoint,
  OsrmMatchResponse,
  SnapResultData,
  IOsrmClient,
} from '../types/tracking';

class OsrmClient implements IOsrmClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 5000,
    });
  }

  /**
   * Snap GPS points to road using OSRM Match API
   */
  public async snapToRoad(points: GpsPoint[]): Promise<SnapResultData> {
    if (points.length < 2) {
      return {
        success: false,
        originalPointsCount: points.length,
        error: 'Not enough points for snapping (need at least 2)',
      };
    }

    try {
      // Build coordinates string: lng,lat;lng,lat;...
      const coordinates = points
        .map((p) => `${p.longitude},${p.latitude}`)
        .join(';');

      // Calculate radiuses based on GPS accuracy
      // Use adaptive radius: larger for curves and uncertain areas
      const radiuses = points
        .map((p, index) => {
          // Base radius from accuracy
          let radius = Math.max(50, p.accuracy * 3); // Increase multiplier to 3
          
          // Increase radius significantly for middle points (likely in curves/roundabouts)
          if (index > 0 && index < points.length - 1) {
            radius = Math.max(radius, 150); // Minimum 150m for middle points (up from 100m)
          }
          
          // Increase cap to 250m for better roundabout coverage
          radius = Math.min(250, radius);
          return radius.toFixed(0);
        })
        .join(';');

      const url = `/match/v1/driving/${coordinates}`;

      console.log(
        `[OSRM] Snapping ${points.length} points`
      );
      console.log(`[OSRM] Radiuses: ${radiuses}`);
      console.log(`[OSRM] First point: [${points[0].longitude}, ${points[0].latitude}]`);
      console.log(`[OSRM] Last point: [${points[points.length - 1].longitude}, ${points[points.length - 1].latitude}]`);

      // Call OSRM API
      const response = await this.client.get<OsrmMatchResponse>(url, {
        params: {
          overview: 'full',
          geometries: 'geojson',
          radiuses: radiuses,
          gaps: 'split',
          tidy: 'true',
          annotations: 'true',
        },
      });

      const result = response.data;

      // Process response
      if (result.code === 'Ok' && result.matchings && result.matchings.length > 0) {
        const matching = result.matchings[0];
        const snappedCount = matching.geometry.coordinates.length;

        console.log(
          `[OSRM] ✅ Success: confidence=${(matching.confidence * 100).toFixed(1)}%, ` +
            `distance=${matching.distance.toFixed(0)}m, ` +
            `points=${points.length}→${snappedCount}`
        );

        return {
          success: true,
          geometry: matching.geometry,
          confidence: matching.confidence,
          distance: matching.distance,
          duration: matching.duration,
          originalPointsCount: points.length,
          snappedPointsCount: snappedCount,
        };
      } else {
        // Log detailed error for debugging
        console.error(
          `[OSRM] ❌ Snap failed: ${result.code} - ${result.message || 'Unknown error'}`
        );
        console.error(`[OSRM] Response:`, JSON.stringify(result, null, 2));
        
        // Try with unlimited radius as fallback
        if (result.code === 'NoSegment') {
          console.log('[OSRM] Retrying with unlimited radius...');
          return await this.snapToRoadWithUnlimitedRadius(points);
        }

        return {
          success: false,
          originalPointsCount: points.length,
          error: result.message || `OSRM returned code: ${result.code}`,
        };
      }
    } catch (error) {
      console.error('[OSRM] Request error:', error);
      
      if (error instanceof Error) {
        console.error('[OSRM] Error details:', {
          message: error.message,
          stack: error.stack,
        });
      }

      return {
        success: false,
        originalPointsCount: points.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Fallback: Try snap-to-road with unlimited radius
   */
  private async snapToRoadWithUnlimitedRadius(points: GpsPoint[]): Promise<SnapResultData> {
    try {
      const coordinates = points
        .map((p) => `${p.longitude},${p.latitude}`)
        .join(';');

      const url = `/match/v1/driving/${coordinates}`;

      console.log(`[OSRM] Fallback attempt with unlimited radius`);

      // Call OSRM API without radius restriction
      const response = await this.client.get<OsrmMatchResponse>(url, {
        params: {
          overview: 'full',
          geometries: 'geojson',
          gaps: 'split',
          tidy: 'true',
          annotations: 'true',
          // No radiuses parameter = unlimited search radius
        },
      });

      const result = response.data;

      if (result.code === 'Ok' && result.matchings && result.matchings.length > 0) {
        const matching = result.matchings[0];
        const snappedCount = matching.geometry.coordinates.length;

        console.log(
          `[OSRM] ✅ Fallback success: confidence=${(matching.confidence * 100).toFixed(1)}%, ` +
            `distance=${matching.distance.toFixed(0)}m, ` +
            `points=${points.length}→${snappedCount}`
        );

        return {
          success: true,
          geometry: matching.geometry,
          confidence: matching.confidence,
          distance: matching.distance,
          duration: matching.duration,
          originalPointsCount: points.length,
          snappedPointsCount: snappedCount,
        };
      } else {
        console.error(`[OSRM] ❌ Fallback also failed: ${result.code}`);
        return {
          success: false,
          originalPointsCount: points.length,
          error: `Fallback failed: ${result.message || result.code}`,
        };
      }
    } catch (error) {
      console.error('[OSRM] Fallback error:', error);
      return {
        success: false,
        originalPointsCount: points.length,
        error: 'Fallback request failed',
      };
    }
  }

  /**
   * Health check
   */
  public async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/health', { timeout: 2000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Get base URL
   */
  public getBaseUrl(): string {
    return this.baseUrl;
  }
}

// Option 1: Private server (limited map coverage)
export const osrmClient = new OsrmClient('http://103.216.116.186:8091')

// Option 2: OSRM Demo Server (global coverage - for testing only)
// export const osrmClient = new OsrmClient('http://router.project-osrm.org')