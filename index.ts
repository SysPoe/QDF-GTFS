import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import * as net from 'net';
import * as dns from 'dns';
import { setMaxListeners } from 'events';
import { inflateRawSync } from 'zlib';
import {
    Agency, Route, Stop, StopTime, TripStopTimeBounds, FeedInfo, Trip, Transfer, Frequency, Shape, Calendar, CalendarDate,
    RealtimeTripUpdate, RealtimeVehiclePosition, RealtimeAlert, StopTimeQuery, TripQuery, GTFSOptions, ProgressInfo,
    GTFSMergeStrategy, GTFSFeedConfig, GTFSRealtimeFeedConfig, GTFSStaticLoadResult, GTFSRealtimeLoadResult, GTFSRealtimeUpdateResult, GTFSActions, QualifiedEntityId,
    RealtimeFilter, TransferQuery, StaticOccupancy, StaticOccupancyQuery, PackedStopTimes, RealtimeChangedTrip, FetchedRealtimeSource,
    RealtimeFetchOptions, PackedShapes
} from './types.js';

export * from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const r = createRequire(import.meta.url);

let GTFSAddon: any;
try {
    try {
        // Both source execution and dist/index.js resolve the addon from the
        // package root. Never prefer a stale dist/build copy left by an older
        // build, because it may expose an incompatible native ABI.
        const packageRoot = path.basename(__dirname) === 'dist'
            ? path.dirname(__dirname)
            : __dirname;
        const binding = r(path.join(packageRoot, 'build/Release/gtfs_addon.node'));
        GTFSAddon = binding.GTFSAddon;
    } catch (e) {
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
                    getFrequencies() { return []; }
                    getShapes() { return []; }
                    getShapesPacked() {
                        return { latitudes: new Float64Array(), longitudes: new Float64Array(),
                            sequences: new Int32Array(), shapeDistances: new Float64Array() };
                    }
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

function readVarint64(buffer: Buffer, cursor: { offset: number }): bigint {
    let value = 0n;
    for (let shift = 0; shift < 70 && cursor.offset < buffer.length; shift += 7) {
        const byte = buffer[cursor.offset++];
        if (shift === 63 && byte > 1) throw new Error('Invalid GTFS-RT protobuf varint');
        value |= BigInt(byte & 0x7f) << BigInt(shift);
        if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Invalid GTFS-RT protobuf varint');
}

function protobufMessages(buffer: Buffer, fieldNumber: number): Buffer[] {
    const result: Buffer[] = [], cursor = { offset: 0 };
    while (cursor.offset < buffer.length) {
        const tag = readVarint(buffer, cursor), field = Math.floor(tag / 8), wire = tag & 7;
        if (wire === 0) readVarint64(buffer, cursor);
        else if (wire === 1) {
            cursor.offset += 8;
            if (cursor.offset > buffer.length) throw new Error('Truncated GTFS-RT protobuf field');
        }
        else if (wire === 2) {
            const length = readVarint(buffer, cursor), end = cursor.offset + length;
            if (end > buffer.length) throw new Error('Truncated GTFS-RT protobuf field');
            if (field === fieldNumber) result.push(buffer.subarray(cursor.offset, end));
            cursor.offset = end;
        } else if (wire === 5) {
            cursor.offset += 4;
            if (cursor.offset > buffer.length) throw new Error('Truncated GTFS-RT protobuf field');
        }
        else throw new Error(`Unsupported GTFS-RT protobuf wire type ${wire}`);
    }
    return result;
}

function protobufScalar(buffer: Buffer, fieldNumber: number, signedInt32 = false): number | null {
    const cursor = { offset: 0 };
    while (cursor.offset < buffer.length) {
        const tag = readVarint(buffer, cursor), field = Math.floor(tag / 8), wire = tag & 7;
        if (wire === 0) {
            const value = readVarint64(buffer, cursor);
            if (field === fieldNumber) {
                if (signedInt32) {
                    const signed = BigInt.asIntN(32, value);
                    if (value !== BigInt.asUintN(32, signed) && value !== BigInt.asUintN(64, signed)) {
                        throw new Error('Invalid GTFS-RT int32');
                    }
                    return Number(signed);
                }
                if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe GTFS-RT protobuf scalar');
                return Number(value);
            }
        } else if (wire === 1) {
            cursor.offset += 8;
            if (cursor.offset > buffer.length) throw new Error('Truncated GTFS-RT protobuf field');
        }
        else if (wire === 2) {
            const length = readVarint(buffer, cursor);
            cursor.offset += length;
            if (cursor.offset > buffer.length) throw new Error('Truncated GTFS-RT protobuf field');
        } else if (wire === 5) {
            cursor.offset += 4;
            if (cursor.offset > buffer.length) throw new Error('Truncated GTFS-RT protobuf field');
        }
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
        const carriages = protobufMessages(vehicle, 11).map((carriage) => {
            const occupancyStatus = protobufScalar(carriage, 3);
            const occupancyPercentage = protobufScalar(carriage, 4, true);
            const carriageSequence = protobufScalar(carriage, 5);
            if ((occupancyStatus !== null && (occupancyStatus < 0 || occupancyStatus > 8)) ||
                (occupancyPercentage !== null && occupancyPercentage < -1) ||
                (carriageSequence !== null && (!Number.isSafeInteger(carriageSequence) || carriageSequence > 0x7fffffff))) {
                throw new Error('Invalid GTFS-RT carriage detail value');
            }
            return {
                id: protobufString(carriage, 1),
                label: protobufString(carriage, 2),
                occupancy_status: occupancyStatus as import('./types.js').OccupancyStatus | null,
                occupancy_percentage: occupancyPercentage === -1 ? null : occupancyPercentage,
                carriage_sequence: carriageSequence,
            };
        });
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

    const eocdCommentLength = archive.readUInt16LE(eocd + 20);
    if (eocd + 22 + eocdCommentLength !== archive.length ||
        archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0) {
        throw new Error('Downloaded ZIP has an invalid end record');
    }

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
        const expectedCrc = archive.readUInt32LE(offset + 16);
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
            const maxEntryBytes = 128 * 1024 * 1024;
            if (uncompressedSize > maxEntryBytes ||
                (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > 200))) {
                throw new Error(`ZIP archive entry '${entry}' exceeds extraction limits`);
            }
            let result: Buffer | null;
            try {
                result = compression === 0 ? Buffer.from(compressed) : compression === 8
                    ? inflateRawSync(compressed, { maxOutputLength: maxEntryBytes }) : null;
            } catch (error) {
                throw new Error(`Failed to extract ZIP archive entry '${entry}': ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!result) throw new Error(`ZIP archive entry '${entry}' uses unsupported compression method ${compression}`);
            if (result.length !== uncompressedSize)
                throw new Error(`ZIP archive entry '${entry}' has an invalid uncompressed size`);
            let crc = 0xffffffff;
            for (const byte of result) {
                crc ^= byte;
                for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
            }
            if (((crc ^ 0xffffffff) >>> 0) !== expectedCrc) throw new Error(`ZIP archive entry '${entry}' failed its CRC check`);
            return result;
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    throw new Error(`ZIP archive entry '${entry}' was not found`);
}

/** Bound on concurrent static source acquisitions (cache I/O + download). */
const STATIC_ACQUIRE_CONCURRENCY = 4;

export function isNonPublicAddress(address: string): boolean {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19));
    }
    if (net.isIPv6(address)) {
        const normalized = address.toLowerCase().split('%')[0];
        // IPv4-mapped (and other IPv4-embedded) dotted form, e.g.
        // ::ffff:127.0.0.1: judge by the embedded IPv4 so private
        // loopback/RFC1918 ranges cannot bypass the SSRF guard.
        if (normalized.includes('.')) {
            const embedded = normalized.slice(normalized.lastIndexOf(':') + 1);
            if (net.isIPv4(embedded)) return isNonPublicAddress(embedded);
            return true;
        }
        // Hex-form mapped ::ffff:0:0/96 without dots, e.g. ::ffff:7f00:1.
        // Only decode when the prefix before :ffff: is all zeros.
        const ffffPos = normalized.lastIndexOf(':ffff:');
        if (ffffPos !== -1) {
            const prefix = normalized.slice(0, ffffPos);
            if (/^[0:]*$/.test(prefix)) {
                const tail = normalized.slice(ffffPos + 6);
                const parts = tail.split(':').filter((p) => p.length > 0);
                if (parts.length >= 1 && parts.length <= 2 && parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
                    const words = parts.map((p) => parseInt(p, 16));
                    const bytes = words.length === 2
                        ? [(words[0] >> 8) & 255, words[0] & 255, (words[1] >> 8) & 255, words[1] & 255]
                        : [0, 0, (words[0] >> 8) & 255, words[0] & 255];
                    return isNonPublicAddress(bytes.join('.'));
                }
            }
        }
        return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
            normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff');
    }
    return true;
}

async function redirectHeaders(
    from: URL,
    to: URL,
    headers?: Record<string, string>,
    existingAddresses?: dns.LookupAddress[],
): Promise<{ headers: Record<string, string> | undefined; addresses?: dns.LookupAddress[] }> {
    if (from.protocol === 'https:' && to.protocol !== 'https:') {
        throw new Error(`Refusing insecure redirect from ${from.origin} to ${to.origin}`);
    }
    let addresses: dns.LookupAddress[] | undefined = from.origin === to.origin ? existingAddresses : undefined;
    if (from.origin !== to.origin) {
        addresses = await dns.promises.lookup(to.hostname, { all: true });
        if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
            throw new Error(`Refusing redirect to non-public address ${to.hostname}`);
        }
    }
    return {
        headers: from.origin === to.origin ? headers : Object.fromEntries(
            Object.entries(headers ?? {}).filter(([name]) => !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase())),
        ),
        addresses,
    };
}

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

/** Canonical header serialization so key order does not fragment the static cache. */
function canonicalHeaders(headers?: Record<string, string>): string {
    if (!headers) return '{}';
    const sortedKeys = Object.keys(headers).sort();
    return JSON.stringify(Object.fromEntries(sortedKeys.map((key) => [key, headers[key]])));
}

function assertHttpUrl(value: string, label: string): void {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${label} must be a valid URL, received '${value}'`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${label} must use http(s), received '${value}'`);
    }
}

/**
 * Validate `fallbackUrls` without changing the transport contract: same
 * headers are sent to every URL, fallbacks are tried in order, duplicates of
 * the primary URL are rejected so a misconfiguration cannot mask a failure.
 */
function validateFeedFallbacks(config: GTFSFeedConfig): string[] {
    assertHttpUrl(config.url, `GTFS feed '${config.id}' url`);
    const fallbacks = config.fallbackUrls ?? [];
    if (!Array.isArray(fallbacks)) throw new Error(`GTFS feed '${config.id}' fallbackUrls must be an array`);
    const seen = new Set<string>();
    for (const fallback of fallbacks) {
        if (typeof fallback !== 'string' || !fallback.trim()) {
            throw new Error(`GTFS feed '${config.id}' fallbackUrls must be non-empty URLs`);
        }
        assertHttpUrl(fallback, `GTFS feed '${config.id}' fallback`);
        if (fallback === config.url || seen.has(fallback)) {
            throw new Error(`GTFS feed '${config.id}' has a duplicate fallback URL '${fallback}'`);
        }
        seen.add(fallback);
    }
    return [...seen];
}

export class GTFS {
    private addonInstance: any;
    private logger?: (msg: string) => void;
    private progressCallback?: (info: ProgressInfo) => void;
    private ansi: boolean;
    private cacheDir?: string;
    private cache: boolean;
    private compiledCache: boolean;
    private mergeStrategy: GTFSMergeStrategy;
    private lastProgressUpdate: number = 0;
    private lastProgressByTask = new Map<string, number>();
    private filesToLoad?: string[];
    private skipStopTimes: boolean;
	private cacheMaxAgeMs: number;
	private staleIfError: boolean;
	private requestTimeoutMs: number;
	private realtimeTimeoutMs: number;
    private maxDownloadBytes: number;
    private maxExtractedEntryBytes: number;
    private serviceDatesCache: Map<string, string[]> | null = null;
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
        this.compiledCache = options?.compiledCache ?? false;
        this.mergeStrategy = options?.mergeStrategy !== undefined ? options.mergeStrategy : GTFSMergeStrategy.OVERWRITE;
        this.filesToLoad = options?.filesToLoad;
        this.skipStopTimes = options?.skipStopTimes || false;
		this.cacheMaxAgeMs = options?.cacheMaxAgeMs ?? 24 * 60 * 60 * 1000;
		this.staleIfError = options?.staleIfError ?? true;
		this.requestTimeoutMs = options?.requestTimeoutMs ?? 30_000;
		this.realtimeTimeoutMs = options?.realtimeTimeoutMs ?? this.requestTimeoutMs;
        this.maxDownloadBytes = options?.maxDownloadBytes ?? 256 * 1024 * 1024;
		this.maxExtractedEntryBytes = options?.maxExtractedEntryBytes ?? 128 * 1024 * 1024;
		if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
			throw new Error('requestTimeoutMs must be a positive finite number');
		}
		if (!Number.isFinite(this.realtimeTimeoutMs) || this.realtimeTimeoutMs <= 0) {
			throw new Error('realtimeTimeoutMs must be a positive finite number');
		}
		if (!Number.isSafeInteger(this.maxExtractedEntryBytes) ||
			this.maxExtractedEntryBytes <= 0 || this.maxExtractedEntryBytes > 512 * 1024 * 1024) {
			throw new Error('maxExtractedEntryBytes must be an integer between 1 byte and 512 MiB');
		}
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
        if (this.lastProgressByTask.size > 256) {
            const oldest = this.lastProgressByTask.keys().next().value;
            if (oldest !== undefined) this.lastProgressByTask.delete(oldest);
        }
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

    private realtimeDeadlineMs(overrideMs?: number): number {
        const deadline = overrideMs ?? this.realtimeTimeoutMs;
        if (!Number.isFinite(deadline) || deadline <= 0) {
            throw new Error('realtime timeout must be a positive finite number');
        }
        return deadline;
    }

    /**
     * Try the primary URL then each fallback in order, using the same headers
     * and progress task. Only the last failure is thrown so stale-cache
     * handling sees the most relevant error.
     */
    private async downloadWithFallbacks(
        primaryUrl: string,
        fallbackUrls: string[],
        task: string,
        showProgressBar: boolean,
        headers?: Record<string, string>,
        signal?: AbortSignal,
        validate?: (buffer: Buffer) => Promise<void>,
    ): Promise<{ buffer: Buffer; url: string; fallbackIndex: number }> {
        let lastError: unknown = null;
        const urls = [primaryUrl, ...fallbackUrls];
        for (let index = 0; index < urls.length; index++) {
            signal?.throwIfAborted();
            try {
                const buffer = await this.download(urls[index], task, showProgressBar, headers, 0, 0, undefined, signal);
                signal?.throwIfAborted();
                await validate?.(buffer);
                if (index > 0 && this.logger) {
                    this.logger(`Using fallback URL ${index}/${urls.length - 1} for ${task}`);
                }
                return { buffer, url: urls[index], fallbackIndex: index };
            } catch (error) {
                signal?.throwIfAborted();
                lastError = error;
                if (index + 1 < urls.length && this.logger) {
                    this.logger(`Primary download failed, trying fallback ${index + 1}/${urls.length - 1}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    async loadStatic(feeds: GTFSFeedConfig[] | GTFSFeedConfig): Promise<GTFSStaticLoadResult[]> {
        const feedList = Array.isArray(feeds) ? feeds : [feeds];
		if (feedList.length === 0) throw new Error('At least one GTFS feed is required');
		if (feedList.some((feed) => !feed.id?.trim())) throw new Error('GTFS feed IDs must be non-empty');
		if (new Set(feedList.map((feed) => feed.id)).size !== feedList.length) throw new Error('GTFS feed IDs must be unique');
		for (const feed of feedList) validateFeedFallbacks(feed);
		// Do not destroy current snapshot before replacement is validated; clear JS caches only
		// this.clearStatic() removed for immutable snapshot semantics
        const cacheDir = this.cacheDir || './cache';
        // Deduplicate by transport-level source BEFORE starting tasks so feeds sharing
        // one archive URL (e.g. vic-vline/vic-metro with different archiveEntry)
        // trigger exactly one cache read / download. archiveEntry extraction stays per feed.
        // Headers are canonicalized (sorted keys) so key order does not fragment the cache.
        // Fallback URLs do not fragment the cache key; feeds sharing a primary URL share
        // one download and try the union of their fallbacks in feed order.
        const sourceKeyOf = (config: GTFSFeedConfig): string =>
            `${config.url}|${canonicalHeaders(config.headers)}`;
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
            fallbackUrls: string[];
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
            // Union fallbacks in feed order so sharing feeds keep one download
            // while still trying every configured mirror when the primary fails.
            const fallbackUrls: string[] = [];
            for (const feedIndex of indices) {
                for (const fallback of feedList[feedIndex].fallbackUrls ?? []) {
                    if (!fallbackUrls.includes(fallback)) fallbackUrls.push(fallback);
                }
            }
            return {
                sourceKey,
                url: representative.url,
                headers: representative.headers,
                fallbackUrls,
                cachePath,
                legacyPaths,
                feedIds: indices.map((feedIndex) => feedList[feedIndex].id),
            };
        });
        type AcquiredSource = { buffer: Buffer; source: GTFSStaticLoadResult["source"] };
        const sourceBuffers = (spec: SourceSpec, buffer: Buffer): Buffer[] =>
            indicesBySource.get(spec.sourceKey)!.map((index) => {
                const entry = feedList[index].archiveEntry;
                return entry ? extractZipEntry(buffer, entry) : buffer;
            });
        const validateSource = async (spec: SourceSpec, buffer: Buffer): Promise<void> => {
            // Recovery alone needs a separate parser. Healthy loads still parse once.
            // This instance never publishes into the caller's live snapshot.
            const validation = new GTFS({
                filesToLoad: this.filesToLoad,
                skipStopTimes: this.skipStopTimes,
                mergeStrategy: this.mergeStrategy,
                maxExtractedEntryBytes: this.maxExtractedEntryBytes,
            });
            try { await validation.loadFromBuffers(sourceBuffers(spec, buffer), spec.feedIds); }
            finally { validation.clearStatic(); }
        };
        const acquireSource = async (spec: SourceSpec, validateCandidate = false): Promise<AcquiredSource> => {
            let staleBuffer: Buffer | null = null;
            let staleMtimeMs = 0;
            let stalePath: string | null = null;
            if (this.cache && spec.cachePath) {
                // Priority order is deterministic: unified path first, then
                // legacy per-feed paths in feed order. The first fresh entry
                // wins; otherwise the newest stale entry is kept for
                // stale-if-error. Recovery also rejects corrupt ZIP/CSV entries.
                const ordered = [spec.cachePath, ...spec.legacyPaths];
                for (const candidate of ordered) {
                    let stats: import('fs').Stats;
                    try {
                        stats = await fsp.stat(candidate);
                    } catch { continue; }
                    if (!stats.isFile() || stats.size === 0 || stats.size > this.maxDownloadBytes) continue;
                    let buffer: Buffer;
                    try {
                        buffer = await fsp.readFile(candidate);
                    } catch (e) {
                        if (this.logger) this.logger(`Failed to read cache: ${e}`);
                        continue;
                    }
                    if (buffer.length === 0 || buffer.length > this.maxDownloadBytes) continue;
                    if (validateCandidate) {
                        try { await validateSource(spec, buffer); }
                        catch (error) {
                            this.logger?.(`Skipping invalid cache ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
                            continue;
                        }
                    }
                    const ageMs = Date.now() - stats.mtimeMs;
                    if (ageMs < this.cacheMaxAgeMs) {
                        if (this.logger) this.logger(`Loading from cache: ${candidate}`);
                        return { buffer, source: "fresh-cache" };
                    }
                    if (!staleBuffer || stats.mtimeMs > staleMtimeMs) {
                        staleBuffer = buffer;
                        staleMtimeMs = stats.mtimeMs;
                        stalePath = candidate;
                    }
                }
                if (staleBuffer) {
                    if (this.logger) this.logger(`Cache expired for ${spec.url} (${stalePath}), redownloading...`);
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
                const { buffer } = await this.downloadWithFallbacks(
                    spec.url, spec.fallbackUrls, task, true, spec.headers,
                    undefined, validateCandidate ? (buffer) => validateSource(spec, buffer) : undefined,
                );
                return { buffer, source: "network" };
            } catch (error) {
                if (!this.staleIfError || !staleBuffer) throw error;
                if (this.logger) this.logger(`Using stale cache for ${spec.url}: ${error instanceof Error ? error.message : String(error)}`);
                return { buffer: staleBuffer, source: "stale-cache" };
            }
        };
        const acquiredInSpecOrder = await mapWithConcurrency(specs, STATIC_ACQUIRE_CONCURRENCY, (spec) => acquireSource(spec));
        const acquiredBySource = new Map<string, AcquiredSource>();
        specs.forEach((spec, specIndex) => {
            const acquired = acquiredInSpecOrder[specIndex];
            acquiredBySource.set(spec.sourceKey, acquired);
        });

        // Expand back to feedList order so buffers/results/snapshot key stay ordered.
        const loadAcquired = async (): Promise<GTFSStaticLoadResult[]> => {
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
            // Match exact ZIP bytes and parsing options. Transport cache age and
            // stale-if-error decisions above still apply before the binary lookup.
            let compiledPath: string | undefined;
            let compiledPrefix: string | undefined;
            if (this.cache && this.compiledCache) {
                const optionsKey = crypto.createHash('sha256').update(JSON.stringify([
                    'qdf-static-v4', feedIds, this.mergeStrategy, this.filesToLoad ?? null,
                    this.skipStopTimes, this.maxExtractedEntryBytes,
                ])).digest('hex');
                compiledPrefix = `.qdf-static-${optionsKey}-`;
                // A first download has no reusable binary and will not write one.
                // Avoid hashing every archive unless this group can benefit.
                const archiveCacheHit = results.every((result) => result.source !== 'network');
                const existing = archiveCacheHit ? [] : await fsp.readdir(cacheDir).catch(() => []);
                if (archiveCacheHit || existing.some((name) => name.startsWith(compiledPrefix!) && name.endsWith('.bin'))) {
                    const content = crypto.createHash('sha256');
                    for (const buffer of buffers) {
                        content.update(`${buffer.length}:`);
                        for (let offset = 0; offset < buffer.length; offset += 8 * 1024 * 1024) {
                            content.update(buffer.subarray(offset, offset + 8 * 1024 * 1024));
                            await new Promise<void>((resolve) => setImmediate(resolve));
                        }
                    }
                    compiledPath = path.join(cacheDir, `${compiledPrefix}${content.digest('hex')}.bin`);
                }
            }
            let restored = false;
            if (compiledPath) {
                try {
                    await this.loadCompiledSnapshotAsync(compiledPath);
                    restored = true;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && this.logger) {
                        this.logger(`Compiled cache unavailable; parsing ZIPs: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }
            if (!restored) {
                // Initial downloads take the uncached path without adding snapshot
                // writes. Build the binary only on a subsequent archive-cache hit.
                let savePath: string | undefined;
                if (compiledPath && results.every((result) => result.source !== 'network')) {
                    try { await fsp.mkdir(cacheDir, { recursive: true }); savePath = compiledPath; } catch {}
                }
                await this.parseBuffers(buffers, feedIds, savePath);
            }
            if (compiledPath && compiledPrefix) {
                // Keep the current content plus one prior feed version. Only this
                // exact feed/options group is touched; raw archives stay canonical.
                void this.pruneCompiledSnapshots(cacheDir, compiledPrefix, compiledPath).catch(() => {});
            }
            return results;
        };
        let results: GTFSStaticLoadResult[];
        try { results = await loadAcquired(); }
        catch (error) {
            let recovered = false;
            for (const spec of specs) {
                try { await validateSource(spec, acquiredBySource.get(spec.sourceKey)!.buffer); }
                catch (validationError) {
                    try { acquiredBySource.set(spec.sourceKey, await acquireSource(spec, true)); }
                    catch (recoveryError) {
                        const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
                        throw new Error(`Static source ${spec.feedIds.join(', ')} failed validation (${describe(validationError)}) and recovery (${describe(recoveryError)})`, { cause: recoveryError });
                    }
                    recovered = true;
                }
            }
            // A cross-source merge error is not a failed transport candidate.
            if (!recovered) throw error;
            results = await loadAcquired();
        }
        const pendingCacheWrites = specs.flatMap((spec) => {
            const acquired = acquiredBySource.get(spec.sourceKey)!;
            return acquired.source === "network" && this.cache && spec.cachePath
                ? [{ cacheDir, cachePath: spec.cachePath, buffer: acquired.buffer }] : [];
        });
		// Only replace durable caches after every downloaded ZIP parsed successfully.
		// Temp files live beside the final cache entry (same filesystem for an
		// atomic rename) and use a `.tmp.<pid>.<uuid>` suffix so crashed
		// writers are easy to identify and never mistaken for a cache entry.
		// Only the failing writer removes its own temp file; a successful
		// rename leaves no temp behind.
		for (const { cacheDir, cachePath, buffer } of pendingCacheWrites) {
			const temporaryPath = `${cachePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
			try {
				await fsp.mkdir(cacheDir, { recursive: true });
				await fsp.writeFile(temporaryPath, buffer);
				await fsp.rename(temporaryPath, cachePath);
			} catch (error) {
				try { await fsp.unlink(temporaryPath); } catch {}
				throw error;
			}
		}
		return results;
    }

    async loadFromPath(paths: string[], feedIds: string[]): Promise<void> {
        const buffers = paths.map(p => fs.readFileSync(p));
        return this.loadFromBuffers(buffers, feedIds);
    }

    loadFromBuffers(buffers: Buffer[], feedIds: string[]): Promise<void> {
        return this.parseBuffers(buffers, feedIds);
    }

    private parseBuffers(buffers: Buffer[], feedIds: string[], compiledPath?: string): Promise<void> {
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

        const ALL_FILES = ['agency.txt','routes.txt','trips.txt','stops.txt','stop_times.txt','calendar.txt','calendar_dates.txt','transfers.txt','frequencies.txt','shapes.txt','feed_info.txt','occupancies.txt'];
        let effectiveFiles: string[] = this.filesToLoad ? [...this.filesToLoad] : [];
        if (this.skipStopTimes && effectiveFiles.length === 0) {
            effectiveFiles = ALL_FILES.filter(f => f !== 'stop_times.txt');
        } else if (this.skipStopTimes) {
            effectiveFiles = effectiveFiles.filter(f => f !== 'stop_times.txt');
        }

        // loadStatic handles binary-cache identity; direct buffers always parse.
        return this.addonInstance.loadFromBuffers(
			buffers,
			this.mergeStrategy,
			this.logger,
			this.ansi,
			progressBridge,
			feedIds,
			effectiveFiles,
			this.maxExtractedEntryBytes,
            compiledPath,
		)
            .then((result: void) => {
                this.serviceDatesCache = null;
                return result;
            });
    }

    private async pruneCompiledSnapshots(cacheDir: string, prefix: string, current: string): Promise<void> {
        // A failed/disabled write must not evict the last usable version.
        await fsp.stat(current);
        const entries = (await fsp.readdir(cacheDir)).filter((name) => name.startsWith(prefix) && name.endsWith('.bin'));
        const files = await Promise.all(entries.map(async (name) => {
            const file = path.join(cacheDir, name);
            return { file, modified: (await fsp.stat(file)).mtimeMs };
        }));
        const older = files.filter(({ file }) => file !== current).sort((a, b) => b.modified - a.modified);
        await Promise.all(older.slice(1).map(({ file }) => fsp.unlink(file).catch(() => {})));
    }

    /** Validate and load a static binary without blocking the JS event loop. */
    async loadCompiledSnapshotAsync(filePath: string): Promise<void> {
        if (!filePath?.trim()) throw new Error('Compiled snapshot path must be non-empty');
        const size = (await fsp.stat(filePath)).size;
        if (size < 32) throw new Error(`Compiled snapshot '${filePath}' is too small (${size} bytes)`);
        await this.addonInstance.loadCompiledSnapshotAsync(filePath);
        this.serviceDatesCache = null;
        this.lastRealtimeRevision = this.addonInstance.getSnapshotRevision().realtime_revision ?? this.lastRealtimeRevision;
    }

    getSnapshotRevision(): { realtime_revision: number; stop_time_count: number; trip_count: number } {
        return this.addonInstance.getSnapshotRevision();
    }
    getStaticSnapshotInfo(): { stop_time_count: number; trip_count: number; realtime_revision: number } {
        return this.addonInstance.getStaticSnapshotInfo();
    }
    saveCompiledSnapshot(filePath: string): void {
        if (!filePath?.trim()) throw new Error('Compiled snapshot path must be non-empty');
        return this.addonInstance.saveCompiledSnapshot(filePath);
    }
    loadCompiledSnapshot(filePath: string): void {
        if (!filePath?.trim()) throw new Error('Compiled snapshot path must be non-empty');
        // Fail fast on a missing/truncated file so the live snapshot is never
        // touched. The native loader stages into a new snapshot and only
        // publishes after validation, but a JS-side pre-check keeps the error
        // local and avoids clearing JS caches on failure.
        try {
            const size = fs.statSync(filePath).size;
            if (size < 32) throw new Error(`Compiled snapshot '${filePath}' is too small (${size} bytes)`);
        } catch (error) {
            if (error instanceof Error && /too small/.test(error.message)) throw error;
            throw new Error(`Cannot read compiled snapshot '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
        }
        const previousRevision = this.lastRealtimeRevision;
        this.addonInstance.loadCompiledSnapshot(filePath);
        // Native load preserves the realtime overlay; keep the JS aggregate
        // instead of destructively clearing it. Only derived static caches
        // are invalidated.
        this.serviceDatesCache = null;
        try {
            this.lastRealtimeRevision = this.addonInstance.getSnapshotRevision().realtime_revision ?? previousRevision;
        } catch {
            this.lastRealtimeRevision = previousRevision;
        }
    }

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
        this.lastChangedTripIds = [];
        this.lastRealtimeRevision = this.addonInstance.getSnapshotRevision().realtime_revision ?? 0;
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
        if (this.serviceDatesCache) return this.serviceDatesCache;

        const calendars = this.getCalendars();
        const calendarDates = this.getCalendarDates();
        const serviceDates = new Map<string, Set<string>>();
        // Services often share a calendar pattern. Expand it once, but keep
        // each service's date set separate so exceptions cannot cross feeds.
        const expandedPatterns = new Map<string, string[]>();

        for (const calendar of calendars) {
            const { service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date } =
                calendar;

            const key = this.qualifiedKey(calendar.feed_id, service_id);
            if (!serviceDates.has(key)) serviceDates.set(key, new Set());
            const weekdays = [sunday, monday, tuesday, wednesday, thursday, friday, saturday];
            const patternKey = JSON.stringify([start_date, end_date, ...weekdays]);
            let expandedDates = expandedPatterns.get(patternKey);
            if (!expandedDates) {
                expandedDates = [];
                const sDateStr = String(start_date);
                const eDateStr = String(end_date);
                const currentDate = new Date(
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
                    if (weekdays[currentDate.getUTCDay()]) {
                        const y = currentDate.getUTCFullYear();
                        const m = currentDate.getUTCMonth() + 1;
                        const d = currentDate.getUTCDate();
                        expandedDates.push(`${y}${m < 10 ? '0' : ''}${m}${d < 10 ? '0' : ''}${d}`);
                    }
                    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
                }
                expandedPatterns.set(patternKey, expandedDates);
            }
            const datesForService = serviceDates.get(key)!;
            for (const date of expandedDates) datesForService.add(date);
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
        for (const [key, dates] of serviceDates) {
            sortedServiceDates.set(key, [...dates].sort());
        }

        this.serviceDatesCache = sortedServiceDates;
        return sortedServiceDates;
    }

    getTrips(filter?: TripQuery | Partial<Trip>): Trip[] {
        return this.addonInstance.getTrips(filter || {});
    }

    getTransfers(filter?: TransferQuery | Partial<Transfer>): Transfer[] {
        return this.addonInstance.getTransfers(filter || {});
    }

    getFrequencies(filter?: { trip_id?: string; feed_id?: string }): Frequency[] {
        return this.addonInstance.getFrequencies(filter || {});
    }

    getShapes(filter?: Partial<Shape>): Shape[] {
        return this.addonInstance.getShapes(filter);
    }

    getShapesPacked(filter?: Partial<Pick<Shape, 'feed_id' | 'shape_id'>>): PackedShapes {
        return this.addonInstance.getShapesPacked(filter);
    }

    getCalendars(filter?: Partial<Calendar>): Calendar[] {
        return this.addonInstance.getCalendars(filter);
    }

    getCalendarDates(filter?: Partial<CalendarDate>): CalendarDate[] {
        return this.addonInstance.getCalendarDates(filter);
    }

    getServiceDates(service: QualifiedEntityId): string[] {
        return [...(this.getServiceDatesMap().get(this.qualifiedKey(service.feedId, service.localId)) ?? [])];
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
     * The whole aggregate is bounded by a total deadline (`timeoutMs` override
     * or `realtimeTimeoutMs`/`requestTimeoutMs`); per-request timeouts still
     * apply to each download. Fallback URLs are tried in order per source.
     */
    async fetchRealtimeSources(sources: GTFSRealtimeFeedConfig[], options?: RealtimeFetchOptions): Promise<FetchedRealtimeSource[]> {
        if (sources.length === 0) return [];
        for (const source of sources) validateFeedFallbacks(source);
        const deadlineMs = this.realtimeDeadlineMs(options?.timeoutMs);
        const controller = new AbortController();
        // A cycle intentionally shares this signal across every source and redirect.
        setMaxListeners(0, controller.signal);
        const fetches = Promise.all(sources.map(async (source) => {
            try {
                const { buffer } = await this.downloadWithFallbacks(
                    source.url,
                    source.fallbackUrls ?? [],
                    `Downloading ${source.kind}`,
                    false,
                    source.headers,
                    controller.signal,
                );
                return { source, ok: true as const, data: buffer };
            } catch (error) {
                return { source, ok: false as const, error: error instanceof Error ? error.message : String(error) };
            }
        }));
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                const error = new Error(`Realtime fetch timed out after ${deadlineMs}ms`);
                controller.abort(error);
                reject(error);
            }, deadlineMs);
            timer.unref?.();
        });
        try {
            return await Promise.race([fetches, timeout]);
        } catch (error) {
            controller.abort(error);
            // Wait for aborted requests to settle before allowing another cycle.
            await fetches;
            throw error;
        } finally {
            if (timer) clearTimeout(timer);
        }
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

    async updateRealtimeFromUrl(sources: GTFSRealtimeFeedConfig[], options?: RealtimeFetchOptions): Promise<GTFSRealtimeLoadResult[]> {
		return this.applyRealtimePayloads(await this.fetchRealtimeSources(sources, options));
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
		this.lastChangedTripIds = [];
		this.lastRealtimeRevision = this.addonInstance.getSnapshotRevision().realtime_revision ?? 0;
	}

    private download(
        url: string,
        taskName: string = "Downloading",
        showProgressBar: boolean = true,
        headers?: Record<string, string>,
        redirects: number = 0,
        connectionAttempt: number = 0,
        resolvedAddresses?: dns.LookupAddress[],
        signal?: AbortSignal,
    ): Promise<Buffer> {
        return new Promise((resolvePromise, rejectPromise) => {
            signal?.throwIfAborted();
            let connectionTimer: NodeJS.Timeout | undefined;
            const cleanup = () => {
                if (connectionTimer) clearTimeout(connectionTimer);
                signal?.removeEventListener('abort', onAbort);
            };
            const resolve = (buffer: Buffer) => { cleanup(); resolvePromise(buffer); };
            const reject = (error: unknown) => { cleanup(); rejectPromise(error); };
            const onAbort = () => reject(signal?.reason ?? new Error('Download aborted'));
            signal?.addEventListener('abort', onAbort, { once: true });
            let receivedResponse = false;
            const onResponse = (res: any) => {
                receivedResponse = true;
                if (connectionTimer) clearTimeout(connectionTimer);
                res.on('error', (err: Error) => reject(err));
                if (res.statusCode !== 200) {
					if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
						if (redirects >= 5) { res.destroy(); reject(new Error(`Too many redirects downloading ${url}`)); return; }
                        const currentUrl = new URL(url);
                        const redirectUrl = new URL(res.headers.location as string, currentUrl);
                        if (this.logger) this.logger(`Redirected to ${res.headers.location}`);
						res.destroy();
						redirectHeaders(currentUrl, redirectUrl, headers, resolvedAddresses)
                            .then((redirect) => this.download(redirectUrl.toString(), taskName, showProgressBar, redirect.headers, redirects + 1, connectionAttempt, redirect.addresses, signal))
                            .then(resolve)
                            .catch(reject);
                        return;
                    }
					res.destroy();
                    reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
                    return;
                }

                const total = parseInt(res.headers['content-length'] || '0', 10);
                if (Number.isFinite(total) && total > this.maxDownloadBytes) {
                    res.destroy();
                    reject(new Error(`Download exceeds ${this.maxDownloadBytes} byte limit`));
                    return;
                }
                let current = 0;
                const data: Buffer[] = [];
                let received = Number.isSafeInteger(total) && total > 0 ? Buffer.allocUnsafe(total) : null;
                const startTime = Date.now();
				this.lastProgressUpdate = 0;
				this.lastProgressByTask.delete(taskName);
				this.showProgress(taskName, 0, total, 0, 0);

                res.on('data', (chunk: Buffer) => {
                    const previous = current;
                    current += chunk.length;
                    if (current > this.maxDownloadBytes) {
                        res.destroy(new Error(`Download exceeds ${this.maxDownloadBytes} byte limit`));
                        return;
                    }
                    if (received && current <= received.length) {
                        chunk.copy(received, previous);
                    } else {
                        if (received) {
                            data.push(received.subarray(0, previous));
                            received = null;
                        }
                        data.push(chunk);
                    }

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
                    resolve(received ? received.subarray(0, current) : data.length === 1 ? data[0] : Buffer.concat(data, current))
                });
            };

            try {
                const parsedUrl = new URL(url);
                if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
                    throw new Error(`Unsupported download protocol ${parsedUrl.protocol}`);
                }
                const client = parsedUrl.protocol === 'https:' ? https : http;
				const req = client.get(url, {
					headers,
                    signal,
                    lookup: resolvedAddresses ? ((_hostname: string, options: any, callback: any) => {
                        if (options?.all) {
                            callback(null, resolvedAddresses);
                            return;
                        }
                        const requestedFamily = typeof options === 'number' ? options : options?.family;
                        const selected = resolvedAddresses.find((entry) => !requestedFamily || entry.family === requestedFamily) ?? resolvedAddresses[0];
                        callback(null, selected.address, selected.family);
                    }) : undefined,
				}, onResponse);
				connectionTimer = setTimeout(
					() => req.destroy(new Error(`Timed out connecting to ${url}`)),
					Math.min(this.requestTimeoutMs, 10_000),
				);
				req.on('error', (err: Error) => {
					if (connectionTimer) clearTimeout(connectionTimer);
					if (!signal?.aborted && !receivedResponse && connectionAttempt < 2) {
						this.download(url, taskName, showProgressBar, headers, redirects, connectionAttempt + 1, resolvedAddresses, signal)
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
