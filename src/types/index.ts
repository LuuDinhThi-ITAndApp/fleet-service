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
export interface DriverRequestData {
  driver_image?: string;
  driver_rfid?: string;
}

export interface DriverRequestPayload {
  time_stamp: number;
  message_id: string;
  request_data: DriverRequestData;
}

// Driver Info Types
export interface DriverInformation {
  driver_name: string;
  driver_license_number: string;
}

export interface DriverInfoPayload {
  time_stamp: number;
  message_id: string;
  driver_information: {
    driver_information: DriverInformation;
  };
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
export interface CheckOutConfirmRequestData {
  driver_image?: string;
  driver_rfid?: string;
}

export interface CheckOutConfirmRequestPayload {
  time_stamp: number;
  message_id: string;
  request_data: CheckOutConfirmRequestData;
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
