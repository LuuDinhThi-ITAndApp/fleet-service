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
  private readonly MAX_POINTS_PER_BATCH = 5;
  private readonly MAX_RADIUS = 30;      // Reduce from 100m to 50m - prevent matching wrong parallel roads
  private readonly MIN_RADIUS = 10;      // Reduce from 20m to 10m - trust good GPS accuracy
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
   * Dynamically adjust max points based on vehicle speed
   */
  public async snapToRoad(points: GpsPoint[]): Promise<SnapResultData> {
    if (points.length < 2) {
      return {
        success: false,
        originalPointsCount: points.length,
        error: 'Not enough points for snapping (need at least 2)',
      };
    }

    // Calculate dynamic max points based on average speed
    const avgSpeed = points.reduce((sum, p) => sum + p.speed, 0) / points.length;
    const speedKmh = avgSpeed;
    
    let maxPoints: number;
    if (speedKmh < 10) {
      maxPoints = 4; // Very slow - increased from 5 to 8 for better curve detail
    } else if (speedKmh < 30) {
      maxPoints = 8; // City speed - increased from 7 to 12
    } else if (speedKmh < 60) {
      maxPoints = 12; // Higher speed - increased from 9 to 15
    } else {
      maxPoints = 20; // Highway - increased from 12 to 20 for smoother curves
    }

    // Limit batch size based on speed
    if (points.length > maxPoints) {
      console.log(`[OSRM] Reducing points from ${points.length} to ${maxPoints} (speed: ${speedKmh.toFixed(1)} km/h)`);
      points = points.slice(0, maxPoints);
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
        // Safely extract dynamic 'code' property without using TypeScript 'as' assertion
        // to avoid emitting TypeScript-only syntax into runtime JS when files are
        // executed directly in some environments.
        let codeVal: unknown = undefined;
        try {
          // Access dynamic property using Reflect.get to avoid TypeScript 'as' syntax
          // which may appear verbatim if the .ts file is executed without transpilation.
          // @ts-ignore
          codeVal = Reflect.get(error, 'code');
        } catch (_) {
          codeVal = undefined;
        }

        console.error('[OSRM] Error:', {
          message: error.message,
          code: codeVal,
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
   * SMALLER radius = more accurate but risk no match
   * LARGER radius = always match but risk wrong road
   */
  private calculateOptimizedRadius(
    accuracy: number, 
    speed: number = 0, 
    index: number, 
    total: number
  ): number {
    // Base radius primarily on GPS accuracy
    // Use 1.5x multiplier (reduced from 2.5x) to trust GPS more
    let radius = Math.max(this.MIN_RADIUS, accuracy * 1.5);

    // Adjust for speed - use SMALLER values to avoid wrong roads
    const speedKmh = speed; // speed is already in km/h
    if (speedKmh < 5) {
      // Very slow/stationary - use small radius, GPS drift is common but prefer accuracy
      radius = Math.max(radius, 10);
    } else if (speedKmh < 20) {
      // Slow (roundabouts, turns) - small radius for precision
      radius = Math.max(radius, 12);
    } else if (speedKmh < 30) {
      // Normal city speed - moderate radius
      radius = Math.max(radius, 15);
    }  else if (speedKmh < 50) {
      // Normal city speed - moderate radius
      radius = Math.max(radius, 18);
    } else {
      // High speed highway - larger radius acceptable
      radius = Math.max(radius, 25);
    }

    // Middle points get slightly more tolerance for curves
    if (index > 0 && index < total - 1) {
      radius = Math.max(radius, 20);
    }

    // Cap at maximum (now 50m instead of 100m)
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
