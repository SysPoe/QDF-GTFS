# QDF-GTFS

A high-performance GTFS (General Transit Feed Specification) and GTFS-Realtime parser for Node.js, built with C++ for speed and efficiency.

## Features

- **Fast Parsing**: Native C++ implementation for parsing large static GTFS ZIP feeds.
- **Realtime Support**: Full support for GTFS Realtime Protocol Buffers (Alerts, Trip Updates, Vehicle Positions).
- **TypeScript Ready**: Includes comprehensive type definitions and Enums.
- **Memory Efficient**: Native backend handling of data structures.
- **Flexible Loading**: Load feeds from URLs or local file paths with progress tracking.

## Installation

```bash
nub add github:SysPoe/QDF-GTFS
```

**Note**: This is a native addon. You will need a build environment compatible with `node-gyp`.

### Build Requirements

To successfully install and build this package, your system needs:

*   **Node.js**: A supported version (v16+ recommended).
*   **Python 3**: Required by `node-gyp` for build configuration.
*   **C++ Compiler**: A compiler supporting C++17 or later.
    *   **Linux**: `gcc`/`g++` (v7+) or `clang`.
    *   **macOS**: Xcode Command Line Tools (`clang`).
    *   **Windows**: Visual Studio Build Tools (MSVC).
*   **Build Tools**: `make` (Linux/macOS) or appropriate build chain on Windows.

If you encounter errors during `nub install`, ensure you have the necessary build tools installed. On many systems, you can install them via:
*   **Ubuntu/Debian**: `sudo apt-get install build-essential python3`
*   **Windows**: Install Visual Studio Build Tools manually.
*   **macOS**: `xcode-select --install`

## Usage

### Basic Setup

```typescript
import { GTFS } from 'qdf-gtfs';

const gtfs = new GTFS({
  ansi: true, // Enable ANSI progress bars
  logger: console.log
});
```

### Loading Static GTFS

You can load a GTFS feed from a URL or a local file path.

```typescript
// Feed IDs are required and remain attached to every parsed entity.
await gtfs.loadStatic({ id: "my-agency", url: "https://example.com/gtfs.zip" });

// Multiple feeds remain distinct even when they reuse local IDs.
await gtfs.loadStatic([
  { id: "agency-a", url: "https://example.com/a.zip" },
  { id: "agency-b", url: "https://example.com/b.zip", headers: { Authorization: "Bearer ..." } }
]);

// OR Load from local path
// await gtfs.loadFromPath(["./path/to/gtfs.zip"], ["my-agency"]);

// Access data
const routes = gtfs.getRoutes();
const stops = gtfs.getStops();

console.log(`Loaded ${routes.length} routes and ${stops.length} stops.`);
```

### Handling GTFS Realtime

Fetch and parse realtime updates (Protocol Buffers).

```typescript
await gtfs.updateRealtimeFromUrl([
  { id: "agency-a-alerts", targetFeedId: "agency-a", kind: "alerts", url: "https://example.com/alerts.pb" },
  { id: "agency-a-trips", targetFeedId: "agency-a", kind: "trip-updates", url: "https://example.com/trip_updates.pb" },
  { id: "agency-a-vehicles", targetFeedId: "agency-a", kind: "vehicles", url: "https://example.com/vehicle_positions.pb" }
]);

// Access parsed realtime data
const tripUpdates = gtfs.getRealtimeTripUpdates();
const vehicles = gtfs.getRealtimeVehiclePositions();
const alerts = gtfs.getRealtimeAlerts();
```

## API Overview

### Configuration (`GTFSOptions`)

- `ansi`: Boolean. Enable/disable ANSI progress bars (default: `false`).
- `logger`: Function. Custom logger function (e.g., `console.log`).
- `progress`: Function. Callback for detailed progress info.
- `cache`: Boolean. Enable caching (default: `false`).
- `cacheDir`: String. Directory for cache.
- `cacheMaxAgeMs`: Maximum age for a fresh static-feed cache (default: 24 hours).
- `staleIfError`: Use an expired static cache when its origin is unavailable (default: `true`).
- `requestTimeoutMs`: Network request timeout (default: 30 seconds).

### Main Methods

- `loadStatic(feeds)`: Download, cache, and load one or more feed-qualified GTFS ZIPs.
- `loadFromPath(paths, feedIds)`: Load one or more GTFS ZIPs from the local filesystem. Supply one unique, non-empty feed ID per ZIP.
- `updateRealtimeFromUrl(sources)`: Download and independently update feed-qualified realtime sources.
- `updateRealtime(input)`: Parse a raw realtime Buffer with explicit `sourceId`, `targetFeedId`, and `kind`.

### Data Getters

- `getRoutes()`, `getRoute(id)`
- `getStops()`
- `getTrips()`
- `getStopTimesForTrip(tripId)`
- `queryStopTimes(query)`
- `getAgencies()`
- `getCalendars()`, `getCalendarDates()`
- `getShapes()`
- `getFeedInfo()`
