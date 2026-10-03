import { Agency, Route, Stop, StopTime, TripStopTimeBounds, FeedInfo, Trip, Transfer, Frequency, Shape, Calendar, CalendarDate, RealtimeTripUpdate, RealtimeVehiclePosition, RealtimeAlert, StopTimeQuery, TripQuery, GTFSOptions, GTFSFeedConfig, GTFSRealtimeFeedConfig, GTFSStaticLoadResult, GTFSRealtimeLoadResult, GTFSRealtimeUpdateResult, GTFSActions, QualifiedEntityId, RealtimeFilter, TransferQuery, StaticOccupancy, StaticOccupancyQuery, PackedStopTimes, RealtimeChangedTrip, FetchedRealtimeSource, RealtimeFetchOptions, PackedShapes } from './types.js';
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
export declare function isNonPublicAddress(address: string): boolean;
export declare class GTFS {
    private addonInstance;
    private logger?;
    private progressCallback?;
    private ansi;
    private cacheDir?;
    private cache;
    private compiledCache;
    private mergeStrategy;
    private lastProgressUpdate;
    private lastProgressByTask;
    private filesToLoad?;
    private skipStopTimes;
    private cacheMaxAgeMs;
    private staleIfError;
    private requestTimeoutMs;
    private realtimeTimeoutMs;
    private maxDownloadBytes;
    private maxExtractedEntryBytes;
    private serviceDatesCache;
    private lastChangedTripIds;
    private lastRealtimeRevision;
    actions: GTFSActions;
    constructor(options?: GTFSOptions);
    private showProgress;
    private realtimeDeadlineMs;
    /**
     * Try the primary URL then each fallback in order, using the same headers
     * and progress task. Only the last failure is thrown so stale-cache
     * handling sees the most relevant error.
     */
    private downloadWithFallbacks;
    loadStatic(feeds: GTFSFeedConfig[] | GTFSFeedConfig): Promise<GTFSStaticLoadResult[]>;
    loadFromPath(paths: string[], feedIds: string[]): Promise<void>;
    loadFromBuffers(buffers: Buffer[], feedIds: string[]): Promise<void>;
    private parseBuffers;
    private pruneCompiledSnapshots;
    /** Validate and load a static binary without blocking the JS event loop. */
    loadCompiledSnapshotAsync(filePath: string): Promise<void>;
    getSnapshotRevision(): {
        realtime_revision: number;
        stop_time_count: number;
        trip_count: number;
    };
    getStaticSnapshotInfo(): {
        stop_time_count: number;
        trip_count: number;
        realtime_revision: number;
    };
    saveCompiledSnapshot(filePath: string): void;
    loadCompiledSnapshot(filePath: string): void;
    getRoutes(filter?: Partial<Route>): Route[];
    getAgencies(filter?: Partial<Agency>): Agency[];
    getStops(filter?: Partial<Stop>): Stop[];
    getStopTimes(query?: StopTimeQuery): StopTime[];
    getStopTimesPacked(query: Pick<StopTimeQuery, "trip_id" | "trip_ids" | "feed_id"> & {
        fields?: string[];
    }): PackedStopTimes;
    getTripStopTimeBounds(): TripStopTimeBounds[];
    clearStatic(): void;
    getStaticOccupancies(query: StaticOccupancyQuery): StaticOccupancy[];
    getFeedInfo(): FeedInfo[];
    private qualifiedKey;
    private getServiceDatesMap;
    getTrips(filter?: TripQuery | Partial<Trip>): Trip[];
    getTransfers(filter?: TransferQuery | Partial<Transfer>): Transfer[];
    getFrequencies(filter?: {
        trip_id?: string;
        feed_id?: string;
    }): Frequency[];
    getShapes(filter?: Partial<Shape>): Shape[];
    getShapesPacked(filter?: Partial<Pick<Shape, 'feed_id' | 'shape_id'>>): PackedShapes;
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
    getLastChangedTripIds(): RealtimeChangedTrip[];
    getRealtimeRevision(): number;
    /**
     * Fetch phase: download every source concurrently without touching the
     * snapshot. Results keep `sources` order. Protobuf decoding still happens
     * inside the native commit; only transport is overlapped here.
     * The whole aggregate is bounded by a total deadline (`timeoutMs` override
     * or `realtimeTimeoutMs`/`requestTimeoutMs`); per-request timeouts still
     * apply to each download. Fallback URLs are tried in order per source.
     */
    fetchRealtimeSources(sources: GTFSRealtimeFeedConfig[], options?: RealtimeFetchOptions): Promise<FetchedRealtimeSource[]>;
    /**
     * Commit phase: apply prefetched payloads serially in array order, so the
     * resulting snapshot is independent of download completion order. Failed
     * fetches are reported without mutating the snapshot.
     */
    applyRealtimePayloads(fetched: FetchedRealtimeSource[]): GTFSRealtimeLoadResult[];
    updateRealtimeFromUrl(sources: GTFSRealtimeFeedConfig[], options?: RealtimeFetchOptions): Promise<GTFSRealtimeLoadResult[]>;
    getRealtimeTripUpdates(filter?: RealtimeFilter): RealtimeTripUpdate[];
    getRealtimeVehiclePositions(filter?: RealtimeFilter): RealtimeVehiclePosition[];
    getRealtimeAlerts(filter?: RealtimeFilter): RealtimeAlert[];
    clearRealtime(filter?: {
        targetFeedId?: string;
        sourceId?: string;
    }): void;
    private download;
}
