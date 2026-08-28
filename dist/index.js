import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import { inflateRawSync } from 'zlib';
import { GTFSMergeStrategy } from './types.js';
export * from './types.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const r = createRequire(import.meta.url);
let GTFSAddon;
try {
    try {
        const binding = r(path.join(__dirname, './build/Release/gtfs_addon.node'));
        GTFSAddon = binding.GTFSAddon;
    }
    catch (e) {
        try {
            const binding = r(path.join(__dirname, '../build/Release/gtfs_addon.node'));
            GTFSAddon = binding.GTFSAddon;
        }
        catch (e2) {
            if (process.env.NODE_ENV === 'test') {
                GTFSAddon = class MockAddon {
                    loadFromBuffers() { }
                    getFeedInfo() { return []; }
                    getRoutes() { return []; }
                    getAgencies() { return []; }
                    getStops() { return []; }
                    getStopTimes() { return []; }
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
                };
            }
            else {
                throw e;
            }
        }
    }
}
catch (e) {
    console.error("Could not load native addon");
    throw e;
}
function formatBytes(bytes) {
    if (bytes === 0)
        return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)).toFixed(2) + ' ' + sizes[i];
}
function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0)
        return "--:--";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
function readVarint(buffer, cursor) {
    let value = 0, shift = 0;
    while (cursor.offset < buffer.length && shift < 53) {
        const byte = buffer[cursor.offset++];
        value += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0)
            return value;
        shift += 7;
    }
    throw new Error('Invalid GTFS-RT protobuf varint');
}
function protobufMessages(buffer, fieldNumber) {
    const result = [], cursor = { offset: 0 };
    while (cursor.offset < buffer.length) {
        const tag = readVarint(buffer, cursor), field = Math.floor(tag / 8), wire = tag & 7;
        if (wire === 0)
            readVarint(buffer, cursor);
        else if (wire === 1)
            cursor.offset += 8;
        else if (wire === 2) {
            const length = readVarint(buffer, cursor), end = cursor.offset + length;
            if (end > buffer.length)
                throw new Error('Truncated GTFS-RT protobuf field');
            if (field === fieldNumber)
                result.push(buffer.subarray(cursor.offset, end));
            cursor.offset = end;
        }
        else if (wire === 5)
            cursor.offset += 4;
        else
            throw new Error(`Unsupported GTFS-RT protobuf wire type ${wire}`);
    }
    return result;
}
function protobufScalar(buffer, fieldNumber) {
    const cursor = { offset: 0 };
    while (cursor.offset < buffer.length) {
        const tag = readVarint(buffer, cursor), field = Math.floor(tag / 8), wire = tag & 7;
        if (wire === 0) {
            const value = readVarint(buffer, cursor);
            if (field === fieldNumber)
                return value;
        }
        else if (wire === 1)
            cursor.offset += 8;
        else if (wire === 2) {
            const length = readVarint(buffer, cursor);
            cursor.offset += length;
        }
        else if (wire === 5)
            cursor.offset += 4;
        else
            throw new Error(`Unsupported GTFS-RT protobuf wire type ${wire}`);
    }
    return null;
}
function protobufString(buffer, fieldNumber) {
    return protobufMessages(buffer, fieldNumber)[0]?.toString('utf8') ?? '';
}
/**
 * Decode carriage details from a standalone vehicle feed.
 *
 * @deprecated GTFS.updateRealtime parses these details natively. Keep this
 * helper for callers that still decode a raw vehicle feed directly.
 */
export function parseGtfsRtMultiCarriageDetails(feed) {
    const result = new Map();
    for (const entity of protobufMessages(feed, 2)) {
        const id = protobufString(entity, 1);
        const vehicle = protobufMessages(entity, 4)[0];
        if (!id || !vehicle)
            continue;
        const carriages = protobufMessages(vehicle, 11).map((carriage) => ({
            id: protobufString(carriage, 1),
            label: protobufString(carriage, 2),
            occupancy_status: protobufScalar(carriage, 3),
            occupancy_percentage: protobufScalar(carriage, 4),
            carriage_sequence: protobufScalar(carriage, 5),
        }));
        if (carriages.length)
            result.set(id, carriages);
    }
    return result;
}
/** Extract one file from a ZIP without adding a second ZIP dependency. */
export function extractZipEntry(archive, requestedEntry) {
    const entry = requestedEntry.replace(/^\/+/, '');
    if (!entry || entry.includes('\\'))
        throw new Error(`Invalid ZIP archive entry '${requestedEntry}'`);
    // Locate EOCD in the final 64 KiB plus its fixed-size header.
    const firstPossibleEocd = Math.max(0, archive.length - 65_557);
    let eocd = -1;
    for (let offset = archive.length - 22; offset >= firstPossibleEocd; offset--) {
        if (archive.readUInt32LE(offset) === 0x06054b50) {
            eocd = offset;
            break;
        }
    }
    if (eocd < 0)
        throw new Error('Downloaded file is not a valid ZIP archive (end record missing)');
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
            if (!result)
                throw new Error(`ZIP archive entry '${entry}' uses unsupported compression method ${compression}`);
            if (result.length !== uncompressedSize)
                throw new Error(`ZIP archive entry '${entry}' has an invalid uncompressed size`);
            return result;
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    throw new Error(`ZIP archive entry '${entry}' was not found`);
}
export class GTFS {
    addonInstance;
    logger;
    progressCallback;
    ansi;
    cacheDir;
    cache;
    mergeStrategy;
    lastProgressUpdate = 0;
    filesToLoad;
    skipStopTimes;
    cacheMaxAgeMs;
    staleIfError;
    requestTimeoutMs;
    serviceDatesCache = null;
    serviceDatesSets = null;
    serviceIdsByDateCache = null;
    tripsByServiceIdCache = null;
    actions = {
        mergeStops: (targetStopId, sourceStopIds, feed_id) => {
            this.addonInstance.mergeStops(targetStopId, sourceStopIds, feed_id);
        },
        updateStop: (stop_id, partialStop, feed_id) => {
            return this.addonInstance.updateStop(stop_id, partialStop, feed_id);
        }
    };
    constructor(options) {
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
    showProgress(task, current, total, speed, eta) {
        const now = Date.now();
        if (now - this.lastProgressUpdate < 100 && (total <= 0 || current < total)) {
            return;
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
    async loadStatic(feeds) {
        const feedList = Array.isArray(feeds) ? feeds : [feeds];
        if (feedList.length === 0)
            throw new Error('At least one GTFS feed is required');
        if (feedList.some((feed) => !feed.id?.trim()))
            throw new Error('GTFS feed IDs must be non-empty');
        if (new Set(feedList.map((feed) => feed.id)).size !== feedList.length)
            throw new Error('GTFS feed IDs must be unique');
        const buffers = [];
        const results = [];
        const pendingCacheWrites = [];
        const sourceBuffers = new Map();
        for (const config of feedList) {
            let buffer = null;
            let staleBuffer = null;
            let loadedFrom = "network";
            const cacheDir = this.cacheDir || './cache';
            let cachePath = '';
            const sourceKey = `${config.url}|${JSON.stringify(config.headers ?? {})}`;
            const shared = sourceBuffers.get(sourceKey);
            if (shared) {
                buffer = shared.buffer;
                loadedFrom = shared.source;
                if (this.logger)
                    this.logger(`Reusing downloaded GTFS archive for ${config.id}`);
            }
            if (!buffer && this.cache) {
                const hash = crypto.createHash('md5').update(sourceKey).digest('hex');
                cachePath = path.join(cacheDir, hash);
                const legacyHash = crypto.createHash('md5').update(`${sourceKey}|${config.archiveEntry ?? ''}`).digest('hex');
                const legacyCachePath = path.join(cacheDir, legacyHash);
                const readableCachePath = fs.existsSync(cachePath) ? cachePath : legacyCachePath;
                if (fs.existsSync(readableCachePath)) {
                    const stats = fs.statSync(readableCachePath);
                    const age = Date.now() - stats.mtimeMs;
                    try {
                        staleBuffer = fs.readFileSync(readableCachePath);
                    }
                    catch (e) {
                        if (this.logger)
                            this.logger(`Failed to read cache: ${e}`);
                    }
                    if (age < this.cacheMaxAgeMs && staleBuffer) {
                        if (this.logger)
                            this.logger(`Loading from cache: ${readableCachePath}`);
                        buffer = staleBuffer;
                        loadedFrom = "fresh-cache";
                    }
                    else {
                        if (this.logger)
                            this.logger(`Cache expired for ${config.url}, redownloading...`);
                    }
                }
            }
            if (!buffer) {
                if (this.logger) {
                    if (this.ansi) {
                        this.logger(`\x1b[32mDownloading ${config.url}...\x1b[0m`);
                    }
                    else {
                        this.logger(`Downloading ${config.url}...`);
                    }
                }
                try {
                    const task = `Downloading GTFS (${config.id})`;
                    this.lastProgressUpdate = 0;
                    this.showProgress(`Connecting to GTFS (${config.id})`, 0, 0, 0, 0);
                    buffer = await this.download(config.url, task, true, config.headers);
                    loadedFrom = "network";
                }
                catch (error) {
                    if (!this.staleIfError || !staleBuffer)
                        throw error;
                    buffer = staleBuffer;
                    loadedFrom = "stale-cache";
                    if (this.logger)
                        this.logger(`Using stale cache for ${config.url}: ${error instanceof Error ? error.message : String(error)}`);
                }
                if (loadedFrom === "network" && this.cache && cachePath) {
                    pendingCacheWrites.push({ cacheDir, cachePath, buffer });
                }
            }
            if (!sourceBuffers.has(sourceKey))
                sourceBuffers.set(sourceKey, { buffer: buffer, source: loadedFrom });
            if (config.archiveEntry) {
                this.lastProgressUpdate = 0;
                this.showProgress(`Extracting GTFS (${config.id})`, 0, 0, 0, 0);
                const extracted = extractZipEntry(buffer, config.archiveEntry);
                this.showProgress(`Extracting GTFS (${config.id})`, extracted.length, extracted.length, 0, 0);
                buffers.push(extracted);
            }
            else {
                buffers.push(buffer);
            }
            results.push({ id: config.id, source: loadedFrom });
        }
        const feedIds = feedList.map((feed) => feed.id);
        await this.loadFromBuffers(buffers, feedIds);
        // Only replace durable caches after every downloaded ZIP parsed successfully.
        for (const { cacheDir, cachePath, buffer } of pendingCacheWrites) {
            if (!fs.existsSync(cacheDir))
                fs.mkdirSync(cacheDir, { recursive: true });
            const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
            try {
                fs.writeFileSync(temporaryPath, buffer);
                fs.renameSync(temporaryPath, cachePath);
            }
            finally {
                if (fs.existsSync(temporaryPath))
                    fs.unlinkSync(temporaryPath);
            }
        }
        return results;
    }
    async loadFromPath(paths, feedIds) {
        const buffers = paths.map(p => fs.readFileSync(p));
        return this.loadFromBuffers(buffers, feedIds);
    }
    loadFromBuffers(buffers, feedIds) {
        if (buffers.length === 0)
            throw new Error('At least one GTFS buffer is required');
        if (feedIds.length !== buffers.length) {
            throw new Error(`Expected one feed ID per GTFS buffer; received ${feedIds.length} IDs for ${buffers.length} buffers`);
        }
        if (feedIds.some((feedId) => !feedId.trim()))
            throw new Error('GTFS feed IDs must be non-empty');
        if (new Set(feedIds).size !== feedIds.length)
            throw new Error('GTFS feed IDs must be unique');
        const startTime = Date.now();
        const progressBridge = (task, current, total) => {
            const now = Date.now();
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? current / elapsed : 0;
            const remaining = total - current;
            const eta = speed > 0 ? remaining / speed : 0;
            this.showProgress(task, current, total, speed, eta);
        };
        const ALL_FILES = ['agency.txt', 'routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'transfers.txt', 'shapes.txt', 'feed_info.txt', 'occupancies.txt'];
        let effectiveFiles = this.filesToLoad ? [...this.filesToLoad] : [];
        if (this.skipStopTimes && effectiveFiles.length === 0) {
            effectiveFiles = ALL_FILES.filter(f => f !== 'stop_times.txt');
        }
        else if (this.skipStopTimes) {
            effectiveFiles = effectiveFiles.filter(f => f !== 'stop_times.txt');
        }
        return this.addonInstance.loadFromBuffers(buffers, this.mergeStrategy, this.logger, this.ansi, progressBridge, feedIds, effectiveFiles)
            .then((result) => {
            this.serviceDatesCache = null;
            this.serviceDatesSets = null;
            this.serviceIdsByDateCache = null;
            this.tripsByServiceIdCache = null;
            return result;
        });
    }
    getRoutes(filter) {
        return this.addonInstance.getRoutes(filter);
    }
    getAgencies(filter) {
        return this.addonInstance.getAgencies(filter);
    }
    getStops(filter) {
        return this.addonInstance.getStops(filter);
    }
    getStopTimes(query) {
        return this.addonInstance.getStopTimes(query || {});
    }
    getTripStopTimeBounds() {
        return this.addonInstance.getTripStopTimeBounds();
    }
    getStaticOccupancies(query) {
        return this.addonInstance.getStaticOccupancies(query);
    }
    getFeedInfo() {
        return this.addonInstance.getFeedInfo();
    }
    qualifiedKey(feedId, localId) {
        return `${feedId.length}:${feedId}${localId}`;
    }
    getServiceDatesMap() {
        if (this.serviceDatesCache && this.serviceDatesSets && this.serviceIdsByDateCache)
            return this.serviceDatesCache;
        const calendars = this.getCalendars();
        const calendarDates = this.getCalendarDates();
        const serviceDates = new Map();
        for (const calendar of calendars) {
            const { service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date } = calendar;
            const key = this.qualifiedKey(calendar.feed_id, service_id);
            if (!serviceDates.has(key))
                serviceDates.set(key, new Set());
            const sDateStr = String(start_date);
            const eDateStr = String(end_date);
            let currentDate = new Date(Date.UTC(Number(sDateStr.substring(0, 4)), Number(sDateStr.substring(4, 6)) - 1, Number(sDateStr.substring(6, 8))));
            const endDate = new Date(Date.UTC(Number(eDateStr.substring(0, 4)), Number(eDateStr.substring(4, 6)) - 1, Number(eDateStr.substring(6, 8))));
            while (currentDate <= endDate) {
                const dayOfWeek = currentDate.getUTCDay(); // 0 for Sunday, 1 for Monday, etc.
                let serviceRuns = false;
                if (dayOfWeek === 1 && monday)
                    serviceRuns = true;
                else if (dayOfWeek === 2 && tuesday)
                    serviceRuns = true;
                else if (dayOfWeek === 3 && wednesday)
                    serviceRuns = true;
                else if (dayOfWeek === 4 && thursday)
                    serviceRuns = true;
                else if (dayOfWeek === 5 && friday)
                    serviceRuns = true;
                else if (dayOfWeek === 6 && saturday)
                    serviceRuns = true;
                else if (dayOfWeek === 0 && sunday)
                    serviceRuns = true;
                if (serviceRuns) {
                    const y = currentDate.getUTCFullYear();
                    const m = currentDate.getUTCMonth() + 1;
                    const d = currentDate.getUTCDate();
                    const dateStr = `${y}${m < 10 ? '0' : ''}${m}${d < 10 ? '0' : ''}${d}`;
                    serviceDates.get(key).add(dateStr);
                }
                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }
        }
        for (const calendarDate of calendarDates) {
            const { service_id, date, exception_type } = calendarDate;
            if (!date)
                continue;
            const key = this.qualifiedKey(calendarDate.feed_id, service_id);
            if (!serviceDates.has(key))
                serviceDates.set(key, new Set());
            if (exception_type === 1) {
                serviceDates.get(key).add(date);
            }
            else if (exception_type === 2) {
                serviceDates.get(key).delete(date);
            }
        }
        const sortedServiceDates = new Map();
        const idsByDate = new Map();
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
    getTripsByServiceId() {
        if (this.tripsByServiceIdCache)
            return this.tripsByServiceIdCache;
        const allTrips = this.addonInstance.getTrips({});
        const map = new Map();
        for (const trip of allTrips) {
            const key = this.qualifiedKey(trip.feed_id, trip.service_id);
            const trips = map.get(key) ?? [];
            trips.push(trip);
            map.set(key, trips);
        }
        this.tripsByServiceIdCache = map;
        return map;
    }
    getTrips(filter) {
        return this.addonInstance.getTrips(filter || {});
    }
    getTransfers(filter) {
        return this.addonInstance.getTransfers(filter || {});
    }
    getShapes(filter) {
        return this.addonInstance.getShapes(filter);
    }
    getCalendars(filter) {
        return this.addonInstance.getCalendars(filter);
    }
    getCalendarDates(filter) {
        return this.addonInstance.getCalendarDates(filter);
    }
    getServiceDates(service) {
        return this.getServiceDatesMap().get(this.qualifiedKey(service.feedId, service.localId)) ?? [];
    }
    getServiceDatesByTrip(trip) {
        const trips = this.getTrips({ trip_id: trip.localId, feed_id: trip.feedId });
        if (trips.length === 0)
            return [];
        return this.getServiceDates({ feedId: trips[0].feed_id, localId: trips[0].service_id });
    }
    /** Replace the supplied realtime source and return compact change metadata. */
    updateRealtime(input) {
        return this.addonInstance.updateRealtime(input.kind === "alerts" ? input.data : [], input.kind === "trip-updates" ? input.data : [], input.kind === "vehicles" ? input.data : [], input.targetFeedId, input.sourceId);
    }
    async updateRealtimeFromUrl(sources) {
        return Promise.all(sources.map(async (source) => {
            try {
                const data = await this.download(source.url, `Downloading ${source.kind}`, false, source.headers);
                const refresh = this.updateRealtime({ kind: source.kind, data, targetFeedId: source.targetFeedId, sourceId: source.id });
                return { id: source.id, ok: true, refresh };
            }
            catch (error) {
                return { id: source.id, ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        }));
    }
    getRealtimeTripUpdates(filter) {
        return this.addonInstance.getRealtimeTripUpdates(filter || {});
    }
    getRealtimeVehiclePositions(filter) {
        return this.addonInstance.getRealtimeVehiclePositions(filter || {});
    }
    getRealtimeAlerts(filter) {
        return this.addonInstance.getRealtimeAlerts(filter || {});
    }
    clearRealtime(filter = {}) {
        this.addonInstance.clearRealtime(filter.targetFeedId || "", filter.sourceId || "");
    }
    download(url, taskName = "Downloading", showProgressBar = true, headers, redirects = 0, connectionAttempt = 0) {
        return new Promise((resolve, reject) => {
            let connectionTimer;
            let receivedResponse = false;
            const onResponse = (res) => {
                receivedResponse = true;
                if (connectionTimer)
                    clearTimeout(connectionTimer);
                res.on('error', (err) => reject(err));
                if (res.statusCode !== 200) {
                    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                        if (redirects >= 5) {
                            reject(new Error(`Too many redirects downloading ${url}`));
                            return;
                        }
                        if (this.logger)
                            this.logger(`Redirected to ${res.headers.location}`);
                        res.resume();
                        this.download(new URL(res.headers.location, url).toString(), taskName, showProgressBar, headers, redirects + 1, connectionAttempt).then(resolve).catch(reject);
                        return;
                    }
                    res.resume();
                    reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
                    return;
                }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let current = 0;
                const data = [];
                const startTime = Date.now();
                this.lastProgressUpdate = 0;
                this.showProgress(taskName, 0, total, 0, 0);
                res.on('data', (chunk) => {
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
                        // A number of official feeds use chunked transfer encoding. Once the
                        // stream ends, its downloaded byte count is the actual total.
                        this.showProgress(taskName, current, total || current, speed, 0);
                        if (this.ansi && process.stdout.isTTY)
                            process.stdout.write('\n');
                    }
                    resolve(Buffer.concat(data));
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
                connectionTimer = setTimeout(() => req.destroy(new Error(`Timed out connecting to ${url}`)), Math.min(this.requestTimeoutMs, 10_000));
                req.on('error', (err) => {
                    if (connectionTimer)
                        clearTimeout(connectionTimer);
                    if (!receivedResponse && connectionAttempt < 2) {
                        this.download(url, taskName, showProgressBar, headers, redirects, connectionAttempt + 1)
                            .then(resolve)
                            .catch(reject);
                        return;
                    }
                    reject(err);
                });
                req.setTimeout(this.requestTimeoutMs, () => req.destroy(new Error(`Timed out downloading ${url}`)));
            }
            catch (e) {
                if (connectionTimer)
                    clearTimeout(connectionTimer);
                reject(e);
            }
        });
    }
}
