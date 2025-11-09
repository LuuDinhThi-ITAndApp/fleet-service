/**
 * GPS Buffer - Manages GPS points for a single vehicle
 */

import { GpsPoint, VehicleStats, IGpsBuffer } from '../types/tracking';

class GpsBuffer implements IGpsBuffer {
  private vehicleId: string;
  private points: GpsPoint[] = [];
  private lastSnapTime: number;
  private totalReceived: number = 0;
  private totalSnapped: number = 0;
  private readonly minDistance: number;

  constructor(vehicleId: string, minDistance: number = 5.0) {
    this.vehicleId = vehicleId;
    this.minDistance = minDistance;
    this.lastSnapTime = Date.now();
  }

  /**
   * Add a GPS point to the buffer
   * Returns true if point was added, false if filtered out
   */
  public addPoint(point: GpsPoint): boolean {
    this.totalReceived++;

    // Check if point is too close to last point
    if (this.points.length > 0) {
      const lastPoint = this.points[this.points.length - 1];
      const distance = this.calculateDistance(
        lastPoint.latitude,
        lastPoint.longitude,
        point.latitude,
        point.longitude
      );

      if (distance < this.minDistance) {
        console.log(
          `[${this.vehicleId}] Point too close (${distance.toFixed(2)}m), skipping`
        );
        return false;
      }
    }

    this.points.push(point);
    console.log(
      `[${this.vehicleId}] Buffer: ${this.points.length} points`
    );
    return true;
  }

  /**
   * Check if buffer should be snapped
   */
  public shouldSnap(bufferSize: number, timeoutMs: number): boolean {
    const bufferFull = this.points.length >= bufferSize;
    const timeoutReached = (Date.now() - this.lastSnapTime) > timeoutMs;
    const hasMinPoints = this.points.length >= 3;

    return (bufferFull || timeoutReached) && hasMinPoints;
  }

  /**
   * Get all points in buffer
   */
  public getPoints(): GpsPoint[] {
    return [...this.points];
  }

  /**
   * Clear snapped points, keeping last 2 for continuity
   */
  public clearSnapped(count: number): void {
    const keepLast = 2;
    if (this.points.length > keepLast) {
      this.points = this.points.slice(-keepLast);
    }
    this.lastSnapTime = Date.now();
    this.totalSnapped += count;
  }

  /**
   * Get vehicle statistics
   */
  public getStats(): VehicleStats {
    return {
      vehicleId: this.vehicleId,
      bufferSize: this.points.length,
      totalReceived: this.totalReceived,
      totalSnapped: this.totalSnapped,
      lastSnapTime: this.lastSnapTime,
    };
  }

  /**
   * Get vehicle ID
   */
  public getVehicleId(): string {
    return this.vehicleId;
  }

  /**
   * Calculate distance between two GPS points using Haversine formula
   */
  private calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 6371000; // Earth radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}

export const gpsBuffer = new GpsBuffer('880e8400-e29b-41d4-a716-446655440002');