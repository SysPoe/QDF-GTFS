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
        const binding = r(path.join(__dirname, '../build/Release/gtfs_addon.node'));
        GTFSAddon = binding.GTFSAddon;
    }
}
catch (e) {
    console.error("Could not load native addon");
    throw e;
}
export class GTFS {
    addonInstance;
    logger;
    ansi;
    constructor(options) {
        this.addonInstance = new GTFSAddon();
        this.logger = options?.logger;
        this.ansi = options?.ansi || false;
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
        const buffer = await this.download(url);
        return this.loadFromBuffer(buffer);
    }
    async loadFromPath(path) {
        const buffer = fs.readFileSync(path);
        return this.loadFromBuffer(buffer);
    }
    loadFromBuffer(buffer) {
        return this.addonInstance.loadFromBuffer(buffer, this.logger, this.ansi);
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
        const pAlerts = alertsUrl ? this.download(alertsUrl) : Promise.resolve(Buffer.alloc(0));
        const pTripUpdates = tripUpdatesUrl ? this.download(tripUpdatesUrl) : Promise.resolve(Buffer.alloc(0));
        const pVehiclePositions = vehiclePositionsUrl ? this.download(vehiclePositionsUrl) : Promise.resolve(Buffer.alloc(0));
        const [alerts, tripUpdates, vehiclePositions] = await Promise.all([pAlerts, pTripUpdates, pVehiclePositions]);
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
    download(url) {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                if (res.statusCode !== 200) {
                    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                        this.download(res.headers.location).then(resolve).catch(reject);
                        return;
                    }
                    reject(new Error(`Failed to download: ${res.statusCode}`));
                    return;
                }
                const data = [];
                res.on('data', (chunk) => data.push(chunk));
                res.on('end', () => resolve(Buffer.concat(data)));
                res.on('error', (err) => reject(err));
            }).on('error', (err) => reject(err));
        });
    }
}
