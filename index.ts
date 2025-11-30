import * as https from 'https';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

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

export interface Agency {
  agency_id: string;
  agency_name: string;
  agency_url: string;
  agency_timezone: string;
  agency_lang: string;
  agency_phone: string;
  agency_fare_url: string;
  agency_email: string;
}

export interface Route {
  route_id: string;
  agency_id: string;
  route_short_name: string;
  route_long_name: string;
  route_desc: string;
  route_type: number;
  route_url: string;
  route_color: string;
  route_text_color: string;
}

export interface Stop {
  stop_id: string;
  stop_code: string;
  stop_name: string;
  stop_desc: string;
  stop_lat: number;
  stop_lon: number;
  zone_id: string;
  stop_url: string;
  location_type: number;
  parent_station: string;
  stop_timezone: string;
  wheelchair_boarding: number;
  level_id: string;
  platform_code: string;
}

export interface StopTime {
    trip_id: string;
    stop_id: string;
    arrival_time: number; // Seconds since midnight
    departure_time: number; // Seconds since midnight
    stop_sequence: number;
    stop_headsign: string;
    pickup_type: number;
    drop_off_type: number;
    shape_dist_traveled: number;
    timepoint: number;
}

export interface FeedInfo {
    feed_publisher_name: string;
    feed_publisher_url: string;
    feed_lang: string;
    default_lang: string;
    feed_start_date: string;
    feed_end_date: string;
    feed_version: string;
    feed_contact_email: string;
    feed_contact_url: string;
}

export interface Trip {
    trip_id: string;
    route_id: string;
    service_id: string;
    trip_headsign: string;
    trip_short_name: string;
    direction_id: number;
    block_id: string;
    shape_id: string;
    wheelchair_accessible: number;
    bikes_allowed: number;
}

export interface Shape {
    shape_id: string;
    shape_pt_lat: number;
    shape_pt_lon: number;
    shape_pt_sequence: number;
    shape_dist_traveled: number;
}

export interface Calendar {
    service_id: string;
    monday: boolean;
    tuesday: boolean;
    wednesday: boolean;
    thursday: boolean;
    friday: boolean;
    saturday: boolean;
    sunday: boolean;
    start_date: string;
    end_date: string;
}

export interface CalendarDate {
    service_id: string;
    date: string;
    exception_type: number;
}

export interface StopTimeQuery {
    stop_id?: string;
    trip_id?: string;
    date?: string; // YYYYMMDD
    start_time?: number | string; // Seconds or HH:MM:SS
    end_time?: number | string; // Seconds or HH:MM:SS
}

export interface GTFSOptions {
    logger?: (msg: string) => void;
    ansi?: boolean;
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
            this.logger(`\x1b[32m[GTFS] Downloading ${url}...\x1b[0m`);
        } else {
            this.logger(`[GTFS] Downloading ${url}...`);
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
