import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
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
                    getTrips() { return []; }
                    getShapes() { return []; }
                    getCalendars() { return []; }
                    getCalendarDates() { return []; }
                    updateRealtime() { }
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
    }
    showProgress(task, current, total, speed, eta) {
        const now = Date.now();
        if (now - this.lastProgressUpdate < 100 && current < total) {
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
        const buffers = [];
        for (const config of feedList) {
            let buffer = null;
            const cacheDir = this.cacheDir || './cache';
            let cachePath = '';
            if (this.cache) {
                const keySource = config.headers ? `${config.url}|${JSON.stringify(config.headers)}` : config.url;
                const hash = crypto.createHash('md5').update(keySource).digest('hex');
                cachePath = path.join(cacheDir, hash);
                if (fs.existsSync(cachePath)) {
                    const stats = fs.statSync(cachePath);
                    const age = Date.now() - stats.mtimeMs;
                    const oneDay = 24 * 60 * 60 * 1000;
                    if (age < oneDay) {
                        if (this.logger)
                            this.logger(`Loading from cache: ${cachePath}`);
                        try {
                            buffer = fs.readFileSync(cachePath);
                        }
                        catch (e) {
                            if (this.logger)
                                this.logger(`Failed to read cache: ${e}`);
                        }
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
                buffer = await this.download(config.url, "Downloading", true, config.headers);
                if (this.cache && cachePath) {
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }
                    fs.writeFileSync(cachePath, buffer);
                }
            }
            buffers.push(buffer);
        }
        const feedIds = feedList.map((feed) => feed.id);
        return this.loadFromBuffers(buffers, feedIds);
    }
    async loadFromPath(paths, feedIds) {
        const buffers = paths.map(p => fs.readFileSync(p));
        return this.loadFromBuffers(buffers, feedIds);
    }
    loadFromBuffers(buffers, feedIds) {
        const startTime = Date.now();
        const progressBridge = (task, current, total) => {
            const now = Date.now();
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? current / elapsed : 0;
            const remaining = total - current;
            const eta = speed > 0 ? remaining / speed : 0;
            this.showProgress(task, current, total, speed, eta);
        };
        const ALL_FILES = ['agency.txt', 'routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'shapes.txt', 'feed_info.txt'];
        let effectiveFiles = this.filesToLoad ? [...this.filesToLoad] : [];
        if (this.skipStopTimes && effectiveFiles.length === 0) {
            effectiveFiles = ALL_FILES.filter(f => f !== 'stop_times.txt');
        }
        else if (this.skipStopTimes) {
            effectiveFiles = effectiveFiles.filter(f => f !== 'stop_times.txt');
        }
        return this.addonInstance.loadFromBuffers(buffers, this.mergeStrategy, this.logger, this.ansi, progressBridge, feedIds || [], effectiveFiles)
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
    updateRealtime(input) {
        this.addonInstance.updateRealtime(input.kind === "alerts" ? input.data : [], input.kind === "trip-updates" ? input.data : [], input.kind === "vehicles" ? input.data : [], input.targetFeedId, input.sourceId);
    }
    async updateRealtimeFromUrl(sources) {
        await Promise.all(sources.map(async (source) => {
            const data = await this.download(source.url, `Downloading ${source.kind}`, false, source.headers);
            this.updateRealtime({
                kind: source.kind,
                data,
                targetFeedId: source.targetFeedId,
                sourceId: source.id,
            });
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
    download(url, taskName = "Downloading", showProgressBar = true, headers) {
        return new Promise((resolve, reject) => {
            const onResponse = (res) => {
                res.on('error', (err) => reject(err));
                if (res.statusCode !== 200) {
                    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                        if (this.logger)
                            this.logger(`Redirected to ${res.headers.location}`);
                        this.download(res.headers.location, taskName, showProgressBar, headers).then(resolve).catch(reject);
                        return;
                    }
                    reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
                    return;
                }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let current = 0;
                const data = [];
                const startTime = Date.now();
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
                        this.showProgress(taskName, current, total, speed, 0);
                        if (this.ansi && process.stdout.isTTY)
                            process.stdout.write('\n');
                    }
                    resolve(Buffer.concat(data));
                });
            };
            try {
                const client = url.startsWith('https') ? https : http;
                const req = headers ? client.get(url, { headers }, onResponse) : client.get(url, onResponse);
                req.on('error', (err) => reject(err));
            }
            catch (e) {
                reject(e);
            }
        });
    }
}
