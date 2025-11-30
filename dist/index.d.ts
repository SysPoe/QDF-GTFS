export interface Agency {
    agency_id: string;
    agency_name: string;
    agency_url: string;
    agency_timezone: string;
    agency_lang: string;
    agency_phone: string;
    agency_fare_url: string;
    agency_email: string;
}
export interface Route {
    route_id: string;
    agency_id: string;
    route_short_name: string;
    route_long_name: string;
    route_desc: string;
    route_type: number;
    route_url: string;
    route_color: string;
    route_text_color: string;
}
export interface Stop {
    stop_id: string;
    stop_code: string;
    stop_name: string;
    stop_desc: string;
    stop_lat: number;
    stop_lon: number;
    zone_id: string;
    stop_url: string;
    location_type: number;
    parent_station: string;
    stop_timezone: string;
    wheelchair_boarding: number;
    level_id: string;
    platform_code: string;
}
export interface StopTime {
    trip_id: string;
    stop_id: string;
    arrival_time: number;
    departure_time: number;
    stop_sequence: number;
    stop_headsign: string;
    pickup_type: number;
    drop_off_type: number;
    shape_dist_traveled: number;
    timepoint: number;
}
export interface FeedInfo {
    feed_publisher_name: string;
    feed_publisher_url: string;
    feed_lang: string;
    default_lang: string;
    feed_start_date: string;
    feed_end_date: string;
    feed_version: string;
    feed_contact_email: string;
    feed_contact_url: string;
}
export interface Trip {
    trip_id: string;
    route_id: string;
    service_id: string;
    trip_headsign: string;
    trip_short_name: string;
    direction_id: number;
    block_id: string;
    shape_id: string;
    wheelchair_accessible: number;
    bikes_allowed: number;
}
export interface Shape {
    shape_id: string;
    shape_pt_lat: number;
    shape_pt_lon: number;
    shape_pt_sequence: number;
    shape_dist_traveled: number;
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
export interface StopTimeQuery {
    stop_id?: string;
    trip_id?: string;
    date?: string;
    start_time?: number | string;
    end_time?: number | string;
}
export interface GTFSOptions {
    logger?: (msg: string) => void;
    ansi?: boolean;
}
export declare class GTFS {
    private addonInstance;
    private logger?;
    private ansi;
    constructor(options?: GTFSOptions);
    loadFromUrl(url: string): Promise<void>;
    loadFromPath(path: string): Promise<void>;
    loadFromBuffer(buffer: Buffer): Promise<void>;
    getRoutes(): Route[];
    getRoute(routeId: string): Route | null;
    getAgencies(): Agency[];
    getStops(): Stop[];
    getStopTimesForTrip(tripId: string): StopTime[];
    queryStopTimes(query: StopTimeQuery): StopTime[];
    getFeedInfo(): FeedInfo[];
    getTrips(): Trip[];
    getShapes(): Shape[];
    getCalendars(): Calendar[];
    getCalendarDates(): CalendarDate[];
    private download;
}
