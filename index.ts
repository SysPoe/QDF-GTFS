import * as https from 'https';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import {
    Agency, Route, Stop, StopTime, FeedInfo, Trip, Shape, Calendar, CalendarDate,
    RealtimeTripUpdate, RealtimeVehiclePosition, RealtimeAlert, StopTimeQuery, GTFSOptions, ProgressInfo,
    GTFSMergeStrategy, GTFSFeedConfig
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

        return this.loadFromBuffers(buffers);
    }

    async loadFromPath(paths: string[]): Promise<void> {
        const buffers = paths.map(p => fs.readFileSync(p));
        return this.loadFromBuffers(buffers);
    }

    loadFromBuffers(buffers: Buffer[]): Promise<void> {
        const startTime = Date.now();
        const progressBridge = (task: string, current: number, total: number) => {
            const now = Date.now();
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? current / elapsed : 0;
            const remaining = total - current;
            const eta = speed > 0 ? remaining / speed : 0;
            this.showProgress(task, current, total, speed, eta);
        };

        return this.addonInstance.loadFromBuffers(buffers, this.mergeStrategy, this.logger, this.ansi, progressBridge);
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

    getTrips(filter?: Partial<Trip>): Trip[] {
        return this.addonInstance.getTrips(filter);
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

    updateRealtime(alerts: Buffer | Buffer[], tripUpdates: Buffer | Buffer[], vehiclePositions: Buffer | Buffer[]): void {
        this.addonInstance.updateRealtime(alerts, tripUpdates, vehiclePositions);
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

        this.addonInstance.updateRealtime(alerts, tripUpdates, vehiclePositions);
    }

    getRealtimeTripUpdates(): RealtimeTripUpdate[] {
        return this.addonInstance.getRealtimeTripUpdates();
    }

    getRealtimeVehiclePositions(): RealtimeVehiclePosition[] {
        return this.addonInstance.getRealtimeVehiclePositions();
    }

    getRealtimeAlerts(): RealtimeAlert[] {
        return this.addonInstance.getRealtimeAlerts();
    }

    private download(url: string, taskName: string = "Downloading", showProgressBar: boolean = true, headers?: Record<string, string>): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const onResponse = (res: any) => {
                if (res.statusCode !== 200) {
                    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                        if (this.logger) this.logger(`Redirected to ${res.headers.location}`);
                        this.download(res.headers.location as string, taskName, showProgressBar, headers).then(resolve).catch(reject);
                        return;
                    }
                    reject(new Error(`Failed to download: ${res.statusCode}`));
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
                        if (this.ansi) process.stdout.write('\n');
                    }
                    resolve(Buffer.concat(data))
                });
                res.on('error', (err: Error) => reject(err));
            };

            const req = headers ? https.get(url, { headers }, onResponse) : https.get(url, onResponse);
            req.on('error', (err: Error) => reject(err));
        });
    }
}
