
// Enums

export enum RouteType {
    Tram = 0,
    Subway = 1,
    Rail = 2,
    Bus = 3,
    Ferry = 4,
    CableTram = 5,
    AerialLift = 6,
    Funicular = 7,
    Trolleybus = 11,
    Monorail = 12
}

export enum LocationType {
    Stop = 0,
    Station = 1,
    EntranceExit = 2,
    GenericNode = 3,
    BoardingArea = 4
}

export enum WheelchairBoarding {
    NoInfo = 0,
    Accessible = 1,
    NotAccessible = 2
}

export enum PickupType {
    Regular = 0,
    None = 1,
    Phone = 2,
    Driver = 3
}

export enum DropOffType {
    Regular = 0,
    None = 1,
    Phone = 2,
    Driver = 3
}

export enum ContinuousPickup {
    Continuous = 0,
    None = 1,
    Phone = 2,
    Driver = 3
}

export enum ContinuousDropOff {
    Continuous = 0,
    None = 1,
    Phone = 2,
    Driver = 3
}

export enum WheelchairAccessible {
    NoInfo = 0,
    Accessible = 1,
    NotAccessible = 2
}

export enum BikesAllowed {
    NoInfo = 0,
    Allowed = 1,
    NotAllowed = 2
}

// Realtime Enums

export enum TripScheduleRelationship {
    SCHEDULED = 0,
    ADDED = 1,
    UNSCHEDULED = 2,
    CANCELED = 3,
    DUPLICATED = 4,
    REPLACEMENT = 5
}

export enum StopTimeScheduleRelationship {
    SCHEDULED = 0,
    SKIPPED = 1,
    NO_DATA = 2,
    UNSCHEDULED = 3
}

export enum VehicleStopStatus {
    INCOMING_AT = 0,
    STOPPED_AT = 1,
    IN_TRANSIT_TO = 2
}

export enum CongestionLevel {
    UNKNOWN_CONGESTION_LEVEL = 0,
    RUNNING_SMOOTHLY = 1,
    STOP_AND_GO = 2,
    CONGESTION = 3,
    SEVERE_CONGESTION = 4
}

export enum OccupancyStatus {
    EMPTY = 0,
    MANY_SEATS_AVAILABLE = 1,
    FEW_SEATS_AVAILABLE = 2,
    STANDING_ROOM_ONLY = 3,
    CRUSHED_STANDING_ROOM_ONLY = 4,
    FULL = 5,
    NOT_ACCEPTING_PASSENGERS = 6
}

export enum AlertCause {
    UNKNOWN_CAUSE = 1,
    OTHER_CAUSE = 2,
    TECHNICAL_PROBLEM = 3,
    STRIKE = 4,
    DEMONSTRATION = 5,
    ACCIDENT = 6,
    HOLIDAY = 7,
    WEATHER = 8,
    MAINTENANCE = 9,
    CONSTRUCTION = 10,
    POLICE_ACTIVITY = 11,
    MEDICAL_EMERGENCY = 12
}

export enum AlertEffect {
    NO_SERVICE = 1,
    REDUCED_SERVICE = 2,
    SIGNIFICANT_DELAYS = 3,
    DETOUR = 4,
    ADDITIONAL_SERVICE = 5,
    MODIFIED_SERVICE = 6,
    OTHER_EFFECT = 7,
    UNKNOWN_EFFECT = 8,
    STOP_MOVED = 9,
    NO_EFFECT = 10,
    ACCESSIBILITY_ISSUE = 11
}

export enum AlertSeverityLevel {
    UNKNOWN_SEVERITY = 1,
    INFO = 2,
    WARNING = 3,
    SEVERE = 4
}

export enum GTFSMergeStrategy {
    OVERWRITE = 0, // Overwrite existing IDs
    IGNORE = 1,    // Ignore if ID exists
    THROW = 2      // Throw error if ID exists
}

export interface GTFSFeedConfig {
    url: string;
    headers?: Record<string, string>;
}

export interface Agency {
    agency_id: string | null;
    agency_name: string;
    agency_url: string;
    agency_timezone: string;
    agency_lang: string | null;
    agency_phone: string | null;
    agency_fare_url: string | null;
    agency_email: string | null;
}

export interface Route {
    route_id: string;
    agency_id: string | null;
    route_short_name: string | null;
    route_long_name: string | null;
    route_desc: string | null;
    route_type: RouteType;
    route_url: string | null;
    route_color: string | null;
    route_text_color: string | null;
    continuous_pickup: ContinuousPickup | null;
    continuous_drop_off: ContinuousDropOff | null;
    route_sort_order: number | null;
    network_id: string | null;
}

export interface Stop {
    stop_id: string;
    stop_code: string | null;
    stop_name: string;
    stop_desc: string | null;
    stop_lat: number | null;
    stop_lon: number | null;
    zone_id: string | null;
    stop_url: string | null;
    location_type: LocationType | null;
    parent_station: string | null;
    stop_timezone: string | null;
    wheelchair_boarding: WheelchairBoarding | null;
    level_id: string | null;
    platform_code: string | null;
    tts_stop_name?: string | null;
}

export interface StopTime {
    trip_id: string;
    stop_id: string;
    arrival_time: number | null; // Seconds since midnight (null when missing)
    departure_time: number | null; // Seconds since midnight (null when missing)
    stop_sequence: number;
    stop_headsign: string | null;
    pickup_type: PickupType;
    drop_off_type: DropOffType;
    shape_dist_traveled: number | null;
    timepoint: number | null;
    continuous_pickup: ContinuousPickup | null;
    continuous_drop_off: ContinuousDropOff | null;
}

export interface FeedInfo {
    feed_publisher_name: string;
    feed_publisher_url: string;
    feed_lang: string;
    default_lang: string | null;
    feed_start_date: string | null;
    feed_end_date: string | null;
    feed_version: string | null;
    feed_contact_email: string | null;
    feed_contact_url: string | null;
}

export interface Trip {
    trip_id: string;
    route_id: string;
    service_id: string;
    trip_headsign: string | null;
    trip_short_name: string | null;
    direction_id: number | null;
    block_id: string | null;
    shape_id: string | null;
    wheelchair_accessible: WheelchairAccessible | null;
    bikes_allowed: BikesAllowed | null;
}

export interface Shape {
    shape_id: string;
    shape_pt_lat: number;
    shape_pt_lon: number;
    shape_pt_sequence: number;
    shape_dist_traveled: number | null;
}

export interface Calendar {
    service_id: string;
    monday: boolean;
    tuesday: boolean;
    wednesday: boolean;
    thursday: boolean;
    friday: boolean;
    saturday: boolean;
    sunday: boolean;
    start_date: string;
    end_date: string;
}

export interface CalendarDate {
    service_id: string;
    date: string;
    exception_type: number;
}

export interface RealtimeStopTimeUpdate {
    stop_sequence: number | null;
    stop_id: string;
    trip_id: string;
    start_date: string | null;
    start_time: string | null;
    arrival_delay: number | null;
    arrival_time: number | null;
    arrival_uncertainty: number | null;
    departure_delay: number | null;
    departure_time: number | null;
    departure_uncertainty: number | null;
    schedule_relationship: StopTimeScheduleRelationship;
}

export interface RealtimeUpdateTripInfo {
    trip_id: string;
    route_id: string;
    direction_id: number | null;
    start_time: string;
    start_date: string | null;
    schedule_relationship: TripScheduleRelationship;
}

export interface RealtimeTripUpdate {
    update_id: string;
    is_deleted: boolean;
    trip: RealtimeUpdateTripInfo;
    vehicle: {
        id: string;
        label: string;
        license_plate: string;
    };
    stop_time_updates: RealtimeStopTimeUpdate[];
    timestamp: number | null;
    delay: number | null;
}

export interface RealtimeVehiclePosition {
    update_id: string;
    is_deleted: boolean;
    trip: RealtimeUpdateTripInfo;
    vehicle: {
        id: string;
        label: string;
        license_plate: string;
    };
    position: {
        latitude: number;
        longitude: number;
        bearing: number | null;
        odometer: number | null;
        speed: number | null;
    };
    current_stop_sequence: number | null;
    stop_id: string;
    current_status: VehicleStopStatus | null;
    timestamp: number | null;
    congestion_level: CongestionLevel | null;
    occupancy_status: OccupancyStatus | null;
    occupancy_percentage: number | null;
}

export interface RealtimeAlert {
    update_id: string;
    is_deleted: boolean;
    cause: AlertCause | null;
    effect: AlertEffect | null;
    url: string;
    header_text: string;
    description_text: string;
    severity_level: AlertSeverityLevel | null;
}

export interface StopTimeQuery {
    stop_id?: string;
    trip_id?: string;
    date?: string; // YYYYMMDD
    start_time?: number | string; // Seconds or HH:MM:SS
    end_time?: number | string; // Seconds or HH:MM:SS
    dateMode?: "timestamp" | "gtfs_date";
}

export interface ProgressInfo {
    task: string;
    total: number;
    current: number;
    percent: number;
    speed?: number; // bytes/sec
    eta?: number; // seconds
}

export interface GTFSOptions {
    logger?: (msg: string) => void;
    progress?: (info: ProgressInfo) => void;
    ansi?: boolean;
    cacheDir?: string;
    cache?: boolean;
    mergeStrategy?: GTFSMergeStrategy;
}

// Helper fns
export function formatTimestamp(ts?: number | null): string {
    if (ts === null || ts === undefined) return "--:--";
    let h = Math.floor(ts / 3600);
    let m = Math.floor((ts % 3600) / 60);
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}
