// GPS Data Types
export interface GPSDataPoint {
  gps_timestamp: number;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number;
}

export interface GPSDataPayload {
  time_stamp: number;
  message_id: string;
  gps_data: GPSDataPoint[];
}

// General Event Types
export interface EdgeEvent {
  device_id: string;
  timestamp: Date;
  event_type: string;
  data: Record<string, any>;
  metadata?: {
    location?: string;
    firmware_version?: string;
    [key: string]: any;
  };
}

export interface CachedDeviceState {
  device_id: string;
  last_seen: Date;
  last_event: EdgeEvent;
  status: 'online' | 'offline';
}

export interface MQTTMessage {
  topic: string;
  payload: Buffer;
  qos: 0 | 1 | 2;
  retain: boolean;
}

export interface DatabaseRow {
  id?: number;
  device_id: string;
  timestamp: Date;
  event_type: string;
  data: any;
  metadata: any;
  created_at?: Date;
}

// GPS Database Row
export interface GPSDataRow {
  id?: number;
  device_id: string;
  message_id: string;
  timestamp: Date;
  gps_timestamp: Date;
  latitude: number;
  longitude: number;
  accuracy: number;
  gnss_status: boolean;
  created_at?: Date;
}

// Driver Request Types
export interface DriverRequestPayload {
  time_stamp: number;
  message_id: string;
  driver_id: string;
}

// Driver Info Types
export interface DriverInformation {
  driver_name: string;
  driver_license_number: string;
}

export interface DriverInfoPayload {
  time_stamp: number;
  message_id: string;
  driver_information:  DriverInformation;
}

// Driver Check-in Types
export interface CheckInLocation {
  gps_timestamp: number;
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface CheckInData {
  driver_information: {
    driver_name: string;
    driver_license_number: string;
  };
  check_in_timestamp: number;
  CheckInLocation: CheckInLocation;
}

export interface DriverCheckInPayload {
  time_stamp: number;
  message_id: string;
  check_in_data: CheckInData;
}

// Driver Check-out Confirm Request Types
export interface CheckOutConfirmRequestPayload {
  time_stamp: number;
  message_id: string;
  driver_id: string;
}

// Driver Check-out Confirm Response Types
export interface CheckOutConfirmRespondData {
  is_confirm: boolean;
}

export interface CheckOutConfirmResponsePayload {
  time_stamp: number;
  message_id: string;
  respond_data: CheckOutConfirmRespondData;
}

// Driver Check-out Types
export interface CheckOutLocation {
  gps_timestamp: number;
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface CheckOutData {
  driver_information: {
    driver_name: string;
    driver_license_number: string;
  };
  working_duration: number;
  check_out_timestamp: number;
  CheckOutLocation: CheckOutLocation;
}

export interface DriverCheckOutPayload {
  time_stamp: number;
  message_id: string;
  check_out_data: CheckOutData;
}


export interface ParkingStateEvent {
  time_stamp: number;
  message_id: string;
  parking_id: string;
  parking_duration: number;
  parking_status: number; // 0 = parked, 1 = unparked
}

export interface DrivingTimeEvent {
  time_stamp: number;
  message_id: string;
  continuous_driving_time: number; // Unit: seconds
  driving_duration: number; // Total driving time in a day. Unit: seconds
}

export interface VehicleOperationManagerEvent {
  time_stamp: number;
  message_id: string;
  violation_operation: {
    continuous_driving_time_violate: number; // in minutes
    parking_duration_violate: number; // in minutes
    speed_limit_violate: number; // in km/h
  };
}

// DMS (Driver Monitoring System) Types
export interface DMSViolationInfo {
  gps_timestamp: number;
  latitude: number;
  longitude: number;
  speed: number;
  Violation_DMS: "0" | "1" | "2" | "3" | "4" | "5"; // 0-None, 1-PhoneUse, 2-Drowness, 3-Smoking, 4-Unfocus, 5-Handoff
  image_data: string; // Binary/base64 encoded image data in JPEG format
}

export interface DMSDriverInformation {
  driver_name: string;
  driver_license_number: string;
}

export interface DMSPayload {
  time_stamp: number;
  message_id: string;
  violate_infomation_DMS: DMSViolationInfo;
  driver_information: DMSDriverInformation;
}

// OMS (Operational Monitoring System) Types
export interface OMSViolationInfo {
  gps_timestamp: number;
  latitude: number;
  longitude: number;
  speed: number;
  Violation_OMS: "0" | "1"; // 0-None, 1-Unfasten_seat_belt
  image_data: string; // Binary/base64 encoded image data in JPEG format
}

export interface OMSPayload {
  time_stamp: number;
  message_id: string;
  violate_infomation_OMS: OMSViolationInfo;
  driver_information: DMSDriverInformation;
}

// Streaming Event Types
export interface StreamingEventPayload {
  time_stamp: number;
  message_id: string;
  streamming_state: 0 | 1 | 2 | 3; // 0=Oms, 1=Dms, 2=Dash, 3=Off
}