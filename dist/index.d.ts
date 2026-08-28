import { Agency, Route, Stop, StopTime, TripStopTimeBounds, FeedInfo, Trip, Transfer, Shape, Calendar, CalendarDate, RealtimeTripUpdate, RealtimeVehiclePosition, RealtimeAlert, StopTimeQuery, TripQuery, GTFSOptions, GTFSFeedConfig, GTFSRealtimeFeedConfig, GTFSStaticLoadResult, GTFSRealtimeLoadResult, GTFSRealtimeUpdateResult, GTFSActions, QualifiedEntityId, RealtimeFilter, TransferQuery, StaticOccupancy, StaticOccupancyQuery } from './types.js';
export * from './types.js';
/**
 * Decode carriage details from a standalone vehicle feed.
 *
 * @deprecated GTFS.updateRealtime parses these details natively. Keep this
 * helper for callers that still decode a raw vehicle feed directly.
 */
export declare function parseGtfsRtMultiCarriageDetails(feed: Buffer): Map<string, import('./types.js').RealtimeCarriageDetails[]>;
/** Extract one file from a ZIP without adding a second ZIP dependency. */
export declare function extractZipEntry(archive: Buffer, requestedEntry: string): Buffer;
export declare class GTFS {
    private addonInstance;
    private logger?;
    private progressCallback?;
    private ansi;
    private cacheDir?;
    private cache;
    private mergeStrategy;
    private lastProgressUpdate;
    private filesToLoad?;
    private skipStopTimes;
    private cacheMaxAgeMs;
    private staleIfError;
    private requestTimeoutMs;
    private serviceDatesCache;
    private serviceDatesSets;
    private serviceIdsByDateCache;
    private tripsByServiceIdCache;
    actions: GTFSActions;
    constructor(options?: GTFSOptions);
    private showProgress;
    loadStatic(feeds: GTFSFeedConfig[] | GTFSFeedConfig): Promise<GTFSStaticLoadResult[]>;
    loadFromPath(paths: string[], feedIds: string[]): Promise<void>;
    loadFromBuffers(buffers: Buffer[], feedIds: string[]): Promise<void>;
    getRoutes(filter?: Partial<Route>): Route[];
    getAgencies(filter?: Partial<Agency>): Agency[];
    getStops(filter?: Partial<Stop>): Stop[];
    getStopTimes(query?: StopTimeQuery): StopTime[];
    getTripStopTimeBounds(): TripStopTimeBounds[];
    getStaticOccupancies(query: StaticOccupancyQuery): StaticOccupancy[];
    getFeedInfo(): FeedInfo[];
    private qualifiedKey;
    private getServiceDatesMap;
    private getTripsByServiceId;
    getTrips(filter?: TripQuery | Partial<Trip>): Trip[];
    getTransfers(filter?: TransferQuery | Partial<Transfer>): Transfer[];
    getShapes(filter?: Partial<Shape>): Shape[];
    getCalendars(filter?: Partial<Calendar>): Calendar[];
    getCalendarDates(filter?: Partial<CalendarDate>): CalendarDate[];
    getServiceDates(service: QualifiedEntityId): string[];
    getServiceDatesByTrip(trip: QualifiedEntityId): string[];
    /** Replace the supplied realtime source and return compact change metadata. */
    updateRealtime(input: {
        kind: GTFSRealtimeFeedConfig["kind"];
        data: Buffer | Buffer[];
        targetFeedId: string;
        sourceId: string;
    }): GTFSRealtimeUpdateResult;
    updateRealtimeFromUrl(sources: GTFSRealtimeFeedConfig[]): Promise<GTFSRealtimeLoadResult[]>;
    getRealtimeTripUpdates(filter?: RealtimeFilter): RealtimeTripUpdate[];
    getRealtimeVehiclePositions(filter?: RealtimeFilter): RealtimeVehiclePosition[];
    getRealtimeAlerts(filter?: RealtimeFilter): RealtimeAlert[];
    clearRealtime(filter?: {
        targetFeedId?: string;
        sourceId?: string;
    }): void;
    private download;
}
