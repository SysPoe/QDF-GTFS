import * as https from 'https';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    Agency, Route, Stop, StopTime, FeedInfo, Trip, Shape, Calendar, CalendarDate,
    RealtimeTripUpdate, RealtimeVehiclePosition, RealtimeAlert, StopTimeQuery, GTFSOptions
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
         const binding = r(path.join(__dirname, '../build/Release/gtfs_addon.node'));
         GTFSAddon = binding.GTFSAddon;
    }
} catch (e) {
    console.error("Could not load native addon");
    throw e;
}

export class GTFS {
  private addonInstance: any;
  private logger?: (msg: string) => void;
  private ansi: boolean;

  constructor(options?: GTFSOptions) {
      this.addonInstance = new GTFSAddon();
      this.logger = options?.logger;
      this.ansi = options?.ansi || false;
  }

  async loadFromUrl(url: string): Promise<void> {
    if (this.logger) {
        if (this.ansi) {
            this.logger(`\x1b[32mDownloading ${url}...\x1b[0m`);
        } else {
            this.logger(`Downloading ${url}...`);
        }
    }
    const buffer = await this.download(url);
    return this.loadFromBuffer(buffer);
  }

  async loadFromPath(path: string): Promise<void> {
      const buffer = fs.readFileSync(path);
      return this.loadFromBuffer(buffer);
  }

  loadFromBuffer(buffer: Buffer): Promise<void> {
    return this.addonInstance.loadFromBuffer(buffer, this.logger, this.ansi);
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
      const pAlerts = alertsUrl ? this.download(alertsUrl) : Promise.resolve(Buffer.alloc(0));
      const pTripUpdates = tripUpdatesUrl ? this.download(tripUpdatesUrl) : Promise.resolve(Buffer.alloc(0));
      const pVehiclePositions = vehiclePositionsUrl ? this.download(vehiclePositionsUrl) : Promise.resolve(Buffer.alloc(0));

      const [alerts, tripUpdates, vehiclePositions] = await Promise.all([pAlerts, pTripUpdates, pVehiclePositions]);

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

  private download(url: string): Promise<Buffer> {
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

        const data: Buffer[] = [];
        res.on('data', (chunk) => data.push(chunk));
        res.on('end', () => resolve(Buffer.concat(data)));
        res.on('error', (err) => reject(err));
      }).on('error', (err) => reject(err));
    });
  }
}
