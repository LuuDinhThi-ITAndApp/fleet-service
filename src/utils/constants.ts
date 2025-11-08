export enum VehicleState {
    OFF = 'Off',
    IDLE = 'Idle',
    MOVING = 'Working',
    PARKED = 'Parked',
    UNKNOWN = 'Unknown',
    COMPLETED = 'Completed',
}

export enum CacheKeys {
    DEVICE_STATE_PREFIX = 'device:',
    LATEST_EVENTS = 'latest_events',
    DRIVER_CHECKIN= 'driver_checkin',
    DRIVER_CHECKOUT= 'driver_checkout',
    TRIP_CREATED = 'trip_created',
    TRIP_COMPLETED= 'trip_completed',
    VEHICLE_STATE = 'vehicle_state',
    CHECKOUT_CONFIR_REQUEST = 'checkout_confirm_request',

}