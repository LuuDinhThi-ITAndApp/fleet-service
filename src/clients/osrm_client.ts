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
      timeout: 15000, // Increase to 15 seconds for heavy requests
      maxContentLength: 50000, // Increase max content length
      maxBodyLength: 50000,
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

    // Limit to 12 points to avoid URL too long and timeout
    // Use first, last, and evenly distributed middle points
    let processedPoints = points;
    if (points.length > 12) {
      const step = Math.floor(points.length / 11); // Keep 12 points total
      processedPoints = [
        points[0], // Always keep first
        ...points.slice(1, -1).filter((_, i) => i % step === 0).slice(0, 10), // Middle points
        points[points.length - 1], // Always keep last
      ];
      console.log(`[OSRM] Reducing points from ${points.length} to ${processedPoints.length} to avoid timeout`);
    }

    try {
      // Build coordinates string: lng,lat;lng,lat;...
      const coordinates = processedPoints
        .map((p) => `${p.longitude},${p.latitude}`)
        .join(';');

      // Calculate radiuses based on GPS accuracy
      // Use adaptive radius: larger for curves and uncertain areas
      const radiuses = processedPoints
        .map((p, index) => {
          // Base radius from accuracy
          let radius = Math.max(50, p.accuracy * 3); // Increase multiplier to 3
          
          // Increase radius significantly for middle points (likely in curves/roundabouts)
          if (index > 0 && index < processedPoints.length - 1) {
            radius = Math.max(radius, 150); // Minimum 150m for middle points (up from 100m)
          }
          
          // Increase cap to 250m for better roundabout coverage
          radius = Math.min(250, radius);
          return radius.toFixed(0);
        })
        .join(';');

      const url = `/match/v1/driving/${coordinates}`;

      console.log(
        `[OSRM] Snapping ${processedPoints.length} points (original: ${points.length})`
      );
      console.log(`[OSRM] Radiuses: ${radiuses}`);
      console.log(`[OSRM] First point: [${processedPoints[0].longitude}, ${processedPoints[0].latitude}]`);
      console.log(`[OSRM] Last point: [${processedPoints[processedPoints.length - 1].longitude}, ${processedPoints[processedPoints.length - 1].latitude}]`);

      // Call OSRM API with retry on timeout
      let retries = 2;
      let lastError: any = null;
      
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
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
              `[OSRM] ✅ Success (attempt ${attempt + 1}): confidence=${(matching.confidence * 100).toFixed(1)}%, ` +
                `distance=${matching.distance.toFixed(0)}m, ` +
                `points=${processedPoints.length}→${snappedCount}`
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
              `[OSRM] ❌ Snap failed (attempt ${attempt + 1}): ${result.code} - ${result.message || 'Unknown error'}`
            );
            
            // Try with unlimited radius as fallback
            if (result.code === 'NoSegment') {
              console.log('[OSRM] Retrying with unlimited radius...');
              return await this.snapToRoadWithUnlimitedRadius(processedPoints);
            }

            return {
              success: false,
              originalPointsCount: points.length,
              error: result.message || `OSRM returned code: ${result.code}`,
            };
          }
        } catch (error: any) {
          lastError = error;
          
          if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
            console.warn(`[OSRM] ⏱️ Timeout on attempt ${attempt + 1}/${retries + 1}`);
            if (attempt < retries) {
              // Wait before retry (exponential backoff)
              await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
              continue;
            }
          }
          
          // Non-timeout error or last retry failed
          throw error;
        }
      }
      
      // All retries failed
      throw lastError;
      
    } catch (error) {
      console.error('[OSRM] Request error after retries:', error);
      
      if (error instanceof Error) {
        console.error('[OSRM] Error details:', {
          message: error.message,
          code: (error as any).code,
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