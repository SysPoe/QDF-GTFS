import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import {
    Agency, Route, Stop, StopTime, FeedInfo, Trip, Shape, Calendar, CalendarDate,
    RealtimeTripUpdate, RealtimeVehiclePosition, RealtimeAlert, StopTimeQuery, TripQuery, GTFSOptions, ProgressInfo,
    GTFSMergeStrategy, GTFSFeedConfig, GTFSActions,
    RealtimeFilter
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
                    getTrips() { return []; }
                    getShapes() { return []; }
                    getCalendars() { return []; }
                    getCalendarDates() { return []; }
                    updateRealtime() { }
                    getRealtimeTripUpdates() { return []; }
                    getRealtimeVehiclePositions() { return []; }
                    getRealtimeAlerts() { return []; }
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

export class GTFS {
    private addonInstance: any;
    private logger?: (msg: string) => void;
    private progressCallback?: (info: ProgressInfo) => void;
    private ansi: boolean;
    private cacheDir?: string;
    private cache: boolean;
    private mergeStrategy: GTFSMergeStrategy;
    private lastProgressUpdate: number = 0;
    private serviceDatesCache: Record<string, string[]> | null = null;
    private serviceDatesSets: Record<string, Set<string>> | null = null;
    private serviceIdsByDateCache: Record<string, string[]> | null = null;
    private tripsByServiceIdCache: Record<string, Trip[]> | null = null;

    public actions: GTFSActions = {
        mergeStops: (targetStopId: string, sourceStopIds: string[]) => {
            this.addonInstance.mergeStops(targetStopId, sourceStopIds);
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
    }

    private showProgress(task: string, current: number, total: number, speed: number, eta: number) {
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

    async loadStatic(feeds: (GTFSFeedConfig | string)[] | GTFSFeedConfig | string): Promise<void> {
        const feedList = Array.isArray(feeds) ? feeds : [feeds];
        const buffers: Buffer[] = [];

        for (const feed of feedList) {
            const config: GTFSFeedConfig = typeof feed === 'string' ? { url: feed } : feed;
            let buffer: Buffer | null = null;
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
                        if (this.logger) this.logger(`Loading from cache: ${cachePath}`);
                        try {
                            buffer = fs.readFileSync(cachePath);
                        } catch (e) {
                            if (this.logger) this.logger(`Failed to read cache: ${e}`);
                        }
                    } else {
                        if (this.logger) this.logger(`Cache expired for ${config.url}, redownloading...`);
                    }
                }
            }

            if (!buffer) {
                if (this.logger) {
                    if (this.ansi) {
                        this.logger(`\x1b[32mDownloading ${config.url}...\x1b[0m`);
                    } else {
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
            buffers.push(buffer as Buffer);
        }

        const feedIds = feedList.map(f => typeof f === 'string' ? '' : (f.feed_id || ''));
        return this.loadFromBuffers(buffers, feedIds);
    }

    async loadFromPath(paths: string[], feedIds?: string[]): Promise<void> {
        const buffers = paths.map(p => fs.readFileSync(p));
        return this.loadFromBuffers(buffers, feedIds);
    }

    loadFromBuffers(buffers: Buffer[], feedIds?: string[]): Promise<void> {
        const startTime = Date.now();
        const progressBridge = (task: string, current: number, total: number) => {
            const now = Date.now();
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? current / elapsed : 0;
            const remaining = total - current;
            const eta = speed > 0 ? remaining / speed : 0;
            this.showProgress(task, current, total, speed, eta);
        };

        return this.addonInstance.loadFromBuffers(buffers, this.mergeStrategy, this.logger, this.ansi, progressBridge, feedIds || [])
            .then((result: void) => {
                this.serviceDatesCache = null;
                this.serviceDatesSets = null;
                this.serviceIdsByDateCache = null;
                this.tripsByServiceIdCache = null;
                return result;
            });
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

    getFeedInfo(): FeedInfo[] {
        return this.addonInstance.getFeedInfo();
    }

    private getServiceDatesMap(): Record<string, string[]> {
        if (this.serviceDatesCache && this.serviceDatesSets && this.serviceIdsByDateCache) return this.serviceDatesCache;

        const calendars = this.getCalendars();
        const calendarDates = this.getCalendarDates();
        const serviceDates: Record<string, Set<string>> = {};

        for (const calendar of calendars) {
            const { service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date } =
                calendar;

            if (!serviceDates[service_id]) serviceDates[service_id] = new Set();

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
                    serviceDates[service_id].add(dateStr);
                }

                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }
        }

        for (const calendarDate of calendarDates) {
            const { service_id, date, exception_type } = calendarDate;
            if (!date) continue;
            if (!serviceDates[service_id]) serviceDates[service_id] = new Set();

            if (exception_type === 1) {
                serviceDates[service_id].add(date);
            } else if (exception_type === 2) {
                serviceDates[service_id].delete(date);
            }
        }

        const sortedServiceDates: Record<string, string[]> = {};
        const idsByDate: Record<string, string[]> = {};

        for (const service_id in serviceDates) {
            const dates = Array.from(serviceDates[service_id]).sort();
            sortedServiceDates[service_id] = dates;
            for (const d of dates) {
                if (!idsByDate[d]) idsByDate[d] = [];
                idsByDate[d].push(service_id);
            }
        }

        this.serviceDatesSets = serviceDates;
        this.serviceDatesCache = sortedServiceDates;
        this.serviceIdsByDateCache = idsByDate;
        return sortedServiceDates;
    }

    private getTripsByServiceId(): Record<string, Trip[]> {
        if (this.tripsByServiceIdCache) return this.tripsByServiceIdCache;
        const allTrips = this.addonInstance.getTrips({});
        const map: Record<string, Trip[]> = {};
        for (const trip of allTrips) {
            if (!map[trip.service_id]) map[trip.service_id] = [];
            map[trip.service_id].push(trip);
        }
        this.tripsByServiceIdCache = map;
        return map;
    }

    getTrips(filter?: TripQuery | Partial<Trip>): Trip[] {
        return this.addonInstance.getTrips(filter || {});
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

    getServiceDates(service_id: string): string[] {
        return this.getServiceDatesMap()[service_id] ?? [];
    }

    getServiceDatesByTrip(trip_id: string): string[] {
        const trips = this.getTrips({ trip_id });
        if (trips.length === 0) return [];
        return this.getServiceDates(trips[0].service_id);
    }

    updateRealtime(alerts: Buffer | Buffer[], tripUpdates: Buffer | Buffer[], vehiclePositions: Buffer | Buffer[], feed_id?: string): void {
        this.addonInstance.updateRealtime(alerts, tripUpdates, vehiclePositions, feed_id || "");
    }

    async updateRealtimeFromUrl(
        alertsArg?: (GTFSFeedConfig | string)[] | GTFSFeedConfig | string | null,
        tripUpdatesArg?: (GTFSFeedConfig | string)[] | GTFSFeedConfig | string | null,
        vehiclePositionsArg?: (GTFSFeedConfig | string)[] | GTFSFeedConfig | string | null
    ): Promise<void> {

        const normalize = (arg: (GTFSFeedConfig | string)[] | GTFSFeedConfig | string | null | undefined): GTFSFeedConfig[] => {
             if (!arg) return [];
             if (Array.isArray(arg)) {
                 return arg.map(a => typeof a === 'string' ? { url: a } : a);
             }
             if (typeof arg === 'string') return [{ url: arg }];
             return [arg];
        };

        const alertConfigs = normalize(alertsArg);
        const tuConfigs = normalize(tripUpdatesArg);
        const vpConfigs = normalize(vehiclePositionsArg);

        const [alerts, tripUpdates, vehiclePositions] = await Promise.all([
            Promise.all(alertConfigs.map(c => this.download(c.url, "Downloading Alerts", false, c.headers))),
            Promise.all(tuConfigs.map(c => this.download(c.url, "Downloading TripUpdates", false, c.headers))),
            Promise.all(vpConfigs.map(c => this.download(c.url, "Downloading VehiclePositions", false, c.headers)))
        ]);

        // Note: this doesn't handle multiple feeds with different IDs in a single call easily if we want to associate them.
        // But for common use cases it's fine or user can call multiple times.
        this.addonInstance.updateRealtime(alerts, tripUpdates, vehiclePositions);
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

    clearRealtime(feed_id?: string): void {
        this.addonInstance.clearRealtime(feed_id || "");
    }

    private download(url: string, taskName: string = "Downloading", showProgressBar: boolean = true, headers?: Record<string, string>): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const onResponse = (res: any) => {
                res.on('error', (err: Error) => reject(err));
                if (res.statusCode !== 200) {
                    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                        if (this.logger) this.logger(`Redirected to ${res.headers.location}`);
                        this.download(res.headers.location as string, taskName, showProgressBar, headers).then(resolve).catch(reject);
                        return;
                    }
                    reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
                    return;
                }

                const total = parseInt(res.headers['content-length'] || '0', 10);
                let current = 0;
                const data: Buffer[] = [];
                const startTime = Date.now();

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
                        this.showProgress(taskName, current, total, speed, 0);
                        if (this.ansi && process.stdout.isTTY) process.stdout.write('\n');
                    }
                    resolve(Buffer.concat(data))
                });
            };

            try {
                const client = url.startsWith('https') ? https : http;
                const req = headers ? client.get(url, { headers }, onResponse) : client.get(url, onResponse);
                req.on('error', (err: Error) => reject(err));
            } catch (e) {
                reject(e);
            }
        });
    }
}
