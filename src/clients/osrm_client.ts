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

  // Performance configurations
  private readonly MAX_POINTS_PER_BATCH = 12;
  private readonly MAX_RADIUS = 100;     // Increase from 50 to 100m for better coverage
  private readonly MIN_RADIUS = 20;      // Increase from 10 to 20m
  private readonly TIMEOUT_MS = 10000;   // 10 seconds

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: this.TIMEOUT_MS,
      maxContentLength: 50000,
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

    // Limit batch size for performance
    if (points.length > this.MAX_POINTS_PER_BATCH) {
      console.log(`[OSRM] Reducing points from ${points.length} to ${this.MAX_POINTS_PER_BATCH} for performance`);
      points = points.slice(0, this.MAX_POINTS_PER_BATCH);
    }

    return await this.snapSingleBatch(points);
  }

  /**
   * Snap single batch with optimized radius calculation
   */
  private async snapSingleBatch(points: GpsPoint[]): Promise<SnapResultData> {
    try {
      const startTime = Date.now();

      // Build coordinates string: lng,lat;lng,lat;...
      const coordinates = points
        .map((p) => `${p.longitude},${p.latitude}`)
        .join(';');

      // Calculate OPTIMIZED radiuses based on accuracy and speed
      const radiuses = points
        .map((p, index) => this.calculateOptimizedRadius(p.accuracy, p.speed, index, points.length))
        .join(';');

      const url = `/match/v1/driving/${coordinates}`;

      console.log(
        `[OSRM] Snapping ${points.length} points, ` +
        `radiuses: ${radiuses.split(';').slice(0, 3).join(',')}...${radiuses.split(';').slice(-1)}`
      );

      // Call OSRM API with retry on timeout
      let retries = 2;
      let lastError: any = null;
      
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const response = await this.client.get<OsrmMatchResponse>(url, {
            params: {
              overview: 'full',        // CRITICAL: Full geometry, not simplified
              geometries: 'geojson',   // Return GeoJSON format
              radiuses: radiuses,
              gaps: 'split',
              tidy: 'true',
              steps: 'true',           // Include turn-by-turn steps for full detail
              annotations: 'false',    // Disable to reduce response size
            },
          });

          const elapsed = Date.now() - startTime;
          const result = response.data;

          // Process response
          if (result.code === 'Ok' && result.matchings && result.matchings.length > 0) {
            const matching = result.matchings[0];
            const snappedCount = matching.geometry.coordinates.length;

            // Warn if OSRM simplified too much
            if (snappedCount < points.length / 2) {
              console.warn(
                `[OSRM] ⚠️ Geometry simplified: ${points.length} input points → ${snappedCount} output points. ` +
                `This may cause straight lines in curves!`
              );
            }

            console.log(
              `[OSRM] ✅ Success in ${elapsed}ms (attempt ${attempt + 1}): ` +
              `confidence=${(matching.confidence * 100).toFixed(1)}%, ` +
              `distance=${matching.distance.toFixed(0)}m, ` +
              `points=${points.length}→${snappedCount}`
            );

            // Warn if slow
            if (elapsed > 3000) {
              console.warn(`[OSRM] ⚠️ Slow response: ${elapsed}ms`);
            }

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
            console.error(
              `[OSRM] ❌ Snap failed (attempt ${attempt + 1}): ${result.code} - ${result.message || 'Unknown error'}`
            );
            
            // Try with unlimited radius as fallback on NoSegment
            if (result.code === 'NoSegment' && attempt === retries) {
              console.log('[OSRM] Final attempt with unlimited radius...');
              return await this.snapToRoadWithUnlimitedRadius(points);
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
            console.warn(`[OSRM] ⏱️ Timeout (${this.TIMEOUT_MS}ms) on attempt ${attempt + 1}/${retries + 1}`);
            if (attempt < retries) {
              // Wait before retry (exponential backoff)
              const delay = 500 * (attempt + 1);
              await new Promise(resolve => setTimeout(resolve, delay));
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
      console.error('[OSRM] Request error after retries');
      
      if (error instanceof Error) {
        console.error('[OSRM] Error:', {
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
   * Calculate optimized radius based on accuracy, speed, and position
   */
  private calculateOptimizedRadius(
    accuracy: number, 
    speed: number = 0, 
    index: number, 
    total: number
  ): number {
    // Base radius on GPS accuracy with reasonable multiplier
    let radius = Math.max(this.MIN_RADIUS, accuracy * 2.5);

    // Adjust for speed
    const speedKmh = speed * 3.6;
    if (speedKmh < 5) {
      // Very slow/stationary - GPS drift common, use larger radius
      radius = Math.max(radius, 40);
    } else if (speedKmh < 20) {
      // Slow (roundabouts, turns) - moderate radius
      radius = Math.max(radius, 50);
    } else if (speedKmh < 50) {
      // Normal city speed - standard radius
      radius = Math.max(radius, 60);
    } else {
      // High speed - larger radius for highway
      radius = Math.max(radius, 70);
    }

    // Middle points (curves/roundabouts) get significantly larger radius
    if (index > 0 && index < total - 1) {
      radius = Math.max(radius, 60);
    }

    // Cap at maximum
    radius = Math.min(this.MAX_RADIUS, radius);

    return Math.round(radius);
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