import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as os from 'os';
import * as crypto from 'crypto';
import { inflateRawSync } from 'zlib';
import {
    Agency, Route, Stop, StopTime, TripStopTimeBounds, FeedInfo, Trip, Transfer, Shape, Calendar, CalendarDate,
    RealtimeTripUpdate, RealtimeVehiclePosition, RealtimeAlert, StopTimeQuery, TripQuery, GTFSOptions, ProgressInfo,
    GTFSMergeStrategy, GTFSFeedConfig, GTFSRealtimeFeedConfig, GTFSStaticLoadResult, GTFSRealtimeLoadResult, GTFSRealtimeUpdateResult, GTFSActions, QualifiedEntityId,
    RealtimeFilter, TransferQuery, StaticOccupancy, StaticOccupancyQuery, PackedStopTimes, RealtimeChangedTrip, FetchedRealtimeSource
} from './types.js';

export * from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const r = createRequire(import.meta.url);

let GTFSAddon: any;
try {
    try {
        const binding = r(path.join(__dirname, './build/Release/gtfs_addon.node'));
        GTFSAddon = binding.GTFSAddon;
    } catch (e) {
        try {
            const binding = r(path.join(__dirname, '../build/Release/gtfs_addon.node'));
            GTFSAddon = binding.GTFSAddon;
        } catch (e2) {
            if (process.env.NODE_ENV === 'test') {
                GTFSAddon = class MockAddon {
                    loadFromBuffers() { }
                    getFeedInfo() { return []; }
                    getRoutes() { return []; }
                    getAgencies() { return []; }
                    getStops() { return []; }
                    getStopTimes() { return []; }
                    getStopTimesPacked() {
                        return {
                            strings: [], tripIds: new Uint32Array(), stopIds: new Uint32Array(),
                            arrivalTimes: new Int32Array(), departureTimes: new Int32Array(),
                            stopSequences: new Int32Array(), stopHeadsigns: new Uint32Array(),
                            pickupTypes: new Uint8Array(), dropOffTypes: new Uint8Array(),
                            shapeDistances: new Float64Array(), timepoints: new Int8Array(),
                            continuousPickups: new Int8Array(), continuousDropOffs: new Int8Array(),
                            feedIds: new Uint32Array(),
                        };
                    }
                    getTripStopTimeBounds() { return []; }
                    getStaticOccupancies() { return []; }
                    getTrips() { return []; }
                    getTransfers() { return []; }
                    getShapes() { return []; }
                    getCalendars() { return []; }
                    getCalendarDates() { return []; }
                    updateRealtime() {
                        return { changed_trip_ids: [], trip_update_count: 0, stop_time_update_count: 0, vehicle_count: 0, realtime_revision: 0 };
                    }
                    getRealtimeTripUpdates() { return []; }
                    getRealtimeVehiclePositions() { return []; }
                    getRealtimeAlerts() { return []; }
                    clearStatic() { }
                };
            } else {
                throw e;
            }
        }
    }
} catch (e) {
    console.error("Could not load native addon");
    throw e;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)).toFixed(2) + ' ' + sizes[i];
}

function formatDuration(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return "--:--";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function readVarint(buffer: Buffer, cursor: { offset: number }): number {
    let value = 0, shift = 0;
    while (cursor.offset < buffer.length && shift < 53) {
        const byte = buffer[cursor.offset++];
        value += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return value;
        shift += 7;
    }
    throw new Error('Invalid GTFS-RT protobuf varint');
}

function protobufMessages(buffer: Buffer, fieldNumber: number): Buffer[] {
    const result: Buffer[] = [], cursor = { offset: 0 };
    while (cursor.offset < buffer.length) {
        const tag = readVarint(buffer, cursor), field = Math.floor(tag / 8), wire = tag & 7;
        if (wire === 0) readVarint(buffer, cursor);
        else if (wire === 1) cursor.offset += 8;
        else if (wire === 2) {
            const length = readVarint(buffer, cursor), end = cursor.offset + length;
            if (end > buffer.length) throw new Error('Truncated GTFS-RT protobuf field');
            if (field === fieldNumber) result.push(buffer.subarray(cursor.offset, end));
            cursor.offset = end;
        } else if (wire === 5) cursor.offset += 4;
        else throw new Error(`Unsupported GTFS-RT protobuf wire type ${wire}`);
    }
    return result;
}

function protobufScalar(buffer: Buffer, fieldNumber: number): number | null {
    const cursor = { offset: 0 };
    while (cursor.offset < buffer.length) {
        const tag = readVarint(buffer, cursor), field = Math.floor(tag / 8), wire = tag & 7;
        if (wire === 0) {
            const value = readVarint(buffer, cursor);
            if (field === fieldNumber) return value;
        } else if (wire === 1) cursor.offset += 8;
        else if (wire === 2) {
            const length = readVarint(buffer, cursor);
            cursor.offset += length;
        } else if (wire === 5) cursor.offset += 4;
        else throw new Error(`Unsupported GTFS-RT protobuf wire type ${wire}`);
    }
    return null;
}

function protobufString(buffer: Buffer, fieldNumber: number): string {
    return protobufMessages(buffer, fieldNumber)[0]?.toString('utf8') ?? '';
}

/**
 * Decode carriage details from a standalone vehicle feed.
 *
 * @deprecated GTFS.updateRealtime parses these details natively. Keep this
 * helper for callers that still decode a raw vehicle feed directly.
 */
export function parseGtfsRtMultiCarriageDetails(
    feed: Buffer,
): Map<string, import('./types.js').RealtimeCarriageDetails[]> {
    const result = new Map<string, import('./types.js').RealtimeCarriageDetails[]>();
    for (const entity of protobufMessages(feed, 2)) {
        const id = protobufString(entity, 1);
        const vehicle = protobufMessages(entity, 4)[0];
        if (!id || !vehicle) continue;
        const carriages = protobufMessages(vehicle, 11).map((carriage) => ({
            id: protobufString(carriage, 1),
            label: protobufString(carriage, 2),
            occupancy_status: protobufScalar(carriage, 3) as import('./types.js').OccupancyStatus | null,
            occupancy_percentage: protobufScalar(carriage, 4),
            carriage_sequence: protobufScalar(carriage, 5),
        }));
        if (carriages.length) result.set(id, carriages);
    }
    return result;
}

/** Extract one file from a ZIP without adding a second ZIP dependency. */
export function extractZipEntry(archive: Buffer, requestedEntry: string): Buffer {
    const entry = requestedEntry.replace(/^\/+/, '');
    if (!entry || entry.includes('\\')) throw new Error(`Invalid ZIP archive entry '${requestedEntry}'`);

    // Locate EOCD in the final 64 KiB plus its fixed-size header.
    const firstPossibleEocd = Math.max(0, archive.length - 65_557);
    let eocd = -1;
    for (let offset = archive.length - 22; offset >= firstPossibleEocd; offset--) {
        if (archive.readUInt32LE(offset) === 0x06054b50) {
            eocd = offset;
            break;
        }
    }
    if (eocd < 0) throw new Error('Downloaded file is not a valid ZIP archive (end record missing)');

    const entryCount = archive.readUInt16LE(eocd + 10);
    const centralOffset = archive.readUInt32LE(eocd + 16);
    let offset = centralOffset;
    for (let index = 0; index < entryCount; index++) {
        if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50)
            throw new Error('Downloaded ZIP has an invalid central directory');
        const compression = archive.readUInt16LE(offset + 10);
        const compressedSize = archive.readUInt32LE(offset + 20);
        const uncompressedSize = archive.readUInt32LE(offset + 24);
        const nameLength = archive.readUInt16LE(offset + 28);
        const extraLength = archive.readUInt16LE(offset + 30);
        const commentLength = archive.readUInt16LE(offset + 32);
        const localOffset = archive.readUInt32LE(offset + 42);
        const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/^\/+/, '');

        if (name === entry) {
            if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50)
                throw new Error(`ZIP archive entry '${entry}' has an invalid local header`);
            const localNameLength = archive.readUInt16LE(localOffset + 26);
            const localExtraLength = archive.readUInt16LE(localOffset + 28);
            const dataStart = localOffset + 30 + localNameLength + localExtraLength;
            const compressed = archive.subarray(dataStart, dataStart + compressedSize);
            if (compressed.length !== compressedSize)
                throw new Error(`ZIP archive entry '${entry}' is truncated`);
            const result = compression === 0 ? Buffer.from(compressed) : compression === 8 ? inflateRawSync(compressed) : null;
            if (!result) throw new Error(`ZIP archive entry '${entry}' uses unsupported compression method ${compression}`);
            if (result.length !== uncompressedSize)
                throw new Error(`ZIP archive entry '${entry}' has an invalid uncompressed size`);
            return result;
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    throw new Error(`ZIP archive entry '${entry}' was not found`);
}

const SNAPSHOT_VERSION = 2;
const SNAPSHOT_MAGIC = "QDFS";

/** Bound on concurrent static source acquisitions (cache I/O + download). */
const STATIC_ACQUIRE_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` tasks in flight, preserving order. */
async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    if (items.length === 0) return results;
    let next = 0;
    const workerCount = Math.min(Math.max(limit, 1), items.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

export class GTFS {
    private addonInstance: any;
    private logger?: (msg: string) => void;
    private progressCallback?: (info: ProgressInfo) => void;
    private ansi: boolean;
    private cacheDir?: string;
    private cache: boolean;
    private mergeStrategy: GTFSMergeStrategy;
    private lastProgressUpdate: number = 0;
    private lastProgressByTask = new Map<string, number>();
    private filesToLoad?: string[];
    private skipStopTimes: boolean;
	private cacheMaxAgeMs: number;
	private staleIfError: boolean;
	private requestTimeoutMs: number;
    private serviceDatesCache: Map<string, string[]> | null = null;
    private serviceDatesSets: Map<string, Set<string>> | null = null;
    private serviceIdsByDateCache: Map<string, QualifiedEntityId[]> | null = null;
    private tripsByServiceIdCache: Map<string, Trip[]> | null = null;
    private lastChangedTripIds: RealtimeChangedTrip[] = [];
    private lastRealtimeRevision: number = 0;
    public actions: GTFSActions = {
        mergeStops: (targetStopId: string, sourceStopIds: string[], feed_id: string) => {
            this.addonInstance.mergeStops(targetStopId, sourceStopIds, feed_id);
        },
        updateStop: (stop_id: string, partialStop: Partial<Stop>, feed_id: string) => {
            return this.addonInstance.updateStop(stop_id, partialStop, feed_id);
        }
    };


    constructor(options?: GTFSOptions) {
        this.addonInstance = new GTFSAddon();
        this.logger = options?.logger;
        this.progressCallback = options?.progress;
        this.ansi = options?.ansi || false;
        this.cacheDir = options?.cacheDir;
        this.cache = options?.cache || false;
        this.mergeStrategy = options?.mergeStrategy !== undefined ? options.mergeStrategy : GTFSMergeStrategy.OVERWRITE;
        this.filesToLoad = options?.filesToLoad;
        this.skipStopTimes = options?.skipStopTimes || false;
		this.cacheMaxAgeMs = options?.cacheMaxAgeMs ?? 24 * 60 * 60 * 1000;
		this.staleIfError = options?.staleIfError ?? true;
		this.requestTimeoutMs = options?.requestTimeoutMs ?? 30_000;
    }

    private showProgress(task: string, current: number, total: number, speed: number, eta: number) {
        const now = Date.now();
        // Per-task throttle so concurrent acquisitions don't suppress each other.
        // Task labels already include the feed id (e.g. `Downloading GTFS (feed-id)`).
        const lastForTask = this.lastProgressByTask.get(task) ?? 0;
        if (now - lastForTask < 100 && (total <= 0 || current < total)) {
            return;
        }
        this.lastProgressByTask.set(task, now);
        this.lastProgressUpdate = now;

        const percent = total > 0 ? (current / total) * 100 : 0;

        if (this.progressCallback) {
            this.progressCallback({ task, current, total, percent, speed, eta });
            return;
        }

        if (this.ansi && total > 0) {
            const width = 20;
            const completed = Math.floor((percent / 100) * width);
            const bar = '='.repeat(completed) + '>'.repeat(completed < width ? 1 : 0) + ' '.repeat(width - completed - (completed < width ? 1 : 0));

            const sizeStr = `${formatBytes(current)}/${formatBytes(total)}`;
            const speedStr = `${formatBytes(speed)}/s`;
            const etaStr = `ETA ${formatDuration(eta)}`;

            process.stdout.write(`\x1b[0K\r[${bar}] ${percent.toFixed(1)}% | ${sizeStr} | ${speedStr} | ${etaStr} | ${task}`);
            if (percent >= 100) {
                process.stdout.write('\r\x1b[0K');
            }
        }
    }

    private computeSnapshotKey(buffers: Buffer[], feedIds: string[], effectiveFiles: string[]): string {
        const hashes = buffers.map(b => crypto.createHash('sha256').update(b).digest('hex'));
        const sortedFiles = [...effectiveFiles].sort();
        const arch = `${os.arch()}-${os.endianness()}-${process.versions.node}`;
        const keyInput = JSON.stringify({
            v: SNAPSHOT_VERSION,
            feedIds,
            hashes,
            mergeStrategy: this.mergeStrategy,
            files: sortedFiles,
            arch,
        });
        return crypto.createHash('sha256').update(keyInput).digest('hex');
    }

    private compiledSnapshotPath(key: string): string {
        const base = this.cacheDir || './cache';
        return path.join(base, 'compiled', `${key}.bin`);
    }

    private tryLoadCompiledSnapshot(key: string): boolean {
        const p = this.compiledSnapshotPath(key);
        if (!fs.existsSync(p)) return false;
        try {
            const stat = fs.statSync(p);
            if (stat.size < 32) return false;
            this.addonInstance.loadCompiledSnapshot(p);
            this.serviceDatesCache = null;
            this.serviceDatesSets = null;
            this.serviceIdsByDateCache = null;
            this.tripsByServiceIdCache = null;
            if (this.logger) this.logger(`Loaded compiled snapshot ${p}`);
            return true;
        } catch (e) {
            if (this.logger) this.logger(`Compiled snapshot invalid, fallback to parse: ${e instanceof Error ? e.message : String(e)}`);
            try { fs.unlinkSync(p); } catch {}
            return false;
        }
    }

    private saveCompiledSnapshotByKey(key: string): void {
        if (!this.cache) return;
        const p = this.compiledSnapshotPath(key);
        try {
            this.addonInstance.saveCompiledSnapshot(p);
            if (this.logger) this.logger(`Saved compiled snapshot ${p}`);
        } catch (e) {
            if (this.logger) this.logger(`Failed to save compiled snapshot: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    async loadStatic(feeds: GTFSFeedConfig[] | GTFSFeedConfig): Promise<GTFSStaticLoadResult[]> {
        const feedList = Array.isArray(feeds) ? feeds : [feeds];
		if (feedList.length === 0) throw new Error('At least one GTFS feed is required');
		if (feedList.some((feed) => !feed.id?.trim())) throw new Error('GTFS feed IDs must be non-empty');
		if (new Set(feedList.map((feed) => feed.id)).size !== feedList.length) throw new Error('GTFS feed IDs must be unique');
		// Do not destroy current snapshot before replacement is validated; clear JS caches only
		// this.clearStatic() removed for immutable snapshot semantics
        const cacheDir = this.cacheDir || './cache';
        // Deduplicate by transport-level source BEFORE starting tasks so feeds sharing
        // one archive URL (e.g. vic-vline/vic-metro with different archiveEntry)
        // trigger exactly one cache read / download. archiveEntry extraction stays per feed.
        const sourceKeyOf = (config: GTFSFeedConfig): string =>
            `${config.url}|${JSON.stringify(config.headers ?? {})}`;
        const sourceKeys = feedList.map(sourceKeyOf);
        const indicesBySource = new Map<string, number[]>();
        const uniqueSourceKeys: string[] = [];
        sourceKeys.forEach((sourceKey, feedIndex) => {
            const existing = indicesBySource.get(sourceKey);
            if (existing) {
                existing.push(feedIndex);
            } else {
                indicesBySource.set(sourceKey, [feedIndex]);
                uniqueSourceKeys.push(sourceKey);
            }
        });
        type SourceSpec = {
            sourceKey: string;
            url: string;
            headers?: Record<string, string>;
            cachePath: string;
            legacyPaths: string[];
            feedIds: string[];
        };
        const specs: SourceSpec[] = uniqueSourceKeys.map((sourceKey) => {
            const indices = indicesBySource.get(sourceKey)!;
            const representative = feedList[indices[0]];
            const cachePath = this.cache
                ? path.join(cacheDir, crypto.createHash('md5').update(sourceKey).digest('hex'))
                : '';
            const legacyPaths: string[] = [];
            if (this.cache) {
                for (const feedIndex of indices) {
                    const legacyHash = crypto.createHash('md5')
                        .update(`${sourceKey}|${feedList[feedIndex].archiveEntry ?? ''}`).digest('hex');
                    const legacyPath = path.join(cacheDir, legacyHash);
                    if (legacyPath !== cachePath && !legacyPaths.includes(legacyPath)) {
                        legacyPaths.push(legacyPath);
                    }
                }
            }
            return {
                sourceKey,
                url: representative.url,
                headers: representative.headers,
                cachePath,
                legacyPaths,
                feedIds: indices.map((feedIndex) => feedList[feedIndex].id),
            };
        });
        type AcquiredSource = { buffer: Buffer; source: GTFSStaticLoadResult["source"] };
        const acquireSource = async (spec: SourceSpec): Promise<AcquiredSource> => {
            let staleBuffer: Buffer | null = null;
            let staleAgeMs = Number.POSITIVE_INFINITY;
            let readablePath: string | null = null;
            if (this.cache && spec.cachePath) {
                // Single successful read per unique source: unified path first,
                // then per-feed legacy paths (distinct archiveEntry values) in feed order.
                const candidates = [spec.cachePath, ...spec.legacyPaths];
                for (const candidate of candidates) {
                    try {
                        const stats = await fsp.stat(candidate);
                        try {
                            staleBuffer = await fsp.readFile(candidate);
                        } catch (e) {
                            if (this.logger) this.logger(`Failed to read cache: ${e}`);
                            continue;
                        }
                        staleAgeMs = Date.now() - stats.mtimeMs;
                        readablePath = candidate;
                        break;
                    } catch {
                        continue;
                    }
                }
                if (staleBuffer && readablePath && staleAgeMs < this.cacheMaxAgeMs) {
                    if (this.logger) this.logger(`Loading from cache: ${readablePath}`);
                    return { buffer: staleBuffer, source: "fresh-cache" };
                }
                if (staleBuffer) {
                    if (this.logger) this.logger(`Cache expired for ${spec.url}, redownloading...`);
                }
            }

            if (this.logger) {
                if (this.ansi) {
                    this.logger(`\x1b[32mDownloading ${spec.url}...\x1b[0m`);
                } else {
                    this.logger(`Downloading ${spec.url}...`);
                }
            }
            try {
                // Labels already namespace the feed id(s); combined form keeps every
                // sharing feed visible while giving concurrent tasks distinct keys.
                const label = spec.feedIds.length === 1 ? spec.feedIds[0] : spec.feedIds.join(', ');
                const task = `Downloading GTFS (${label})`;
                const connectTask = `Connecting to GTFS (${label})`;
                this.lastProgressUpdate = 0;
                this.lastProgressByTask.delete(task);
                this.lastProgressByTask.delete(connectTask);
                for (const feedId of spec.feedIds) {
                    this.lastProgressByTask.delete(`Downloading GTFS (${feedId})`);
                    this.lastProgressByTask.delete(`Connecting to GTFS (${feedId})`);
                }
                this.showProgress(connectTask, 0, 0, 0, 0);
                const buffer = await this.download(spec.url, task, true, spec.headers);
                return { buffer, source: "network" };
            } catch (error) {
                if (!this.staleIfError || !staleBuffer) throw error;
                if (this.logger) this.logger(`Using stale cache for ${spec.url}: ${error instanceof Error ? error.message : String(error)}`);
                return { buffer: staleBuffer, source: "stale-cache" };
            }
        };
        const acquiredInSpecOrder = await mapWithConcurrency(specs, STATIC_ACQUIRE_CONCURRENCY, acquireSource);
        const acquiredBySource = new Map<string, AcquiredSource>();
        const pendingCacheWrites: { cacheDir: string; cachePath: string; buffer: Buffer }[] = [];
        specs.forEach((spec, specIndex) => {
            const acquired = acquiredInSpecOrder[specIndex];
            acquiredBySource.set(spec.sourceKey, acquired);
            if (acquired.source === "network" && this.cache && spec.cachePath) {
                pendingCacheWrites.push({ cacheDir, cachePath: spec.cachePath, buffer: acquired.buffer });
            }
        });

        // Expand back to feedList order so buffers/results/snapshot key stay ordered.
        const buffers: Buffer[] = new Array(feedList.length);
        const results: GTFSStaticLoadResult[] = new Array(feedList.length);
        for (let feedIndex = 0; feedIndex < feedList.length; feedIndex++) {
            const config = feedList[feedIndex];
            const acquired = acquiredBySource.get(sourceKeys[feedIndex])!;
            const firstIndexForSource = indicesBySource.get(sourceKeys[feedIndex])![0];
            if (feedIndex !== firstIndexForSource && this.logger) {
                this.logger(`Reusing downloaded GTFS archive for ${config.id}`);
            }
            let finalBuffer: Buffer;
            if (config.archiveEntry) {
                const extractTask = `Extracting GTFS (${config.id})`;
                this.lastProgressUpdate = 0;
                this.lastProgressByTask.delete(extractTask);
                this.showProgress(extractTask, 0, 0, 0, 0);
                finalBuffer = extractZipEntry(acquired.buffer, config.archiveEntry);
                this.showProgress(extractTask, finalBuffer.length, finalBuffer.length, 0, 0);
            } else {
                finalBuffer = acquired.buffer;
            }
            buffers[feedIndex] = finalBuffer;
            results[feedIndex] = { id: config.id, source: acquired.source };
        }

        const feedIds = feedList.map((feed) => feed.id);
        // Compute effective files for snapshot key (same logic as loadFromBuffers)
        const ALL_FILES_SNAP = ['agency.txt','routes.txt','trips.txt','stops.txt','stop_times.txt','calendar.txt','calendar_dates.txt','transfers.txt','shapes.txt','feed_info.txt','occupancies.txt'];
        let effectiveForKey: string[] = this.filesToLoad ? [...this.filesToLoad] : [];
        if (this.skipStopTimes && effectiveForKey.length === 0) {
            effectiveForKey = ALL_FILES_SNAP.filter(f => f !== 'stop_times.txt');
        } else if (this.skipStopTimes) {
            effectiveForKey = effectiveForKey.filter(f => f !== 'stop_times.txt');
        }
        const key = this.computeSnapshotKey(buffers, feedIds, effectiveForKey);
        // Compiled warm path disabled for now (inefficient for large feeds); fallback to normal parse
        // let usedCompiled = false;
        // if (this.cache) usedCompiled = this.tryLoadCompiledSnapshot(key);
        // if (!usedCompiled) {
            await this.loadFromBuffers(buffers, feedIds);
        //    if (this.cache) this.saveCompiledSnapshotByKey(key);
        // }
		// Only replace durable caches after every downloaded ZIP parsed successfully.
		for (const { cacheDir, cachePath, buffer } of pendingCacheWrites) {
			const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
			try {
				await fsp.mkdir(cacheDir, { recursive: true });
				await fsp.writeFile(temporaryPath, buffer);
				await fsp.rename(temporaryPath, cachePath);
			} finally {
				try { await fsp.unlink(temporaryPath); } catch {}
			}
		}
		return results;
    }

    async loadFromPath(paths: string[], feedIds: string[]): Promise<void> {
        const buffers = paths.map(p => fs.readFileSync(p));
        return this.loadFromBuffers(buffers, feedIds);
    }

    loadFromBuffers(buffers: Buffer[], feedIds: string[]): Promise<void> {
        if (buffers.length === 0) throw new Error('At least one GTFS buffer is required');
        if (feedIds.length !== buffers.length) {
            throw new Error(`Expected one feed ID per GTFS buffer; received ${feedIds.length} IDs for ${buffers.length} buffers`);
        }
        if (feedIds.some((feedId) => !feedId.trim())) throw new Error('GTFS feed IDs must be non-empty');
        if (new Set(feedIds).size !== feedIds.length) throw new Error('GTFS feed IDs must be unique');
        const startTime = Date.now();
        const progressBridge = (task: string, current: number, total: number) => {
            const now = Date.now();
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? current / elapsed : 0;
            const remaining = total - current;
            const eta = speed > 0 ? remaining / speed : 0;
            this.showProgress(task, current, total, speed, eta);
        };

        const ALL_FILES = ['agency.txt','routes.txt','trips.txt','stops.txt','stop_times.txt','calendar.txt','calendar_dates.txt','transfers.txt','shapes.txt','feed_info.txt','occupancies.txt'];
        let effectiveFiles: string[] = this.filesToLoad ? [...this.filesToLoad] : [];
        if (this.skipStopTimes && effectiveFiles.length === 0) {
            effectiveFiles = ALL_FILES.filter(f => f !== 'stop_times.txt');
        } else if (this.skipStopTimes) {
            effectiveFiles = effectiveFiles.filter(f => f !== 'stop_times.txt');
        }

        const ALL_FILES_KEY = ['agency.txt','routes.txt','trips.txt','stops.txt','stop_times.txt','calendar.txt','calendar_dates.txt','transfers.txt','shapes.txt','feed_info.txt','occupancies.txt'];
        let effectiveForCacheKey = effectiveFiles.length ? [...effectiveFiles] : [];
        // effectiveFiles may be empty meaning all; normalize for key
        if (effectiveForCacheKey.length === 0) effectiveForCacheKey = [];
        const keyForBuffer = this.computeSnapshotKey(buffers, feedIds, effectiveForCacheKey.length ? effectiveForCacheKey : ALL_FILES_KEY);
        // Try compiled warm path if cache enabled and caller is loadFromBuffers directly (e.g., tests)
        // We do not automatically try here to avoid double path; loadStatic already tried
        return this.addonInstance.loadFromBuffers(buffers, this.mergeStrategy, this.logger, this.ansi, progressBridge, feedIds, effectiveFiles)
            .then((result: void) => {
                this.serviceDatesCache = null;
                this.serviceDatesSets = null;
                this.serviceIdsByDateCache = null;
                this.tripsByServiceIdCache = null;
                return result;
            });
    }

    getSnapshotRevision(): { realtime_revision: number; stop_time_count: number; trip_count: number } {
        return this.addonInstance.getSnapshotRevision();
    }
    getStaticSnapshotInfo(): { stop_time_count: number; realtime_revision: number } {
        return this.addonInstance.getStaticSnapshotInfo();
    }
    saveCompiledSnapshot(path: string): void { return this.addonInstance.saveCompiledSnapshot(path); }
    loadCompiledSnapshot(path: string): void { return this.addonInstance.loadCompiledSnapshot(path); }

    getRoutes(filter?: Partial<Route>): Route[] {
        return this.addonInstance.getRoutes(filter);
    }

    getAgencies(filter?: Partial<Agency>): Agency[] {
        return this.addonInstance.getAgencies(filter);
    }

    getStops(filter?: Partial<Stop>): Stop[] {
        return this.addonInstance.getStops(filter);
    }

    getStopTimes(query?: StopTimeQuery): StopTime[] {
        return this.addonInstance.getStopTimes(query || {});
    }

    getStopTimesPacked(query: Pick<StopTimeQuery, "trip_id" | "trip_ids" | "feed_id"> & { fields?: string[] }): PackedStopTimes {
        return this.addonInstance.getStopTimesPacked(query);
    }

    getTripStopTimeBounds(): TripStopTimeBounds[] {
        return this.addonInstance.getTripStopTimeBounds();
    }

    clearStatic(): void {
        this.addonInstance.clearStatic();
        this.serviceDatesCache = null;
        this.serviceDatesSets = null;
        this.serviceIdsByDateCache = null;
        this.tripsByServiceIdCache = null;
    }

    getStaticOccupancies(query: StaticOccupancyQuery): StaticOccupancy[] {
        return this.addonInstance.getStaticOccupancies(query);
    }

    getFeedInfo(): FeedInfo[] {
        return this.addonInstance.getFeedInfo();
    }

    private qualifiedKey(feedId: string, localId: string): string {
        return `${feedId.length}:${feedId}${localId}`;
    }

    private getServiceDatesMap(): Map<string, string[]> {
        if (this.serviceDatesCache && this.serviceDatesSets && this.serviceIdsByDateCache) return this.serviceDatesCache;

        const calendars = this.getCalendars();
        const calendarDates = this.getCalendarDates();
        const serviceDates = new Map<string, Set<string>>();

        for (const calendar of calendars) {
            const { service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date } =
                calendar;

            const key = this.qualifiedKey(calendar.feed_id, service_id);
            if (!serviceDates.has(key)) serviceDates.set(key, new Set());

            const sDateStr = String(start_date);
            const eDateStr = String(end_date);
            let currentDate = new Date(
                Date.UTC(
                    Number(sDateStr.substring(0, 4)),
                    Number(sDateStr.substring(4, 6)) - 1,
                    Number(sDateStr.substring(6, 8)),
                ),
            );
            const endDate = new Date(
                Date.UTC(
                    Number(eDateStr.substring(0, 4)),
                    Number(eDateStr.substring(4, 6)) - 1,
                    Number(eDateStr.substring(6, 8)),
                ),
            );

            while (currentDate <= endDate) {
                const dayOfWeek = currentDate.getUTCDay(); // 0 for Sunday, 1 for Monday, etc.
                
                let serviceRuns = false;
                if (dayOfWeek === 1 && monday) serviceRuns = true;
                else if (dayOfWeek === 2 && tuesday) serviceRuns = true;
                else if (dayOfWeek === 3 && wednesday) serviceRuns = true;
                else if (dayOfWeek === 4 && thursday) serviceRuns = true;
                else if (dayOfWeek === 5 && friday) serviceRuns = true;
                else if (dayOfWeek === 6 && saturday) serviceRuns = true;
                else if (dayOfWeek === 0 && sunday) serviceRuns = true;

                if (serviceRuns) {
                    const y = currentDate.getUTCFullYear();
                    const m = currentDate.getUTCMonth() + 1;
                    const d = currentDate.getUTCDate();
                    const dateStr = `${y}${m < 10 ? '0' : ''}${m}${d < 10 ? '0' : ''}${d}`;
                    serviceDates.get(key)!.add(dateStr);
                }

                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }
        }

        for (const calendarDate of calendarDates) {
            const { service_id, date, exception_type } = calendarDate;
            if (!date) continue;
            const key = this.qualifiedKey(calendarDate.feed_id, service_id);
            if (!serviceDates.has(key)) serviceDates.set(key, new Set());

            if (exception_type === 1) {
                serviceDates.get(key)!.add(date);
            } else if (exception_type === 2) {
                serviceDates.get(key)!.delete(date);
            }
        }

        const sortedServiceDates = new Map<string, string[]>();
        const idsByDate = new Map<string, QualifiedEntityId[]>();

        for (const calendar of calendars) {
            const key = this.qualifiedKey(calendar.feed_id, calendar.service_id);
            const dates = Array.from(serviceDates.get(key) ?? []).sort();
            sortedServiceDates.set(key, dates);
            for (const d of dates) {
                const ids = idsByDate.get(d) ?? [];
                if (!ids.some((id) => id.feedId === calendar.feed_id && id.localId === calendar.service_id)) {
                    ids.push({ feedId: calendar.feed_id, localId: calendar.service_id });
                }
                idsByDate.set(d, ids);
            }
        }

        for (const calendarDate of calendarDates) {
            const key = this.qualifiedKey(calendarDate.feed_id, calendarDate.service_id);
            if (!sortedServiceDates.has(key)) {
                const dates = Array.from(serviceDates.get(key) ?? []).sort();
                sortedServiceDates.set(key, dates);
            }
        }

        this.serviceDatesSets = serviceDates;
        this.serviceDatesCache = sortedServiceDates;
        this.serviceIdsByDateCache = idsByDate;
        return sortedServiceDates;
    }

    private getTripsByServiceId(): Map<string, Trip[]> {
        if (this.tripsByServiceIdCache) return this.tripsByServiceIdCache;
        const allTrips = this.addonInstance.getTrips({});
        const map = new Map<string, Trip[]>();
        for (const trip of allTrips) {
            const key = this.qualifiedKey(trip.feed_id, trip.service_id);
            const trips = map.get(key) ?? [];
            trips.push(trip);
            map.set(key, trips);
        }
        this.tripsByServiceIdCache = map;
        return map;
    }

    getTrips(filter?: TripQuery | Partial<Trip>): Trip[] {
        return this.addonInstance.getTrips(filter || {});
    }

    getTransfers(filter?: TransferQuery | Partial<Transfer>): Transfer[] {
        return this.addonInstance.getTransfers(filter || {});
    }

    getShapes(filter?: Partial<Shape>): Shape[] {
        return this.addonInstance.getShapes(filter);
    }

    getCalendars(filter?: Partial<Calendar>): Calendar[] {
        return this.addonInstance.getCalendars(filter);
    }

    getCalendarDates(filter?: Partial<CalendarDate>): CalendarDate[] {
        return this.addonInstance.getCalendarDates(filter);
    }

    getServiceDates(service: QualifiedEntityId): string[] {
        return this.getServiceDatesMap().get(this.qualifiedKey(service.feedId, service.localId)) ?? [];
    }

    getServiceDatesByTrip(trip: QualifiedEntityId): string[] {
        const trips = this.getTrips({ trip_id: trip.localId, feed_id: trip.feedId });
        if (trips.length === 0) return [];
        return this.getServiceDates({ feedId: trips[0].feed_id, localId: trips[0].service_id });
    }

	/** Replace the supplied realtime source and return compact change metadata. */
	updateRealtime(input: {
		kind: GTFSRealtimeFeedConfig["kind"];
		data: Buffer | Buffer[];
		targetFeedId: string;
		sourceId: string;
	}): GTFSRealtimeUpdateResult {
		const result = this.addonInstance.updateRealtime(
			input.kind === "alerts" ? input.data : [],
			input.kind === "trip-updates" ? input.data : [],
            input.kind === "vehicles" ? input.data : [],
            input.targetFeedId,
            input.sourceId,
        ) as GTFSRealtimeUpdateResult;
		this.lastChangedTripIds = result.changed_trip_ids ?? [];
		this.lastRealtimeRevision = result.realtime_revision ?? 0;
		return result;
    }

	getLastChangedTripIds(): RealtimeChangedTrip[] { return [...this.lastChangedTripIds]; }
	getRealtimeRevision(): number { return this.lastRealtimeRevision; }

    /**
     * Fetch phase: download every source concurrently without touching the
     * snapshot. Results keep `sources` order. Protobuf decoding still happens
     * inside the native commit; only transport is overlapped here.
     */
    async fetchRealtimeSources(sources: GTFSRealtimeFeedConfig[]): Promise<FetchedRealtimeSource[]> {
		return Promise.all(sources.map(async (source) => {
			try {
				const data = await this.download(source.url, `Downloading ${source.kind}`, false, source.headers);
				return { source, ok: true as const, data };
			} catch (error) {
				return { source, ok: false as const, error: error instanceof Error ? error.message : String(error) };
			}
		}));
    }

    /**
     * Commit phase: apply prefetched payloads serially in array order, so the
     * resulting snapshot is independent of download completion order. Failed
     * fetches are reported without mutating the snapshot.
     */
    applyRealtimePayloads(fetched: FetchedRealtimeSource[]): GTFSRealtimeLoadResult[] {
		const allChanged: RealtimeChangedTrip[] = [];
		let lastRevision = this.lastRealtimeRevision;
		const results = fetched.map((entry) => {
			if (!entry.ok || !entry.data) {
				return { id: entry.source.id, ok: false, error: entry.error ?? "fetch failed" };
			}
			try {
				const refresh = this.updateRealtime({ kind: entry.source.kind, data: entry.data, targetFeedId: entry.source.targetFeedId, sourceId: entry.source.id });
				if (refresh?.changed_trip_ids) allChanged.push(...refresh.changed_trip_ids);
				if (refresh?.realtime_revision) lastRevision = refresh.realtime_revision;
				return { id: entry.source.id, ok: true, refresh };
			} catch (error) {
				return { id: entry.source.id, ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		});
		// Aggregate for sparse update consumers
		this.lastChangedTripIds = allChanged;
		this.lastRealtimeRevision = lastRevision;
		return results;
    }

    async updateRealtimeFromUrl(sources: GTFSRealtimeFeedConfig[]): Promise<GTFSRealtimeLoadResult[]> {
		return this.applyRealtimePayloads(await this.fetchRealtimeSources(sources));
    }

    getRealtimeTripUpdates(filter?: RealtimeFilter): RealtimeTripUpdate[] {
        return this.addonInstance.getRealtimeTripUpdates(filter || {});
    }

    getRealtimeVehiclePositions(filter?: RealtimeFilter): RealtimeVehiclePosition[] {
        return this.addonInstance.getRealtimeVehiclePositions(filter || {});
    }

    getRealtimeAlerts(filter?: RealtimeFilter): RealtimeAlert[] {
        return this.addonInstance.getRealtimeAlerts(filter || {});
    }

    clearRealtime(filter: { targetFeedId?: string; sourceId?: string } = {}): void {
        this.addonInstance.clearRealtime(filter.targetFeedId || "", filter.sourceId || "");
	}

    private download(
        url: string,
        taskName: string = "Downloading",
        showProgressBar: boolean = true,
        headers?: Record<string, string>,
        redirects: number = 0,
        connectionAttempt: number = 0,
    ): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            let connectionTimer: NodeJS.Timeout | undefined;
            let receivedResponse = false;
            const onResponse = (res: any) => {
                receivedResponse = true;
                if (connectionTimer) clearTimeout(connectionTimer);
                res.on('error', (err: Error) => reject(err));
                if (res.statusCode !== 200) {
					if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
						if (redirects >= 5) { reject(new Error(`Too many redirects downloading ${url}`)); return; }
                        if (this.logger) this.logger(`Redirected to ${res.headers.location}`);
						res.resume();
						this.download(new URL(res.headers.location as string, url).toString(), taskName, showProgressBar, headers, redirects + 1, connectionAttempt).then(resolve).catch(reject);
                        return;
                    }
					res.resume();
                    reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
                    return;
                }

                const total = parseInt(res.headers['content-length'] || '0', 10);
                let current = 0;
                const data: Buffer[] = [];
                const startTime = Date.now();
				this.lastProgressUpdate = 0;
				this.lastProgressByTask.delete(taskName);
				this.showProgress(taskName, 0, total, 0, 0);

                res.on('data', (chunk: Buffer) => {
                    data.push(chunk);
                    current += chunk.length;

                    if (showProgressBar) {
                        const now = Date.now();
                        const elapsed = (now - startTime) / 1000;
                        const speed = elapsed > 0 ? current / elapsed : 0;
                        const remaining = total - current;
                        const eta = speed > 0 ? remaining / speed : 0;

                        this.showProgress(taskName, current, total, speed, eta);
                    }
                });

                res.on('end', () => {
                    if (showProgressBar) {
                        const now = Date.now();
                        const elapsed = (now - startTime) / 1000;
                        const speed = elapsed > 0 ? current / elapsed : 0;
                        this.lastProgressUpdate = 0;
                        this.lastProgressByTask.delete(taskName);
						// A number of official feeds use chunked transfer encoding. Once the
						// stream ends, its downloaded byte count is the actual total.
						this.showProgress(taskName, current, total || current, speed, 0);
                        if (this.ansi && process.stdout.isTTY) process.stdout.write('\n');
                    }
                    resolve(Buffer.concat(data))
                });
            };

            try {
                const client = url.startsWith('https') ? https : http;
				const req = client.get(url, {
					headers,
					// These feeds all publish IPv4 endpoints. Avoid Node waiting on an
					// unroutable IPv6 result before trying the usable address.
					family: 4,
				}, onResponse);
				connectionTimer = setTimeout(
					() => req.destroy(new Error(`Timed out connecting to ${url}`)),
					Math.min(this.requestTimeoutMs, 10_000),
				);
				req.on('error', (err: Error) => {
					if (connectionTimer) clearTimeout(connectionTimer);
					if (!receivedResponse && connectionAttempt < 2) {
						this.download(url, taskName, showProgressBar, headers, redirects, connectionAttempt + 1)
							.then(resolve)
							.catch(reject);
						return;
					}
					reject(err);
				});
				req.setTimeout(this.requestTimeoutMs, () => req.destroy(new Error(`Timed out downloading ${url}`)));
            } catch (e) {
				if (connectionTimer) clearTimeout(connectionTimer);
                reject(e);
            }
        });
    }
}
