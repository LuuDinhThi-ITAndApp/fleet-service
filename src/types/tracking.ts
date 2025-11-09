/**
 * Type definitions for Real-time Snap-to-Road Backend
 */

// ============================================================================
// GPS Data Types
// ============================================================================

export interface GpsUpdate {
  vehicleId: string;
  latitude: number;
  longitude: number;
  speed: number;        // m/s
  accuracy: number;     // meters
  timestamp: number;    // Unix timestamp (ms)
}

export interface GpsPoint {
  latitude: number;
  longitude: number;
  speed: number;
  accuracy: number;
  timestamp: number;
}

// ============================================================================
// OSRM API Types
// ============================================================================

export interface OsrmMatchRequest {
  coordinates: string;
  radiuses: string;
  overview: string;
  geometries: string;
  gaps: string;
  tidy: string;
  annotations: string;
}

export interface OsrmMatchResponse {
  code: string;
  message?: string;
  matchings?: OsrmMatching[];
}

export interface OsrmMatching {
  geometry: GeoJsonGeometry;
  confidence: number;
  distance: number;      // meters
  duration: number;      // seconds
  weight?: number;
  legs?: any[];
}

export interface GeoJsonGeometry {
  type: 'LineString';
  coordinates: [number, number][]; // [lng, lat][]
}

// ============================================================================
// Snap Result Types
// ============================================================================

export interface SnapResult {
  vehicleId: string;
  timestamp: number;
  result: SnapResultData;
  stats: VehicleStats;
}

export interface SnapResultData {
  success: boolean;
  geometry?: GeoJsonGeometry;
  confidence?: number;
  distance?: number;
  duration?: number;
  originalPointsCount: number;
  snappedPointsCount?: number;
  error?: string;
}

// ============================================================================
// Vehicle Buffer & Stats Types
// ============================================================================

export interface VehicleStats {
  vehicleId: string;
  bufferSize: number;
  totalReceived: number;
  totalSnapped: number;
  lastSnapTime: number;
}

export interface BufferConfig {
  minDistance: number;  // meters
  bufferSize: number;
  timeoutMs: number;
}

// ============================================================================
// WebSocket Message Types
// ============================================================================

export type SocketEvent =
  | 'gps:update'
  | 'gps:raw'
  | 'gps:snapped'
  | 'gps:forceSnap'
  | 'vehicle:stats'
  | 'connection'
  | 'disconnect';

export interface RawGpsBroadcast {
  vehicleId: string;
  latitude: number;
  longitude: number;
  speed: number;
  accuracy: number;
  timestamp: number;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface AppConfig {
  osrmUrl: string;
  port: number;
  bufferSize: number;
  bufferTimeoutMs: number;
  minDistanceMeters: number;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface HealthResponse {
  status: string;
  osrmUrl: string;
  osrmHealthy: boolean;
  activeVehicles: number;
  bufferSize: number;
  uptime: number;
}

export interface VehiclesResponse {
  count: number;
  vehicles: VehicleStats[];
}

export interface ErrorResponse {
  error: string;
  message?: string;
}

// ============================================================================
// Service Interfaces
// ============================================================================

export interface IGpsBuffer {
  addPoint(point: GpsPoint): boolean;
  shouldSnap(bufferSize: number, timeoutMs: number): boolean;
  getPoints(): GpsPoint[];
  clearSnapped(count: number): void;
  getStats(): VehicleStats;
}

export interface IOsrmClient {
  snapToRoad(points: GpsPoint[]): Promise<SnapResultData>;
  healthCheck(): Promise<boolean>;
}