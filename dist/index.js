import * as https from 'https';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
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
            // Fallback for development/testing if addon not built
            if (process.env.NODE_ENV === 'test') {
                GTFSAddon = class MockAddon {
                    loadFromBuffer() { }
                    getFeedInfo() { return []; }
                    // Add other methods as no-ops
                    getRoutes() { return []; }
                    getRoute() { return null; }
                    getAgencies() { return []; }
                    getStops() { return []; }
                    getStopTimesForTrip() { return []; }
                    queryStopTimes() { return []; }
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
// Helpers for formatting
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
    constructor(options) {
        this.addonInstance = new GTFSAddon();
        this.logger = options?.logger;
        this.progressCallback = options?.progress;
        this.ansi = options?.ansi || false;
        this.cacheDir = options?.cacheDir;
        this.cache = options?.cache || false;
    }
    showProgress(task, current, total, speed, eta) {
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
    async loadFromUrl(url) {
        if (this.logger) {
            if (this.ansi) {
                this.logger(`\x1b[32mDownloading ${url}...\x1b[0m`);
            }
            else {
                this.logger(`Downloading ${url}...`);
            }
        }
        const buffer = await this.download(url, "Downloading");
        return this.loadFromBuffer(buffer);
    }
    async loadFromPath(path) {
        const buffer = fs.readFileSync(path);
        return this.loadFromBuffer(buffer);
    }
    loadFromBuffer(buffer) {
        const startTime = Date.now();
        // We pass a callback that bridges C++ updates to our showProgress
        const progressBridge = (task, current, total) => {
            const now = Date.now();
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? current / elapsed : 0;
            const remaining = total - current;
            const eta = speed > 0 ? remaining / speed : 0;
            this.showProgress(task, current, total, speed, eta);
        };
        return this.addonInstance.loadFromBuffer(buffer, this.logger, this.ansi, progressBridge);
    }
    getRoutes() {
        return this.addonInstance.getRoutes();
    }
    getRoute(routeId) {
        return this.addonInstance.getRoute(routeId);
    }
    getAgencies() {
        return this.addonInstance.getAgencies();
    }
    getStops() {
        return this.addonInstance.getStops();
    }
    getStopTimesForTrip(tripId) {
        return this.addonInstance.getStopTimesForTrip(tripId);
    }
    queryStopTimes(query) {
        return this.addonInstance.queryStopTimes(query);
    }
    getFeedInfo() {
        return this.addonInstance.getFeedInfo();
    }
    getTrips() {
        return this.addonInstance.getTrips();
    }
    getShapes() {
        return this.addonInstance.getShapes();
    }
    getCalendars() {
        return this.addonInstance.getCalendars();
    }
    getCalendarDates() {
        return this.addonInstance.getCalendarDates();
    }
    updateRealtime(alerts, tripUpdates, vehiclePositions) {
        this.addonInstance.updateRealtime(alerts, tripUpdates, vehiclePositions);
    }
    async updateRealtimeFromUrl(alertsUrl, tripUpdatesUrl, vehiclePositionsUrl) {
        const alerts = alertsUrl ? await this.download(alertsUrl, "Downloading Alerts") : Buffer.alloc(0);
        const tripUpdates = tripUpdatesUrl ? await this.download(tripUpdatesUrl, "Downloading TripUpdates") : Buffer.alloc(0);
        const vehiclePositions = vehiclePositionsUrl ? await this.download(vehiclePositionsUrl, "Downloading VehiclePositions") : Buffer.alloc(0);
        this.updateRealtime(alerts, tripUpdates, vehiclePositions);
    }
    getRealtimeTripUpdates() {
        return this.addonInstance.getRealtimeTripUpdates();
    }
    getRealtimeVehiclePositions() {
        return this.addonInstance.getRealtimeVehiclePositions();
    }
    getRealtimeAlerts() {
        return this.addonInstance.getRealtimeAlerts();
    }
    download(url, taskName = "Downloading") {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                if (res.statusCode !== 200) {
                    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                        this.download(res.headers.location, taskName).then(resolve).catch(reject);
                        return;
                    }
                    reject(new Error(`Failed to download: ${res.statusCode}`));
                    return;
                }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let current = 0;
                const data = [];
                const startTime = Date.now();
                res.on('data', (chunk) => {
                    data.push(chunk);
                    current += chunk.length;
                    const now = Date.now();
                    const elapsed = (now - startTime) / 1000;
                    const speed = elapsed > 0 ? current / elapsed : 0;
                    const remaining = total - current;
                    const eta = speed > 0 ? remaining / speed : 0;
                    this.showProgress(taskName, current, total, speed, eta);
                });
                res.on('end', () => {
                    // Ensure 100%
                    const now = Date.now();
                    const elapsed = (now - startTime) / 1000;
                    const speed = elapsed > 0 ? current / elapsed : 0;
                    this.showProgress(taskName, current, total, speed, 0);
                    if (this.ansi)
                        process.stdout.write('\n'); // Clear line
                    resolve(Buffer.concat(data));
                });
                res.on('error', (err) => reject(err));
            }).on('error', (err) => reject(err));
        });
    }
}
