// Enum for MQTT topics
export enum MqttTopic {
  GpsData = "operation_monitoring/gps_data",
  DriverRequest = "driving_session/driver_request",
  DriverCheckIn = "driving_session/driver_checkin",
  CheckOutConfirmRequest = "driving_session/driver_checkout_confirm_request",
  DriverCheckOut = "driving_session/driver_checkout",
  ParkingState = "driving_session/parking_state",
  DrivingTime = "driving_session/continuous_driving_time",
  VehicleOperationManager = "driving_session/vehicle_operation_manager",
  DMS = "/DMS",
  OMS = "/OMS",
  StreamingEvent = "driving_session/streamming_event",
  Emergency = "/emergency",
  EnrollBiometric = "driving_session/driver_enrollment",
}