import * as https from 'https';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    Agency, Route, Stop, StopTime, FeedInfo, Trip, Shape, Calendar, CalendarDate,
    RealtimeTripUpdate, RealtimeVehiclePosition, RealtimeAlert, StopTimeQuery, GTFSOptions, ProgressInfo
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
    } catch(e) {
        try {
            const binding = r(path.join(__dirname, '../build/Release/gtfs_addon.node'));
            GTFSAddon = binding.GTFSAddon;
        } catch(e2) {
             // Fallback for development/testing if addon not built
             if (process.env.NODE_ENV === 'test') {
                 GTFSAddon = class MockAddon {
                     loadFromBuffer() {}
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
                     updateRealtime() {}
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

// Helpers for formatting
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

  constructor(options?: GTFSOptions) {
      this.addonInstance = new GTFSAddon();
      this.logger = options?.logger;
      this.progressCallback = options?.progress;
      this.ansi = options?.ansi || false;
      this.cacheDir = options?.cacheDir;
      this.cache = options?.cache || false;
  }

  private showProgress(task: string, current: number, total: number, speed: number, eta: number) {
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

  async loadFromUrl(url: string): Promise<void> {
    if (this.logger) {
        if (this.ansi) {
            this.logger(`\x1b[32mDownloading ${url}...\x1b[0m`);
        } else {
            this.logger(`Downloading ${url}...`);
        }
    }
    const buffer = await this.download(url, "Downloading");
    return this.loadFromBuffer(buffer);
  }

  async loadFromPath(path: string): Promise<void> {
      const buffer = fs.readFileSync(path);
      return this.loadFromBuffer(buffer);
  }

  loadFromBuffer(buffer: Buffer): Promise<void> {
    const startTime = Date.now();
    // We pass a callback that bridges C++ updates to our showProgress
    const progressBridge = (task: string, current: number, total: number) => {
        const now = Date.now();
        const elapsed = (now - startTime) / 1000;
        const speed = elapsed > 0 ? current / elapsed : 0;
        const remaining = total - current;
        const eta = speed > 0 ? remaining / speed : 0;
        this.showProgress(task, current, total, speed, eta);
    };

    return this.addonInstance.loadFromBuffer(buffer, this.logger, this.ansi, progressBridge);
  }

  getRoutes(): Route[] {
    return this.addonInstance.getRoutes();
  }
  
  getRoute(routeId: string): Route | null {
      return this.addonInstance.getRoute(routeId);
  }

  getAgencies(): Agency[] {
    return this.addonInstance.getAgencies();
  }

  getStops(): Stop[] {
    return this.addonInstance.getStops();
  }

  getStopTimesForTrip(tripId: string): StopTime[] {
      return this.addonInstance.getStopTimesForTrip(tripId);
  }
  
  queryStopTimes(query: StopTimeQuery): StopTime[] {
      return this.addonInstance.queryStopTimes(query);
  }
  
  getFeedInfo(): FeedInfo[] {
      return this.addonInstance.getFeedInfo();
  }
  
  getTrips(): Trip[] {
      return this.addonInstance.getTrips();
  }
  
  getShapes(): Shape[] {
      return this.addonInstance.getShapes();
  }
  
  getCalendars(): Calendar[] {
      return this.addonInstance.getCalendars();
  }
  
  getCalendarDates(): CalendarDate[] {
      return this.addonInstance.getCalendarDates();
  }

  updateRealtime(alerts: Buffer, tripUpdates: Buffer, vehiclePositions: Buffer): void {
      this.addonInstance.updateRealtime(alerts, tripUpdates, vehiclePositions);
  }

  async updateRealtimeFromUrl(alertsUrl?: string, tripUpdatesUrl?: string, vehiclePositionsUrl?: string): Promise<void> {
      const alerts = alertsUrl ? await this.download(alertsUrl, "Downloading Alerts") : Buffer.alloc(0);
      const tripUpdates = tripUpdatesUrl ? await this.download(tripUpdatesUrl, "Downloading TripUpdates") : Buffer.alloc(0);
      const vehiclePositions = vehiclePositionsUrl ? await this.download(vehiclePositionsUrl, "Downloading VehiclePositions") : Buffer.alloc(0);

      this.updateRealtime(alerts, tripUpdates, vehiclePositions);
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

  private download(url: string, taskName: string = "Downloading"): Promise<Buffer> {
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
        const data: Buffer[] = [];
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
             if (this.ansi) process.stdout.write('\n'); // Clear line
             resolve(Buffer.concat(data))
        });
        res.on('error', (err) => reject(err));
      }).on('error', (err) => reject(err));
    });
  }
}
