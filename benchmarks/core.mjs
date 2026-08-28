import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { GTFS } from "../dist/index.js";

const TRIP_COUNT = Number.parseInt(process.env.QDF_BENCHMARK_TRIP_COUNT ?? "1200", 10);
const STOPS_PER_TRIP = 20;
const STOP_COUNT = 120;
const FEED_ID = "benchmark-feed";
const STATIC_URL = "https://benchmark.invalid/qdf-static.zip";
const SERVICE_DATE = "20260828";

function forceGc() {
	if (typeof globalThis.gc !== "function") return;
	globalThis.gc();
	globalThis.gc();
}

function memorySnapshot() {
	const memory = process.memoryUsage();
	return {
		heapUsedBytes: memory.heapUsed,
		rssBytes: memory.rss,
		externalBytes: memory.external,
		arrayBuffersBytes: memory.arrayBuffers,
	};
}

async function measure(operation) {
	forceGc();
	const before = memorySnapshot();
	let peak = { ...before };
	const sample = () => {
		const current = memorySnapshot();
		peak.heapUsedBytes = Math.max(peak.heapUsedBytes, current.heapUsedBytes);
		peak.rssBytes = Math.max(peak.rssBytes, current.rssBytes);
		peak.externalBytes = Math.max(peak.externalBytes, current.externalBytes);
		peak.arrayBuffersBytes = Math.max(peak.arrayBuffersBytes, current.arrayBuffersBytes);
	};
	const sampler = setInterval(sample, 10);
	sampler.unref?.();
	const started = performance.now();
	let value;
	try {
		value = await operation();
	} finally {
		clearInterval(sampler);
	}
	const elapsedMs = performance.now() - started;
	const after = memorySnapshot();
	sample();
	return {
		value,
		metrics: {
			elapsedMs: Number(elapsedMs.toFixed(3)),
			heapUsedBeforeBytes: before.heapUsedBytes,
			heapUsedAfterBytes: after.heapUsedBytes,
			heapUsedPeakBytes: peak.heapUsedBytes,
			rssBeforeBytes: before.rssBytes,
			rssAfterBytes: after.rssBytes,
			rssPeakBytes: peak.rssBytes,
			externalBeforeBytes: before.externalBytes,
			externalAfterBytes: after.externalBytes,
			externalPeakBytes: peak.externalBytes,
			arrayBuffersBeforeBytes: before.arrayBuffersBytes,
			arrayBuffersAfterBytes: after.arrayBuffersBytes,
			arrayBuffersPeakBytes: peak.arrayBuffersBytes,
		},
	};
}

function emitBenchmark(row) {
	console.log(`BENCHMARK ${JSON.stringify({ schemaVersion: 1, ...row })}`);
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/** Build a deterministic stored ZIP so the benchmark has no package or network dependency. */
function createZip(files) {
	const localParts = [];
	const centralParts = [];
	let localOffset = 0;
	for (const [filename, contents] of Object.entries(files)) {
		const name = Buffer.from(filename);
		const body = Buffer.from(contents);
		const checksum = crc32(body);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(name.length, 26);
		localParts.push(local, name, body);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(body.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(localOffset, 42);
		centralParts.push(central, name);
		localOffset += local.length + name.length + body.length;
	}
	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(localOffset, 16);
	return Buffer.concat([...localParts, centralDirectory, end]);
}

function fixtureZip() {
	const agency = "agency_id,agency_name,agency_url,agency_timezone\nbench,Benchmark Rail,https://benchmark.invalid,Australia/Brisbane\n";
	const routes = "route_id,agency_id,route_short_name,route_long_name,route_type\nroute-0,bench,Benchmark,Benchmark Rail,2\n";
	const stops = [
		"stop_id,stop_name,stop_lat,stop_lon,location_type\n",
		...Array.from(
			{ length: STOP_COUNT },
			(_, index) => `stop-${String(index).padStart(3, "0")},Benchmark Stop ${index},-27.4,${153 + index / 1000},0\n`,
		),
	].join("");
	const trips = [
		"route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,shape_id\n",
		...Array.from(
			{ length: TRIP_COUNT },
			(_, index) =>
				`route-0,service-0,trip-${String(index).padStart(5, "0")},Benchmark Terminal,${index % 100},${index % 2},shape-0\n`,
		),
	].join("");
	const stopTimes = [
		"trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,timepoint,shape_dist_traveled\n",
		...Array.from({ length: TRIP_COUNT }, (_, tripIndex) =>
			Array.from({ length: STOPS_PER_TRIP }, (_, stopIndex) => {
				const seconds = 5 * 3600 + (tripIndex % 360) * 60 + stopIndex * 240;
				return `trip-${String(tripIndex).padStart(5, "0")},${seconds},${seconds + 30},stop-${String(
					tripIndex % STOP_COUNT,
				).padStart(3, "0")},${stopIndex + 1},,0,0,1,${stopIndex * 1000}\n`;
			}),
		),
	].flat().join("");
	const calendar =
		"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
		"service-0,1,1,1,1,1,1,1,20260101,20301231\n";
	const calendarDates = "service_id,date,exception_type\nservice-0,20260101,2\n";
	const shapes = [
		"shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n",
		...Array.from(
			{ length: STOPS_PER_TRIP },
			(_, index) => `shape-0,-27.4,${153 + index / 1000},${index + 1},${index * 1000}\n`,
		),
	].join("");
	const occupancies =
		"trip_id,stop_sequence,occupancy_status,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date,exception\n" +
		"trip-00000,1,1,1,1,1,1,1,1,1,20260101,20301231,0\n";
	return createZip({
		"agency.txt": agency,
		"routes.txt": routes,
		"stops.txt": stops,
		"trips.txt": trips,
		"stop_times.txt": stopTimes,
		"calendar.txt": calendar,
		"calendar_dates.txt": calendarDates,
		"transfers.txt": "from_stop_id,to_stop_id,transfer_type\n",
		"shapes.txt": shapes,
		"feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang\nBenchmark,https://benchmark.invalid,en\n",
		"occupancies.txt": occupancies,
	});
}

function varint(value) {
	let remaining = BigInt(value);
	const bytes = [];
	while (remaining > 0x7fn) {
		bytes.push(Number((remaining & 0x7fn) | 0x80n));
		remaining >>= 7n;
	}
	bytes.push(Number(remaining));
	return Buffer.from(bytes);
}

function fieldVarint(tag, value) {
	return Buffer.concat([varint((BigInt(tag) << 3n) | 0n), varint(value)]);
}

function fieldString(tag, value) {
	const body = Buffer.from(value);
	return Buffer.concat([varint((BigInt(tag) << 3n) | 2n), varint(body.length), body]);
}

function fieldMessage(tag, value) {
	return Buffer.concat([varint((BigInt(tag) << 3n) | 2n), varint(value.length), value]);
}

function fieldFloat(tag, value) {
	const body = Buffer.alloc(4);
	body.writeFloatLE(value, 0);
	return Buffer.concat([varint((BigInt(tag) << 3n) | 5n), body]);
}

function vehicleDescriptor(vehicleId) {
	return fieldString(1, vehicleId);
}

function feedMessage(entities) {
	const header = fieldString(1, "2.0");
	return Buffer.concat([fieldMessage(1, header), ...entities.map((entity) => fieldMessage(2, entity))]);
}

function tripDescriptor(tripId) {
	return Buffer.concat([
		fieldString(1, tripId),
		fieldString(2, "05:00:00"),
		fieldString(3, SERVICE_DATE),
		fieldString(5, "route-0"),
		fieldVarint(6, 0),
	]);
}

function tripUpdateEntity(index) {
	const tripId = `trip-${String(index).padStart(5, "0")}`;
	const stopUpdate = Buffer.concat([
		fieldVarint(1, 1),
		fieldMessage(2, fieldVarint(1, 30)),
		fieldMessage(3, fieldVarint(1, 30)),
		fieldString(4, "stop-000"),
	]);
	const update = Buffer.concat([
		fieldMessage(1, tripDescriptor(tripId)),
		fieldMessage(2, stopUpdate),
		fieldMessage(3, vehicleDescriptor(`vehicle-${index}`)),
		fieldVarint(4, 1_780_000_000 + index),
		fieldVarint(5, 30),
	]);
	return Buffer.concat([fieldString(1, `trip-update-${index}`), fieldMessage(3, update)]);
}

function vehicleEntity(index) {
	const tripId = `trip-${String(index).padStart(5, "0")}`;
	const carriage = (sequence) => fieldMessage(11, Buffer.concat([
		fieldString(1, `vehicle-${index}-carriage-${sequence}`),
		fieldString(2, String.fromCharCode(64 + sequence)),
		fieldVarint(3, sequence),
		fieldVarint(4, sequence * 20),
		fieldVarint(5, sequence),
	]));
	const vehicle = Buffer.concat([
		fieldMessage(1, tripDescriptor(tripId)),
		fieldMessage(2, Buffer.concat([fieldFloat(1, -27.4), fieldFloat(2, 153.1), fieldFloat(3, 90), fieldFloat(5, 12)])),
		fieldVarint(3, 2),
		fieldVarint(4, 2),
		fieldVarint(5, 1_780_000_000 + index),
		fieldString(7, "stop-000"),
		fieldMessage(8, vehicleDescriptor(`vehicle-${index}`)),
		fieldVarint(9, 1),
		fieldVarint(10, 40),
		carriage(1),
		carriage(2),
	]);
	return Buffer.concat([fieldString(1, `vehicle-update-${index}`), fieldMessage(4, vehicle)]);
}

function makeTripUpdateFeed(count) {
	return feedMessage(Array.from({ length: count }, (_, index) => tripUpdateEntity(index)));
}

function makeVehicleFeed(count) {
	return feedMessage(Array.from({ length: count }, (_, index) => vehicleEntity(index)));
}

function parseNativeTimings(logs) {
	const parsedFiles = [];
	for (const entry of logs) {
		const match = entry.message.match(/^Parsed (.+) in ([\d.]+)ms \((\d+) records\)$/);
		if (match) parsedFiles.push({ file: match[1], elapsedMs: Number(match[2]), records: Number(match[3]) });
	}
	const start = logs.find((entry) => entry.message === "All feeds loaded. Finalizing data...");
	const end = logs.find((entry) => entry.message === "GTFS Data Loading Complete.");
	return {
		parsedFiles,
		nativeParserReportedMs: Number(parsedFiles.reduce((total, entry) => total + entry.elapsedMs, 0).toFixed(3)),
		nativeFinalizationObservedMs:
			start && end ? Number((end.at - start.at).toFixed(3)) : null,
	};
}

async function main() {
	if (!Number.isInteger(TRIP_COUNT) || TRIP_COUNT < 1) throw new Error("QDF_BENCHMARK_TRIP_COUNT must be a positive integer");
	const archive = fixtureZip();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdf-gtfs-benchmark-"));
	const cacheDir = path.join(tempDir, "cache");
	fs.mkdirSync(cacheDir);
	const cacheKey = crypto.createHash("md5").update(`${STATIC_URL}|{}`).digest("hex");
	fs.writeFileSync(path.join(cacheDir, cacheKey), archive);

	try {
		const cached = new GTFS({
			cache: true,
			cacheDir,
			cacheMaxAgeMs: Number.MAX_SAFE_INTEGER,
			logger: () => {},
			progress: () => {},
		});
		const cachedLoad = await measure(() => cached.loadStatic({ id: FEED_ID, url: STATIC_URL }));
		emitBenchmark({
			repository: "QDF-GTFS",
			category: "deterministic-local",
			benchmark: "cached-static-archive-load",
			...cachedLoad.metrics,
			details: {
				source: cachedLoad.value[0]?.source,
				archiveBytes: archive.length,
				tripCount: cached.getTrips().length,
				stopTimeCount: cached.getStopTimes().length,
			},
		});

		const logs = [];
		const parsed = new GTFS({ logger: (message) => logs.push({ at: performance.now(), message }), progress: () => {} });
		const parseResult = await measure(() => parsed.loadFromBuffers([archive], [FEED_ID]));
		emitBenchmark({
			repository: "QDF-GTFS",
			category: "deterministic-local",
			benchmark: "native-static-parse-and-finalization",
			...parseResult.metrics,
			details: {
				archiveBytes: archive.length,
				...parseNativeTimings(logs),
			},
		});

		for (const [benchmark, query] of [
			["get-stop-times-by-trip", { trip_id: "trip-00000" }],
			["get-stop-times-by-stop", { stop_id: "stop-000" }],
			["get-trips-by-trip", { trip_id: "trip-00000" }],
		]) {
			const result = await measure(() => parsed[benchmark === "get-trips-by-trip" ? "getTrips" : "getStopTimes"](query));
			emitBenchmark({
				repository: "QDF-GTFS",
				category: "deterministic-local",
				benchmark,
				...result.metrics,
				details: { query, resultCount: result.value.length },
			});
		}

		const tripUpdateFeed = makeTripUpdateFeed(Math.min(400, TRIP_COUNT));
		const tripParse = await measure(() =>
			parsed.updateRealtime({
				kind: "trip-updates",
				data: tripUpdateFeed,
				targetFeedId: FEED_ID,
				sourceId: "benchmark-trip-updates",
			}),
		);
		emitBenchmark({
			repository: "QDF-GTFS",
			category: "deterministic-local",
			benchmark: "realtime-parse-trip-updates",
			...tripParse.metrics,
			details: {
				feedBytes: tripUpdateFeed.length,
				entityCount: Math.min(400, TRIP_COUNT),
			},
		});
		const tripRead = await measure(() => parsed.getRealtimeTripUpdates({ trip_id: "trip-00000" }));
		emitBenchmark({
			repository: "QDF-GTFS",
			category: "deterministic-local",
			benchmark: "realtime-retrieval-trip-updates-by-trip",
			...tripRead.metrics,
			details: { resultCount: tripRead.value.length },
		});
		const tripAll = await measure(() => parsed.getRealtimeTripUpdates());
		emitBenchmark({
			repository: "QDF-GTFS",
			category: "deterministic-local",
			benchmark: "realtime-retrieval-trip-updates-all",
			...tripAll.metrics,
			details: { resultCount: tripAll.value.length },
		});

		const vehicleFeed = makeVehicleFeed(Math.min(300, TRIP_COUNT));
		const vehicleParse = await measure(() =>
			parsed.updateRealtime({
				kind: "vehicles",
				data: vehicleFeed,
				targetFeedId: FEED_ID,
				sourceId: "benchmark-vehicles",
			}),
		);
		emitBenchmark({
			repository: "QDF-GTFS",
			category: "deterministic-local",
			benchmark: "realtime-parse-vehicle-positions",
			...vehicleParse.metrics,
			details: {
				feedBytes: vehicleFeed.length,
				entityCount: Math.min(300, TRIP_COUNT),
			},
		});
		const vehicleRead = await measure(() => parsed.getRealtimeVehiclePositions({ trip_id: "trip-00000" }));
		emitBenchmark({
			repository: "QDF-GTFS",
			category: "deterministic-local",
			benchmark: "realtime-retrieval-vehicle-positions-by-trip",
			...vehicleRead.metrics,
			details: {
				resultCount: vehicleRead.value.length,
				multiCarriageCount: vehicleRead.value.reduce((total, vehicle) => total + vehicle.multi_carriage_details.length, 0),
			},
		});
		const vehicleAll = await measure(() => parsed.getRealtimeVehiclePositions());
		emitBenchmark({
			repository: "QDF-GTFS",
			category: "deterministic-local",
			benchmark: "realtime-retrieval-vehicle-positions-all",
			...vehicleAll.metrics,
			details: { resultCount: vehicleAll.value.length },
		});
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : error);
	process.exitCode = 1;
});
