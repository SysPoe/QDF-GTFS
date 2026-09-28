import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { extractZipEntry, GTFS, GTFSMergeStrategy, type Shape } from "./index.js";

const crcTable = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit++) {
		crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return crc >>> 0;
});

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/** Build a dependency-free ZIP using stored entries for native parser tests. */
function createZip(files: Record<string, string>): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
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

const shapesHeader =
	"shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n";

const feedA = createZip({
	"shapes.txt":
		shapesHeader +
		"shared,-27.2,153.2,2,1.5\n" +
		"shared,-27.1,153.1,1,\n" +
		"only-a,-26.0,152.0,1,0\n",
});
const feedB = createZip({
	"shapes.txt":
		shapesHeader +
		"shared,-28.2,154.2,2,2.5\n" +
		"shared,-28.1,154.1,1,\n" +
		"only-b,-29.0,155.0,1,0\n",
});

function project(shapes: Shape[]) {
	return shapes.map(
		({ shape_id, shape_pt_sequence, shape_dist_traveled, feed_id }) => ({
			shape_id,
			shape_pt_sequence,
			shape_dist_traveled,
			feed_id,
		}),
	);
}

async function testShapeFiltersAndMergeStrategies() {
	const overwrite = new GTFS({
		filesToLoad: ["shapes.txt"],
		mergeStrategy: GTFSMergeStrategy.OVERWRITE,
	});
	await overwrite.loadFromBuffers([feedA, feedB], ["feed-a", "feed-b"]);

	const all = overwrite.getShapes();
	assert.equal(all.length, 6);

	const shared = overwrite.getShapes({ shape_id: "shared" });
	assert.deepEqual(project(shared), [
		{
			shape_id: "shared",
			shape_pt_sequence: 1,
			shape_dist_traveled: null,
			feed_id: "feed-a",
		},
		{
			shape_id: "shared",
			shape_pt_sequence: 2,
			shape_dist_traveled: 1.5,
			feed_id: "feed-a",
		},
		{
			shape_id: "shared",
			shape_pt_sequence: 1,
			shape_dist_traveled: null,
			feed_id: "feed-b",
		},
		{
			shape_id: "shared",
			shape_pt_sequence: 2,
			shape_dist_traveled: 2.5,
			feed_id: "feed-b",
		},
	]);
	assert.deepEqual(shared, all.filter((shape) => shape.shape_id === "shared"));
	assert.deepEqual(
		overwrite.getShapes({ feed_id: "feed-a" }),
		all.filter((shape) => shape.feed_id === "feed-a"),
	);
	assert.deepEqual(
		overwrite.getShapes({ shape_id: "shared", feed_id: "feed-b" }),
		shared.filter((shape) => shape.feed_id === "feed-b"),
	);
	assert.deepEqual(
		overwrite.getShapes({ shape_id: "shared", feed_id: "feed-a" }),
		shared.filter((shape) => shape.feed_id === "feed-a"),
	);
	assert.deepEqual(overwrite.getShapes({ shape_id: "missing" }), []);
	assert.deepEqual(overwrite.getShapes({ feed_id: "missing" }), []);

	const ignore = new GTFS({
		filesToLoad: ["shapes.txt"],
		mergeStrategy: GTFSMergeStrategy.IGNORE,
	});
	await ignore.loadFromBuffers([feedA, feedB], ["feed-a", "feed-b"]);
	assert.deepEqual(
		ignore.getShapes({ shape_id: "shared" }).map((shape) => shape.feed_id),
		["feed-a", "feed-a", "feed-b", "feed-b"],
	);

	const throwing = new GTFS({
		filesToLoad: ["shapes.txt"],
		mergeStrategy: GTFSMergeStrategy.THROW,
	});
	await throwing.loadFromBuffers([feedA, feedB], ["feed-a", "feed-b"]);
	assert.equal(throwing.getShapes({ shape_id: "shared" }).length, 4);
}

function makeCollisionFeed(name: string): Buffer {
	return createZip({
		"agency.txt":
			"agency_id,agency_name,agency_url,agency_timezone\n" +
			`shared-agency,${name},https://example.invalid,Australia/Brisbane\n`,
		"routes.txt":
			"route_id,agency_id,route_short_name,route_type\n" +
			"shared-route,shared-agency,R,2\n",
		"trips.txt":
			"route_id,service_id,trip_id,shape_id,block_id\n" +
			"shared-route,shared-service,shared-trip,shared-shape,shared-block\n" +
			"shared-route,shared-service,next-trip,shared-shape,shared-block\n",
		"stops.txt":
			"stop_id,stop_name,stop_lat,stop_lon\n" +
			`shared-stop,${name} Stop,-27.0,153.0\n`,
		"stop_times.txt":
			"trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
			"shared-trip,25:30:00,25:31:00,shared-stop,1\n" +
			"next-trip,26:00:00,26:01:00,shared-stop,1\n",
		"calendar.txt":
			"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
			"shared-service,1,1,1,1,1,1,1,20260801,20260831\n",
		"calendar_dates.txt":
			"service_id,date,exception_type\n" +
			"shared-service,20260805,2\n",
		"occupancies.txt":
			"trip_id,stop_sequence,occupancy_status,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date,exception\n" +
			"shared-trip,1,1,1,0,0,0,0,0,0,20260801,20260831,0\n" +
			"shared-trip,1,4,0,0,0,0,0,1,0,20260801,20260831,0\n",
		"transfers.txt":
			"from_stop_id,to_stop_id,from_route_id,to_route_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\n" +
			"shared-stop,shared-stop,shared-route,shared-route,shared-trip,next-trip,4,\n" +
			"shared-stop,shared-stop,shared-route,shared-route,next-trip,shared-trip,5,\n",
		"frequencies.txt":
			"trip_id,start_time,end_time,headway_secs,exact_times\n" +
			"shared-trip,06:00:00,09:00:00,600,1\n",
		"shapes.txt":
			shapesHeader + "shared-shape,-27.0,153.0,1,0\n",
	});
}

function protobufVarint(value: number): Buffer {
	const bytes: number[] = [];
	do {
		let byte = value & 0x7f;
		value >>>= 7;
		if (value) byte |= 0x80;
		bytes.push(byte);
	} while (value);
	return Buffer.from(bytes);
}

function protobufField(tag: number, body: Buffer | string): Buffer {
	const bytes = typeof body === "string" ? Buffer.from(body) : body;
	return Buffer.concat([protobufVarint((tag << 3) | 2), protobufVarint(bytes.length), bytes]);
}

function protobufVarintField(tag: number, value: number): Buffer {
	return Buffer.concat([protobufVarint(tag << 3), protobufVarint(value)]);
}

function makeTripUpdateFeed(updateId: string, tripId: string, stopTimeUpdateCount = 0): Buffer {
	const header = protobufField(1, "2.0");
	const descriptor = protobufField(1, tripId);
	const stopTimeUpdates = Array.from({ length: stopTimeUpdateCount }, (_, index) => Buffer.concat([
		protobufVarintField(1, index + 1),
		protobufField(4, `stop-${index + 1}`),
	]));
	const tripUpdate = Buffer.concat([
		protobufField(1, descriptor),
		...stopTimeUpdates.map((stopTimeUpdate) => protobufField(2, stopTimeUpdate)),
	]);
	const entity = Buffer.concat([protobufField(1, updateId), protobufField(3, tripUpdate)]);
	return Buffer.concat([protobufField(1, header), protobufField(2, entity)]);
}

function makeVehicleFeedWithCarriages(updateId = "vehicle-1", tripId = "trip-1"): Buffer {
	const carriage = (id: string, label: string, occupancy: number, percentage: number, sequence: number) => Buffer.concat([
		protobufField(1, id), protobufField(2, label),
		protobufVarintField(3, occupancy),
		protobufVarintField(4, percentage),
		protobufVarintField(5, sequence),
	]);
	const vehicle = Buffer.concat([
		protobufField(1, protobufField(1, tripId)),
		protobufField(8, protobufField(1, updateId)),
		protobufField(11, carriage("VL131-A", "A", 1, 35, 1)),
		protobufField(11, carriage("VL131-B", "B", 2, 70, 2)),
	]);
	const entity = Buffer.concat([protobufField(1, updateId), protobufField(4, vehicle)]);
	return Buffer.concat([protobufField(1, protobufField(1, "2.0")), protobufField(2, entity)]);
}

function makeAlertFeed(updateId: string): Buffer {
	const entity = Buffer.concat([protobufField(1, updateId), protobufField(5, Buffer.alloc(0))]);
	return Buffer.concat([protobufField(1, protobufField(1, "2.0")), protobufField(2, entity)]);
}

async function testRealtimeIndexesAndRefreshResult() {
	const gtfs = new GTFS();
	const first = gtfs.updateRealtime({
		kind: "vehicles",
		data: makeVehicleFeedWithCarriages("vehicle-a", "shared-trip"),
		targetFeedId: "feed-a",
		sourceId: "source-a",
	});
	assert.deepEqual(first, {
		changed_trip_ids: [{ trip_id: "shared-trip", feed_id: "feed-a" }],
		trip_update_count: 0,
		stop_time_update_count: 0,
		vehicle_count: 1,
		realtime_revision: 1,
	});
	assert.deepEqual(gtfs.getRealtimeVehiclePositions({ trip_id: "shared-trip" }).map((vehicle) => ({
		update_id: vehicle.update_id,
		trip_id: vehicle.trip.trip_id,
		carriages: vehicle.multi_carriage_details,
	})), [
		{
			update_id: "vehicle-a",
			trip_id: "shared-trip",
			carriages: [
				{ id: "VL131-A", label: "A", occupancy_status: 1, occupancy_percentage: 35, carriage_sequence: 1 },
				{ id: "VL131-B", label: "B", occupancy_status: 2, occupancy_percentage: 70, carriage_sequence: 2 },
			],
		},
	]);

	const second = gtfs.updateRealtime({
		kind: "vehicles",
		data: makeVehicleFeedWithCarriages("vehicle-b", "shared-trip"),
		targetFeedId: "feed-b",
		sourceId: "source-b",
	});
	assert.deepEqual(second.changed_trip_ids, [{ trip_id: "shared-trip", feed_id: "feed-b" }]);
	assert.equal(gtfs.getRealtimeVehiclePositions({ trip_id: "shared-trip" }).length, 2);

	const replacement = gtfs.updateRealtime({
		kind: "vehicles",
		data: makeVehicleFeedWithCarriages("vehicle-a2", "replacement-trip"),
		targetFeedId: "feed-a",
		sourceId: "source-a",
	});
	assert.deepEqual(replacement.changed_trip_ids, [
		{ trip_id: "shared-trip", feed_id: "feed-a" },
		{ trip_id: "replacement-trip", feed_id: "feed-a" },
	]);
	assert.equal(gtfs.getRealtimeVehiclePositions({ trip_id: "shared-trip" }).length, 1);
	assert.equal(gtfs.getRealtimeVehiclePositions({ trip_id: "replacement-trip" }).length, 1);

	gtfs.clearRealtime({ sourceId: "source-b" });
	assert.equal(gtfs.getRealtimeVehiclePositions({ trip_id: "shared-trip" }).length, 0);
	assert.equal(gtfs.getRealtimeVehiclePositions().length, 1);

	gtfs.updateRealtime({
		kind: "vehicles",
		data: makeVehicleFeedWithCarriages("vehicle-shared-a", "feed-a-trip"),
		targetFeedId: "feed-a",
		sourceId: "source-shared",
	});
	gtfs.updateRealtime({
		kind: "vehicles",
		data: makeVehicleFeedWithCarriages("vehicle-shared-b", "feed-b-trip"),
		targetFeedId: "feed-b",
		sourceId: "source-shared",
	});
	assert.equal(gtfs.getRealtimeVehiclePositions({ source_id: "source-shared" }).length, 2);
	const sharedSourceReplacement = gtfs.updateRealtime({
		kind: "vehicles",
		data: makeVehicleFeedWithCarriages("vehicle-shared-a2", "feed-a-replacement"),
		targetFeedId: "feed-a",
		sourceId: "source-shared",
	});
	assert.deepEqual(sharedSourceReplacement.changed_trip_ids, [
		{ trip_id: "feed-a-trip", feed_id: "feed-a" },
		{ trip_id: "feed-a-replacement", feed_id: "feed-a" },
	]);
	assert.deepEqual(
		gtfs.getRealtimeVehiclePositions({ feed_id: "feed-a", source_id: "source-shared" }).map((vehicle) => vehicle.update_id),
		["vehicle-shared-a2"],
	);
	assert.deepEqual(
		gtfs.getRealtimeVehiclePositions({ feed_id: "feed-b", source_id: "source-shared" }).map((vehicle) => vehicle.update_id),
		["vehicle-shared-b"],
	);
	gtfs.clearRealtime({ targetFeedId: "feed-a", sourceId: "source-shared" });
	assert.equal(gtfs.getRealtimeVehiclePositions({ feed_id: "feed-a", source_id: "source-shared" }).length, 0);
	assert.equal(gtfs.getRealtimeVehiclePositions({ feed_id: "feed-b", source_id: "source-shared" }).length, 1);

	gtfs.updateRealtime({
		kind: "alerts",
		data: makeAlertFeed("alert-a"),
		targetFeedId: "feed-a",
		sourceId: "source-alert",
	});
	assert.equal(gtfs.getRealtimeAlerts({ source_id: "source-alert" }).length, 1);
	gtfs.clearRealtime({ sourceId: "source-alert" });
	assert.equal(gtfs.getRealtimeAlerts({ source_id: "source-alert" }).length, 0);
}

async function testQualifiedIdentityAndRealtimeProvenance() {
	const gtfs = new GTFS();
	await gtfs.loadFromBuffers(
		[makeCollisionFeed("Alpha"), makeCollisionFeed("Beta")],
		["feed-a", "feed-b"],
	);

	assert.equal(gtfs.getTrips({ trip_id: "shared-trip" }).length, 2);
	assert.equal(gtfs.getTrips({ route_id: "shared-route" }).length, 4);
	assert.equal(gtfs.getTrips({ service_id: "shared-service", feed_id: "feed-a" }).length, 2);
	assert.equal(gtfs.getTrips({ block_id: "shared-block", feed_id: "feed-b" }).length, 2);
	assert.deepEqual(
		gtfs.getTransfers({ from_trip_id: "shared-trip", feed_id: "feed-b" }),
		[
			{
				from_stop_id: "shared-stop",
				to_stop_id: "shared-stop",
				from_route_id: "shared-route",
				to_route_id: "shared-route",
				from_trip_id: "shared-trip",
				to_trip_id: "next-trip",
				transfer_type: 4,
				min_transfer_time: null,
				feed_id: "feed-b",
			},
		],
	);
	assert.equal(gtfs.getTransfers({ transfer_type: 5 }).length, 2);
	assert.equal(gtfs.getStops({ stop_id: "shared-stop" }).length, 2);
	assert.equal(gtfs.getRoutes({ route_id: "shared-route" }).length, 2);
	assert.equal(gtfs.getStopTimes({ trip_id: "shared-trip" }).length, 2);
	assert.equal(gtfs.getShapes({ shape_id: "shared-shape" }).length, 2);
	assert.equal(gtfs.getCalendars({ service_id: "shared-service" }).length, 2);
	assert.equal(gtfs.getStopTimes({ trip_id: "shared-trip", feed_id: "feed-a" })[0].arrival_time, 91800);
	const packedStopTimes = gtfs.getStopTimesPacked({
		trip_ids: ["shared-trip", "next-trip"],
		feed_id: "feed-a",
	});
	assert.equal(packedStopTimes.tripIds.length, 2);
	assert.deepEqual(
		Array.from(packedStopTimes.tripIds, (id) => packedStopTimes.strings[id]),
		["shared-trip", "next-trip"],
	);
	assert.deepEqual(
		Array.from(packedStopTimes.feedIds, (id) => packedStopTimes.strings[id]),
		["feed-a", "feed-a"],
	);
	assert.deepEqual(Array.from(packedStopTimes.arrivalTimes), [91800, 93600]);
	assert.equal(gtfs.getServiceDatesByTrip({ feedId: "feed-a", localId: "shared-trip" }).includes("20260805"), false);
	assert.equal(gtfs.getServiceDatesByTrip({ feedId: "feed-b", localId: "shared-trip" }).includes("20260806"), true);
	assert.deepEqual(gtfs.getStaticOccupancies({ feed_id: "feed-a", trip_id: "shared-trip", date: "20260803" }), [
		{ trip_id: "shared-trip", stop_sequence: 1, occupancy_status: 1, date: "20260803", feed_id: "feed-a" },
	]);
	assert.deepEqual(gtfs.getStaticOccupancies({ feed_id: "feed-b", trip_id: "shared-trip", date: "20260808" }), [
		{ trip_id: "shared-trip", stop_sequence: 1, occupancy_status: 4, date: "20260808", feed_id: "feed-b" },
	]);
	assert.deepEqual(gtfs.getStaticOccupancies({ feed_id: "feed-a", trip_id: "shared-trip", date: "20260804" }), []);

	const firstRefresh = gtfs.updateRealtime({
		kind: "trip-updates",
		data: makeTripUpdateFeed("a-1", "shared-trip", 2),
		targetFeedId: "feed-a",
		sourceId: "source-a",
	});
	assert.deepEqual(firstRefresh, {
		changed_trip_ids: [{ trip_id: "shared-trip", feed_id: "feed-a" }],
		trip_update_count: 1,
		stop_time_update_count: 2,
		vehicle_count: 0,
		realtime_revision: 1,
	});
	const secondRefresh = gtfs.updateRealtime({
		kind: "trip-updates",
		data: makeTripUpdateFeed("b-1", "shared-trip"),
		targetFeedId: "feed-b",
		sourceId: "source-b",
	});
	assert.deepEqual(secondRefresh.changed_trip_ids, [{ trip_id: "shared-trip", feed_id: "feed-b" }]);
	assert.equal(secondRefresh.trip_update_count, 1);
	assert.equal(secondRefresh.stop_time_update_count, 0);
	assert.equal(secondRefresh.realtime_revision, 2);
	assert.deepEqual(
		gtfs.getRealtimeTripUpdates().map(({ update_id, feed_id, source_id }) => ({ update_id, feed_id, source_id })),
		[
			{ update_id: "a-1", feed_id: "feed-a", source_id: "source-a" },
			{ update_id: "b-1", feed_id: "feed-b", source_id: "source-b" },
		],
	);
	assert.deepEqual(
		gtfs.getRealtimeTripUpdates({ trip_id: "shared-trip", feed_id: "feed-a" }).map((update) => update.update_id),
		["a-1"],
	);

	const replacementRefresh = gtfs.updateRealtime({
		kind: "trip-updates",
		data: makeTripUpdateFeed("a-2", "shared-trip"),
		targetFeedId: "feed-a",
		sourceId: "source-a",
	});
	assert.deepEqual(replacementRefresh.changed_trip_ids, [{ trip_id: "shared-trip", feed_id: "feed-a" }]);
	assert.deepEqual(
		gtfs.getRealtimeTripUpdates().map((update) => update.update_id).sort(),
		["a-2", "b-1"],
	);
	assert.deepEqual(
		gtfs.getRealtimeTripUpdates({ trip_id: "shared-trip", feed_id: "feed-a" }).map((update) => update.update_id),
		["a-2"],
	);
}

async function testTripStopTimeIndexAcrossFeeds() {
	const header = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n";
	const first = createZip({
		"stop_times.txt":
			header +
			"reused-trip,10:00:00,10:00:00,first-a,1\n" +
			"other-trip,11:00:00,11:00:00,first-b,1\n",
	});
	const second = createZip({
		"stop_times.txt": header + "reused-trip,12:00:00,12:00:00,second-a,1\n",
	});
	const gtfs = new GTFS({ filesToLoad: ["stop_times.txt"] });
	await gtfs.loadFromBuffers([first, second], ["feed-a", "feed-b"]);

	assert.deepEqual(
		gtfs.getStopTimes({ trip_id: "reused-trip" }).map(({ feed_id, stop_id }) => ({ feed_id, stop_id })),
		[
			{ feed_id: "feed-a", stop_id: "first-a" },
			{ feed_id: "feed-b", stop_id: "second-a" },
		],
	);
	assert.deepEqual(
		gtfs.getStopTimes({ trip_id: "reused-trip", feed_id: "feed-b" }).map(({ stop_id }) => stop_id),
		["second-a"],
	);
}

async function testQuotedTripAndStopTimeRows() {
	const gtfs = new GTFS({ filesToLoad: ["trips.txt", "stop_times.txt"] });
	await gtfs.loadFromBuffers([createZip({
		"trips.txt":
			"route_id,service_id,trip_id,trip_headsign,direction_id\n" +
			"route,service,\"trip,one\",\"North, via\nCentral\",1\n" +
			"route,service,trip-two,South,0\n",
		"stop_times.txt":
			"trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled\n" +
			"\"trip,one\",10:10:00,10:10:00,stop-b,2,2.5\n" +
			"trip-two,09:00:00,09:00:00,stop-c,1,1e2\n" +
			"\"trip,one\",10:00:00,10:00:00,stop-a,1,1.25\n",
	})], ["quoted-feed"]);

	assert.equal(gtfs.getTrips({ trip_id: "trip,one" })[0].trip_headsign, "North, via\nCentral");
	assert.deepEqual(
		gtfs.getStopTimes({ trip_id: "trip,one" }).map(({ stop_id, stop_sequence, shape_dist_traveled }) =>
			({ stop_id, stop_sequence, shape_dist_traveled })),
		[
			{ stop_id: "stop-a", stop_sequence: 1, shape_dist_traveled: 1.25 },
			{ stop_id: "stop-b", stop_sequence: 2, shape_dist_traveled: 2.5 },
		],
	);
	assert.equal(gtfs.getStopTimes({ trip_id: "trip-two" })[0].shape_dist_traveled, 100);
}

async function testRepeatedStopTimeGroupsAfterGrowth() {
	const header = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n";
	const rows = Array.from({ length: 64 }, (_, index) =>
		`trip-${index},08:00:00,08:00:00,stop-${index},1\n` +
		`trip-${index},08:05:00,08:05:00,stop-${index},2\n`,
	).join("");
	const gtfs = new GTFS({ filesToLoad: ["stop_times.txt"] });
	await gtfs.loadFromBuffers([createZip({
		"stop_times.txt": header + rows + "trip-0,08:10:00,08:10:00,stop-0,3\n",
	})], ["group-feed"]);
	assert.equal(gtfs.getStopTimes().length, 129);
	assert.deepEqual(
		gtfs.getStopTimes({ trip_id: "trip-0" }).map(({ stop_sequence }) => stop_sequence),
		[1, 2, 3],
	);
	assert.equal(gtfs.getStopTimes({ stop_id: "stop-63" }).length, 2);
}

async function testStopTimeOrderingAndIndexes() {
	const header = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n";
	const first = createZip({
		"stop_times.txt":
			header +
			"trip-b,10:00:00,10:00:00,shared-stop,2\n" +
			"trip-a,09:00:00,09:00:00,trip-a-3,3\n" +
			"trip-b,08:00:00,08:00:00,shared-stop,1\n" +
			"trip-a,07:00:00,07:00:00,trip-a-1,1\n" +
			"trip-a,08:00:00,08:00:00,trip-a-2,2\n",
	});
	const second = createZip({
		"stop_times.txt":
			header +
			"trip-b,12:00:00,12:00:00,shared-stop,2\n" +
			"trip-c,13:00:00,13:00:00,trip-c-1,1\n" +
			"trip-b,11:00:00,11:00:00,shared-stop,1\n",
	});
	const gtfs = new GTFS({ filesToLoad: ["stop_times.txt"] });
	await gtfs.loadFromBuffers([first, second], ["feed-a", "feed-b"]);

	assert.deepEqual(
		gtfs.getStopTimes().map(({ feed_id, trip_id, stop_id, stop_sequence }) => ({
			feed_id,
			trip_id,
			stop_id,
			stop_sequence,
		})),
		[
			{ feed_id: "feed-a", trip_id: "trip-b", stop_id: "shared-stop", stop_sequence: 1 },
			{ feed_id: "feed-a", trip_id: "trip-b", stop_id: "shared-stop", stop_sequence: 2 },
			{ feed_id: "feed-a", trip_id: "trip-a", stop_id: "trip-a-1", stop_sequence: 1 },
			{ feed_id: "feed-a", trip_id: "trip-a", stop_id: "trip-a-2", stop_sequence: 2 },
			{ feed_id: "feed-a", trip_id: "trip-a", stop_id: "trip-a-3", stop_sequence: 3 },
			{ feed_id: "feed-b", trip_id: "trip-b", stop_id: "shared-stop", stop_sequence: 1 },
			{ feed_id: "feed-b", trip_id: "trip-b", stop_id: "shared-stop", stop_sequence: 2 },
			{ feed_id: "feed-b", trip_id: "trip-c", stop_id: "trip-c-1", stop_sequence: 1 },
		],
	);
	assert.deepEqual(
		gtfs.getStopTimes({ trip_id: "trip-b" }).map(({ feed_id, stop_sequence }) => ({ feed_id, stop_sequence })),
		[
			{ feed_id: "feed-a", stop_sequence: 1 },
			{ feed_id: "feed-a", stop_sequence: 2 },
			{ feed_id: "feed-b", stop_sequence: 1 },
			{ feed_id: "feed-b", stop_sequence: 2 },
		],
	);
	assert.deepEqual(
		gtfs.getStopTimes({ stop_id: "shared-stop" }).map(({ feed_id, trip_id, stop_sequence }) => ({
			feed_id,
			trip_id,
			stop_sequence,
		})),
		[
			{ feed_id: "feed-a", trip_id: "trip-b", stop_sequence: 1 },
			{ feed_id: "feed-a", trip_id: "trip-b", stop_sequence: 2 },
			{ feed_id: "feed-b", trip_id: "trip-b", stop_sequence: 1 },
			{ feed_id: "feed-b", trip_id: "trip-b", stop_sequence: 2 },
		],
	);
}

async function testTripStopTimeBatchIndex() {
	const gtfs = new GTFS();
	await gtfs.loadFromBuffers(
		[makeCollisionFeed("Alpha"), makeCollisionFeed("Beta")],
		["feed-a", "feed-b"],
	);

	assert.deepEqual(
		gtfs
			.getStopTimes({ trip_ids: ["shared-trip", "next-trip"], feed_id: "feed-b" })
			.map(({ feed_id, trip_id, stop_id }) => ({ feed_id, trip_id, stop_id })),
		[
			{ feed_id: "feed-b", trip_id: "shared-trip", stop_id: "shared-stop" },
			{ feed_id: "feed-b", trip_id: "next-trip", stop_id: "shared-stop" },
		],
	);
	assert.deepEqual(
		gtfs.getStopTimes({ trip_ids: ["shared-trip"], feed_id: "feed-a" }).map(({ feed_id, stop_id }) => ({ feed_id, stop_id })),
		[{ feed_id: "feed-a", stop_id: "shared-stop" }],
	);
}

async function testTripStopTimeBoundsAcrossFeeds() {
	const header = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n";
	const first = createZip({
		"stop_times.txt":
			header +
			"long-trip,06:00:00,06:05:00,origin-a,1\n" +
			"long-trip,102:30:00,102:35:00,destination-a,2\n" +
			"overnight-trip,23:55:00,24:00:00,origin-overnight,1\n" +
			"overnight-trip,25:15:00,25:20:00,destination-overnight,2\n",
	});
	const second = createZip({
		"stop_times.txt":
			header +
			"long-trip,12:00:00,12:05:00,origin-b,1\n" +
			"long-trip,14:00:00,14:05:00,destination-b,2\n",
	});
	const gtfs = new GTFS({ filesToLoad: ["stop_times.txt"] });
	await gtfs.loadFromBuffers([first, second], ["feed-a", "feed-b"]);

	assert.deepEqual(gtfs.getTripStopTimeBounds(), [
		{
			trip_id: "long-trip",
			feed_id: "feed-a",
			start_time: 6 * 3600,
			end_time: 102 * 3600 + 35 * 60,
			first_stop_id: "origin-a",
			last_stop_id: "destination-a",
		},
		{
			trip_id: "overnight-trip",
			feed_id: "feed-a",
			start_time: 23 * 3600 + 55 * 60,
			end_time: 25 * 3600 + 20 * 60,
			first_stop_id: "origin-overnight",
			last_stop_id: "destination-overnight",
		},
		{
			trip_id: "long-trip",
			feed_id: "feed-b",
			start_time: 12 * 3600,
			end_time: 14 * 3600 + 5 * 60,
			first_stop_id: "origin-b",
			last_stop_id: "destination-b",
		},
	]);
}

function testFeedIdentityValidation() {
	const gtfs = new GTFS();
	assert.throws(() => gtfs.loadFromBuffers([], []), /At least one GTFS buffer/);
	assert.throws(() => gtfs.loadFromBuffers([Buffer.alloc(0)], []), /one feed ID per GTFS buffer/);
	assert.throws(() => gtfs.loadFromBuffers([Buffer.alloc(0)], [" "]), /non-empty/);
	assert.throws(() => gtfs.loadFromBuffers([Buffer.alloc(0), Buffer.alloc(0)], ["same", "same"]), /unique/);
}

function testNestedArchiveExtraction() {
	const inner = createZip({ "agency.txt": "agency_name,agency_url,agency_timezone\nV/Line,https://vline.com.au,Australia/Melbourne\n" });
	// createZip accepts strings; rebuild the stored outer entry byte-for-byte for this binary fixture.
	const binaryOuter = (() => {
		const name = Buffer.from("1/google_transit.zip"), checksum = crc32(inner);
		const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
		local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(inner.length, 18); local.writeUInt32LE(inner.length, 22); local.writeUInt16LE(name.length, 26);
		central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
		central.writeUInt32LE(checksum, 16); central.writeUInt32LE(inner.length, 20); central.writeUInt32LE(inner.length, 24);
		central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
		const centralOffset = local.length + name.length + inner.length;
		end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
		end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(centralOffset, 16);
		return Buffer.concat([local, name, inner, central, name, end]);
	})();
	assert.deepEqual(extractZipEntry(binaryOuter, "1/google_transit.zip"), inner);
	assert.throws(() => extractZipEntry(binaryOuter, "2/google_transit.zip"), /was not found/);
	assert.throws(() => extractZipEntry(Buffer.from("not a zip"), "1/google_transit.zip"), /not a valid ZIP/);
	assert.throws(() => extractZipEntry(Buffer.concat([binaryOuter, Buffer.from("trailing")]), "1/google_transit.zip"), /invalid end record/);
	const corrupt = Buffer.from(binaryOuter);
	corrupt[30 + Buffer.byteLength("1/google_transit.zip")] ^= 0xff;
	assert.throws(() => extractZipEntry(corrupt, "1/google_transit.zip"), /CRC check/);
}


function makeLargeShapeFeed(pointCount: number): Buffer {
	const rows = new Array<string>(pointCount + 1);
	rows[0] = shapesHeader;
	for (let i = 0; i < pointCount; i++) {
		rows[i + 1] = `decoy,-27.0,153.0,${i},${i}\n`;
	}
	return createZip({ "shapes.txt": rows.join("") });
}

function measure(iterations: number, query: () => Shape[]): number {
	const started = performance.now();
	for (let i = 0; i < iterations; i++) assert.equal(query().length, 3);
	return (performance.now() - started) / iterations;
}

async function testIndexedLookupScaling() {
	const pointCount = 150_000;
	const targetFeed = createZip({
		"shapes.txt":
			shapesHeader +
			"target,-27.1,153.1,1,\n" +
			"target,-27.2,153.2,2,1\n" +
			"target,-27.3,153.3,3,2\n",
	});
	const gtfs = new GTFS({ filesToLoad: ["shapes.txt"] });
	await gtfs.loadFromBuffers(
		[makeLargeShapeFeed(pointCount), targetFeed],
		["decoy-feed", "target-feed"],
	);

	for (let i = 0; i < 20; i++) {
		gtfs.getShapes({ shape_id: "target" });
		gtfs.getShapes({ feed_id: "target-feed" });
	}

	const indexedMs = measure(1_000, () =>
		gtfs.getShapes({ shape_id: "target" }),
	);
	const scanningMs = measure(100, () =>
		gtfs.getShapes({ feed_id: "target-feed" }),
	);
	const speedup = scanningMs / indexedMs;

	assert.ok(
		speedup >= 8,
		`shape_id lookup should avoid the ${pointCount}-point scan; measured ${speedup.toFixed(1)}x`,
	);
	console.log(
		`Shape lookup benchmark: ${indexedMs.toFixed(4)} ms indexed vs ` +
			`${scanningMs.toFixed(4)} ms full scan (${speedup.toFixed(1)}x)`,
	);
}

async function testSharedCalendarExpansionKeepsServiceExceptionsSeparate() {
	const header = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n";
	const daily = (service: string) => `${service},1,1,1,1,1,1,1,20240228,20240302\n`;
	const feed = (calendar: string, exceptions: string) => createZip({
		"calendar.txt": header + calendar,
		"calendar_dates.txt": "service_id,date,exception_type\n" + exceptions,
	});
	const gtfs = new GTFS({ filesToLoad: ["calendar.txt", "calendar_dates.txt"] });
	await gtfs.loadFromBuffers([
		feed(daily("shared") + daily("second") + "sunday,0,0,0,0,0,0,1,20240303,20240303\n" +
			"weekend,0,0,0,0,0,1,1,20240228,20240302\n",
			"shared,20240229,2\nsecond,20240303,1\nexception-only,20240229,1\n"),
		feed(daily("shared"), "shared,20240301,2\n"),
	], ["feed-a", "feed-b"]);
	const originalSetDate = Date.prototype.setUTCDate;
	let dateSteps = 0;
	Date.prototype.setUTCDate = function (date: number) {
		dateSteps++;
		return originalSetDate.call(this, date);
	};
	try {
		const dates = (feedId: string, localId: string) => gtfs.getServiceDates({ feedId, localId });
		assert.deepEqual(dates("feed-a", "shared"), ["20240228", "20240301", "20240302"]);
		assert.deepEqual(dates("feed-a", "second"), ["20240228", "20240229", "20240301", "20240302", "20240303"]);
		assert.deepEqual(dates("feed-b", "shared"), ["20240228", "20240229", "20240302"]);
		assert.deepEqual(dates("feed-a", "exception-only"), ["20240229"]);
		assert.deepEqual(dates("feed-a", "sunday"), ["20240303"]);
		assert.deepEqual(dates("feed-a", "weekend"), ["20240302"]);
		assert.deepEqual(dates("missing", "shared"), []);
		assert.equal(dateSteps, 9, "identical date ranges and weekdays must be expanded once per cache build");
		dates("feed-a", "shared").push("20990101");
		assert.equal(dates("feed-b", "shared").includes("20990101"), false);
	} finally {
		Date.prototype.setUTCDate = originalSetDate;
	}
	gtfs.clearStatic();
	assert.deepEqual(gtfs.getServiceDates({ feedId: "feed-a", localId: "shared" }), []);
}

function makeDifferentialTripUpdateFeed(updateId: string, tripId: string): Buffer {
	const header = Buffer.concat([protobufField(1, "2.0"), protobufVarintField(2, 1)]);
	const descriptor = protobufField(1, tripId);
	const tripUpdate = protobufField(1, descriptor);
	const entity = Buffer.concat([protobufField(1, updateId), protobufField(3, tripUpdate)]);
	return Buffer.concat([protobufField(1, header), protobufField(2, entity)]);
}

function makeDifferentialTombstone(updateId: string): Buffer {
	const header = Buffer.concat([protobufField(1, "2.0"), protobufVarintField(2, 1)]);
	const entity = Buffer.concat([protobufField(1, updateId), protobufVarintField(2, 1)]);
	return Buffer.concat([protobufField(1, header), protobufField(2, entity)]);
}

function makeTripUpdateFeedWithStops(updateId: string, tripId: string, stopIds: string[]): Buffer {
	const header = protobufField(1, "2.0");
	const descriptor = protobufField(1, tripId);
	const stopTimeUpdates = stopIds.map((stopId, index) => Buffer.concat([
		protobufVarintField(1, index + 1),
		protobufField(4, stopId),
	]));
	const tripUpdate = Buffer.concat([
		protobufField(1, descriptor),
		...stopTimeUpdates.map((stopTimeUpdate) => protobufField(2, stopTimeUpdate)),
	]);
	const entity = Buffer.concat([protobufField(1, updateId), protobufField(3, tripUpdate)]);
	return Buffer.concat([protobufField(1, header), protobufField(2, entity)]);
}

function testRealtimeTripUpdateStopIdFilter() {
	const gtfs = new GTFS();
	gtfs.updateRealtime({
		kind: "trip-updates",
		data: makeTripUpdateFeedWithStops("stop-filter-1", "trip-1", ["stop-A", "stop-B"]),
		targetFeedId: "feed",
		sourceId: "source-1",
	});
	gtfs.updateRealtime({
		kind: "trip-updates",
		data: makeTripUpdateFeedWithStops("stop-filter-2", "trip-2", ["stop-C"]),
		targetFeedId: "feed",
		sourceId: "source-2",
	});
	assert.deepEqual(
		gtfs.getRealtimeTripUpdates({ stop_id: "stop-A" }).map((update) => update.update_id),
		["stop-filter-1"],
	);
	assert.deepEqual(
		gtfs.getRealtimeTripUpdates({ stop_id: "stop-C" }).map((update) => update.update_id),
		["stop-filter-2"],
	);
	assert.deepEqual(gtfs.getRealtimeTripUpdates({ stop_id: "missing-stop" }), []);
	assert.deepEqual(
		gtfs.getRealtimeTripUpdates({ stop_id: "stop-A", trip_id: "trip-2" }),
		[],
		"stop_id must intersect with trip_id instead of being ignored",
	);
}

async function testCompiledSnapshotIntegrity() {
	const { readFileSync, writeFileSync } = await import("node:fs");
	const gtfs = new GTFS({ filesToLoad: ["stops.txt"] });
	await gtfs.loadFromBuffers(
		[createZip({ "stops.txt": "stop_id,stop_name\ns,GoodName\n" })],
		["integrity"],
	);
	mkdirSync("test_cache", { recursive: true });
	gtfs.saveCompiledSnapshot("test_cache/snapshot-integrity.bin");
	const good = readFileSync("test_cache/snapshot-integrity.bin");
	const needle = Buffer.from("GoodName");
	const at = good.indexOf(needle);
	assert.ok(at >= 0, "snapshot must embed the stop name bytes");
	const flipped = Buffer.from(good);
	flipped[at] ^= 0x01;
	writeFileSync("test_cache/snapshot-integrity-flipped.bin", flipped);
	assert.throws(
		() => new GTFS().loadCompiledSnapshot("test_cache/snapshot-integrity-flipped.bin"),
		/checksum|mismatch|corrupt|invalid/i,
		"a single-bit content flip must not load silently",
	);
	// Trailing bytes with a patched fileSize must also be rejected, not ignored.
	const patched = Buffer.concat([good, Buffer.from("EXTRA")]);
	patched.writeBigUInt64LE(BigInt(patched.length), 16);
	writeFileSync("test_cache/snapshot-integrity-trailing.bin", patched);
	assert.throws(
		() => new GTFS().loadCompiledSnapshot("test_cache/snapshot-integrity-trailing.bin"),
		/trailing|checksum|mismatch|size|extra|end/i,
		"trailing bytes must not load silently",
	);
}

async function testParentStationExactMatchContract() {
	// No README/types contract backs parent-station expansion: stop_id stays
	// exact-match and parent_station filters children exactly.
	const gtfs = new GTFS({ filesToLoad: ["stops.txt"] });
	await gtfs.loadFromBuffers(
		[createZip({
			"stops.txt":
				"stop_id,stop_name,location_type,parent_station\n" +
				"STN,Station,1,\nP1,Platform 1,0,STN\nS1,Solo,0,\n",
		})],
		["parent"],
	);
	assert.deepEqual(
		gtfs.getStops({ parent_station: "STN" } as Partial<import("./types.js").Stop>).map((stop) => stop.stop_id),
		["P1"],
	);
	assert.deepEqual(gtfs.getStops({ stop_id: "STN" }).map((stop) => stop.stop_id), ["STN"]);
}

async function testAdversarialParserAndAtomicPublication() {
	const gtfs = new GTFS({ filesToLoad: ["stops.txt"] });
	const good = createZip({ "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\ns,Good,-27,153\n" });
	await gtfs.loadFromBuffers([good], ["good"]);

	const bounded = new GTFS({ filesToLoad: ["stops.txt"], maxExtractedEntryBytes: 32 });
	await assert.rejects(
		bounded.loadFromBuffers([good], ["oversized"]),
		/exceeds extraction limits/,
	);

	const malformedNumber = createZip({ "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\ns,Bad,-27oops,153\n" });
	await assert.rejects(gtfs.loadFromBuffers([malformedNumber], ["bad"]), /floating-point/);
	assert.deepEqual(gtfs.getStops().map((stop) => stop.stop_name), ["Good"]);

	const missingColumn = createZip({ "stops.txt": "stop_name\nCollapsed\n" });
	await assert.rejects(gtfs.loadFromBuffers([missingColumn], ["bad"]), /required column stop_id/);
	assert.equal(gtfs.getStops().length, 1);

	const multiline = createZip({ "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\ns,\"Line one\nLine two\",-27,153\n" });
	await gtfs.loadFromBuffers([multiline], ["multiline"]);
	assert.equal(gtfs.getStops()[0].stop_name, "Line one\nLine two");

	const corrupt = Buffer.from(good);
	corrupt[30 + Buffer.byteLength("stops.txt") + 2] ^= 0xff;
	await assert.rejects(gtfs.loadFromBuffers([corrupt], ["corrupt"]), /extract/);
	assert.equal(gtfs.getStops()[0].stop_name, "Line one\nLine two");
}

function testRealtimeAtomicityAndIncrementality() {
	const gtfs = new GTFS();
	const first = makeTripUpdateFeed("one", "trip-one");
	gtfs.updateRealtime({ kind: "trip-updates", data: first, targetFeedId: "feed", sourceId: "source" });
	const revision = gtfs.getRealtimeRevision();
	assert.throws(() => gtfs.updateRealtime({
		kind: "trip-updates", data: Buffer.concat([first, Buffer.from([0xff])]), targetFeedId: "feed", sourceId: "source",
	}), /Failed to parse GTFS-RT/);
	assert.deepEqual(gtfs.getRealtimeTripUpdates().map((update) => update.update_id), ["one"]);
	assert.equal(gtfs.getRealtimeRevision(), revision);

	gtfs.updateRealtime({
		kind: "trip-updates", data: makeDifferentialTripUpdateFeed("two", "trip-two"), targetFeedId: "feed", sourceId: "source",
	});
	assert.deepEqual(gtfs.getRealtimeTripUpdates().map((update) => update.update_id).sort(), ["one", "two"]);
	gtfs.updateRealtime({
		kind: "trip-updates", data: makeDifferentialTombstone("one"), targetFeedId: "feed", sourceId: "source",
	});
	assert.deepEqual(gtfs.getRealtimeTripUpdates().map((update) => update.update_id), ["two"]);
	const unchangedRevision = gtfs.getRealtimeRevision();
	gtfs.updateRealtime({
		kind: "trip-updates",
		data: protobufField(1, Buffer.concat([protobufField(1, "2.0"), protobufVarintField(2, 1)])),
		targetFeedId: "feed",
		sourceId: "source",
	});
	assert.equal(gtfs.getRealtimeRevision(), unchangedRevision);

	assert.throws(() => gtfs.updateRealtime({
		kind: "trip-updates", data: makeVehicleFeedWithCarriages(), targetFeedId: "feed", sourceId: "wrong-kind",
	}), /Failed to parse GTFS-RT/);
	const vehicles = new GTFS();
	vehicles.updateRealtime({ kind: "vehicles", data: makeVehicleFeedWithCarriages(), targetFeedId: "feed", sourceId: "vehicles" });
	assert.equal(vehicles.getRealtimeVehiclePositions()[0].position, null);
}

async function testGenerationOwnershipAndMetadata() {
	const rows = Array.from({ length: 40_000 }, (_, index) => `big-${index},Big ${index},-27,153\n`).join("");
	const big = createZip({ "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\n" + rows });
	const small = createZip({ "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nsmall,Small,-27,153\n" });
	const gtfs = new GTFS({ filesToLoad: ["stops.txt"] });
	const older = gtfs.loadFromBuffers([big], ["big"]);
	const newer = gtfs.loadFromBuffers([small], ["small"]);
	await Promise.all([older, newer]);
	assert.deepEqual(gtfs.getStops().map((stop) => stop.stop_id), ["small"]);

	const pending = gtfs.loadFromBuffers([big], ["big"]);
	gtfs.clearStatic();
	await pending;
	assert.equal(gtfs.getStops().length, 0);

	const full = new GTFS();
	await full.loadFromBuffers([makeCollisionFeed("Metadata")], ["feed"]);
	assert.equal(full.getSnapshotRevision().trip_count, 2);
	assert.equal(full.getStaticSnapshotInfo().trip_count, 2);
	assert.deepEqual(full.getFrequencies({ trip_id: "shared-trip", feed_id: "feed" }), [{
		trip_id: "shared-trip", start_time: 21600, end_time: 32400, headway_secs: 600, exact_times: 1, feed_id: "feed",
	}]);
	assert.deepEqual(
		full.getStopTimes({ trip_id: "shared-trip", feed_id: "feed", date: "20260807", dateMode: "timestamp" })
			.map((stopTime) => stopTime.arrival_time).sort((a, b) => (a ?? 0) - (b ?? 0)),
		[5400, 91800],
	);
	assert.throws(() => full.getTrips({ direction_id: "abc" as unknown as number }), /must be an integer/);
	assert.deepEqual(full.getTrips({ date: "20260230" }), []);
	assert.throws(() => full.actions.mergeStops("missing", ["shared-stop"], "feed"), /target does not exist/);
	const packed = full.getStopTimesPacked({ trip_id: "shared-trip", feed_id: "feed" });
	assert.equal(packed.strings[packed.stopHeadsigns[0]], "");
	const dates = full.getServiceDates({ feedId: "feed", localId: "shared-service" });
	dates.push("20990101");
	assert.equal(full.getServiceDates({ feedId: "feed", localId: "shared-service" }).includes("20990101"), false);
	mkdirSync("test_cache", { recursive: true });
	full.saveCompiledSnapshot("test_cache/snapshot-roundtrip.bin");
	const restored = new GTFS();
	restored.loadCompiledSnapshot("test_cache/snapshot-roundtrip.bin");
	assert.deepEqual(restored.getFrequencies({ trip_id: "shared-trip" }), full.getFrequencies({ trip_id: "shared-trip" }));
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
	return address.port;
}

async function testRedirectPolicy() {
	let targetRequests = 0;
	const target = createServer((_request, response) => {
		targetRequests++;
		response.end("unexpected");
	});
	const targetPort = await listen(target);
	const source = createServer((_request, response) => {
		response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/feed.zip` });
		response.end();
	});
	const sourcePort = await listen(source);
	try {
		await assert.rejects(
			new GTFS().loadStatic({ id: "redirect", url: `http://127.0.0.1:${sourcePort}/start`, headers: { Authorization: "Bearer test-only" } }),
			/non-public address/,
		);
		assert.equal(targetRequests, 0, "a cross-origin redirect must be rejected before credentials or a request reach it");
	} finally {
		await Promise.all([
			new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve())),
			new Promise<void>((resolve, reject) => source.close((error) => error ? reject(error) : resolve())),
		]);
	}
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function agencyZip(name: string): Buffer {
	return createZip({ "agency.txt": `agency_name,agency_url,agency_timezone\n${name},https://example.invalid,Australia/Brisbane\n` });
}

async function testStaticDownloadBuffering() {
	const zip = agencyZip("Split");
	const server = createServer((request, response) => {
		const headers: Record<string, string> = { "content-type": "application/zip" };
		if (request.url === "/sized") headers["content-length"] = String(zip.length);
		response.writeHead(200, headers);
		response.write(zip.subarray(0, Math.floor(zip.length / 2)));
		response.end(zip.subarray(Math.floor(zip.length / 2)));
	});
	const port = await listen(server);
	try {
		for (const mode of ["sized", "chunked"]) {
			const gtfs = new GTFS({ filesToLoad: ["agency.txt"] });
			const result = await gtfs.loadStatic({ id: mode, url: `http://127.0.0.1:${port}/${mode}` });
			assert.equal(result[0].source, "network");
			assert.equal(gtfs.getAgencies()[0].agency_name, "Split");
		}
	} finally {
		await closeServer(server);
	}
}

async function testStaticFallbackUrls() {
	const fallbackZip = agencyZip("Fallback");
	let primaryHits = 0;
	let fallbackHits = 0;
	const primary = createServer((_request, response) => {
		primaryHits++;
		response.writeHead(500, { "content-type": "text/plain" });
		response.end("primary down");
	});
	const fallback = createServer((request, response) => {
		if (request.url?.includes("/missing")) {
			response.writeHead(500, { "content-type": "text/plain" });
			response.end("fallback down");
			return;
		}
		fallbackHits++;
		response.writeHead(200, { "content-type": "application/zip", "content-length": String(fallbackZip.length) });
		response.end(fallbackZip);
	});
	const primaryPort = await listen(primary);
	const fallbackPort = await listen(fallback);
	const primaryUrl = `http://127.0.0.1:${primaryPort}/feed.zip`;
	const fallbackUrl = `http://127.0.0.1:${fallbackPort}/feed.zip`;
	try {
		const gtfs = new GTFS({ filesToLoad: ["agency.txt"] });
		const results = await gtfs.loadStatic({ id: "fallback", url: primaryUrl, fallbackUrls: [fallbackUrl] });
		assert.equal(results[0].source, "network");
		assert.equal(gtfs.getAgencies()[0].agency_name, "Fallback");
		assert.equal(primaryHits, 1);
		assert.equal(fallbackHits, 1);

		// Primary success must not touch the fallback.
		let goodHits = 0;
		const good = createServer((_request, response) => {
			goodHits++;
			response.writeHead(200, { "content-type": "application/zip", "content-length": String(fallbackZip.length) });
			response.end(fallbackZip);
		});
		const goodPort = await listen(good);
		try {
			const beforeFallback = fallbackHits;
			const gtfs2 = new GTFS({ filesToLoad: ["agency.txt"] });
			await gtfs2.loadStatic({ id: "primary-ok", url: `http://127.0.0.1:${goodPort}/feed.zip`, fallbackUrls: [fallbackUrl] });
			assert.equal(goodHits, 1);
			assert.equal(fallbackHits, beforeFallback);
		} finally {
			await closeServer(good);
		}

		// Validation: duplicate, bad protocol, and non-array fallbacks are rejected.
		await assert.rejects(
			new GTFS().loadStatic({ id: "dup", url: primaryUrl, fallbackUrls: [primaryUrl] }),
			/duplicate fallback/,
		);
		await assert.rejects(
			new GTFS().loadStatic({ id: "proto", url: primaryUrl, fallbackUrls: ["ftp://example.invalid/feed.zip"] }),
			/http\(s\)/,
		);
		await assert.rejects(
			// @ts-expect-error runtime validation for non-array input
			new GTFS().loadStatic({ id: "array", url: primaryUrl, fallbackUrls: "not-an-array" }),
			/must be an array/,
		);
		// All URLs down with no cache must surface the last error.
		await assert.rejects(
			new GTFS({ filesToLoad: ["agency.txt"] }).loadStatic({ id: "down", url: primaryUrl, fallbackUrls: [`http://127.0.0.1:${fallbackPort}/missing`] }),
			/Failed to download|500/,
		);
	} finally {
		await Promise.all([closeServer(primary), closeServer(fallback)]);
	}
}

async function testRealtimeAggregateDeadline() {
	const fastPayload = makeTripUpdateFeed("fast-1", "trip-fast");
	let slowHits = 0;
	const fast = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(fastPayload.length) });
		response.end(fastPayload);
	});
	const slow = createServer((_request, response) => {
		slowHits++;
		setTimeout(() => {
			try {
				response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(fastPayload.length) });
				response.end(fastPayload);
			} catch {}
		}, 400);
	});
	const fastPort = await listen(fast);
	const slowPort = await listen(slow);
	const sources = (suffix: string) => ([
		{ id: `fast-${suffix}`, targetFeedId: "feed", kind: "trip-updates" as const, url: `http://127.0.0.1:${fastPort}/rt` },
		{ id: `slow-${suffix}`, targetFeedId: "feed", kind: "trip-updates" as const, url: `http://127.0.0.1:${slowPort}/rt` },
	]);
	try {
		const gtfs = new GTFS({ requestTimeoutMs: 5_000, realtimeTimeoutMs: 5_000 });
		await assert.rejects(gtfs.fetchRealtimeSources(sources("timeout"), { timeoutMs: 100 }), /timed out after 100ms/);
		assert.deepEqual(gtfs.getRealtimeTripUpdates(), [], "a timed-out aggregate must not mutate the snapshot");
		const fetched = await gtfs.fetchRealtimeSources(sources("ok"), { timeoutMs: 5_000 });
		assert.equal(fetched.length, 2);
		assert.ok(fetched.every((entry) => entry.ok), "fast aggregate within deadline must succeed");
		await assert.rejects(gtfs.fetchRealtimeSources(sources("bad"), { timeoutMs: 0 }), /positive finite/);
		assert.equal(slowHits >= 1, true);
	} finally {
		await Promise.all([closeServer(fast), closeServer(slow)]);
	}
}

async function testStaticCacheHeadersAndTempNaming() {
	const { readdirSync, rmSync } = await import("node:fs");
	const zip = agencyZip("Cached");
	let hits = 0;
	const server = createServer((_request, response) => {
		hits++;
		response.writeHead(200, { "content-type": "application/zip", "content-length": String(zip.length) });
		response.end(zip);
	});
	const port = await listen(server);
	const cacheDir = "test_cache/static-headers-temp";
	rmSync(cacheDir, { recursive: true, force: true });
	mkdirSync(cacheDir, { recursive: true });
	try {
		const url = `http://127.0.0.1:${port}/feed.zip`;
		const first = new GTFS({ cache: true, cacheDir, cacheMaxAgeMs: 60_000, filesToLoad: ["agency.txt"] });
		const r1 = await first.loadStatic({ id: "a", url, headers: { B: "2", A: "1" } });
		assert.equal(r1[0].source, "network");
		assert.equal(hits, 1);
		// Same headers in a different key order must hit the same canonical cache entry.
		const second = new GTFS({ cache: true, cacheDir, cacheMaxAgeMs: 60_000, filesToLoad: ["agency.txt"] });
		const r2 = await second.loadStatic({ id: "a", url, headers: { A: "1", B: "2" } });
		assert.equal(r2[0].source, "fresh-cache");
		assert.equal(hits, 1, "header key order must not fragment the static cache");
		const entries = readdirSync(cacheDir);
		assert.ok(entries.length >= 1, "cache directory must contain the unified entry");
		assert.deepEqual(entries.filter((name) => name.includes(".tmp.")), [], "no temp files may remain after atomic cache writes");
		assert.ok(entries.every((name) => !name.endsWith(".tmp")), "temp suffix must be identifiable and cleaned up");
	} finally {
		await closeServer(server);
	}
}

async function testCompiledSnapshotPreservesRealtime() {
	const { rmSync } = await import("node:fs");
	const gtfs = new GTFS({ filesToLoad: ["stops.txt"] });
	await gtfs.loadFromBuffers([createZip({ "stops.txt": "stop_id,stop_name\ns,Safety\n" })], ["safety"]);
	gtfs.updateRealtime({
		kind: "vehicles",
		data: makeVehicleFeedWithCarriages("safety-vehicle", "safety-trip"),
		targetFeedId: "safety",
		sourceId: "safety-source",
	});
	assert.equal(gtfs.getRealtimeVehiclePositions().length, 1);
	const changedBefore = gtfs.getLastChangedTripIds();
	assert.equal(changedBefore.length, 1);
	mkdirSync("test_cache", { recursive: true });
	const snapshotPath = "test_cache/snapshot-safety.bin";
	rmSync(snapshotPath, { force: true });
	gtfs.saveCompiledSnapshot(snapshotPath);
	// A failed load must leave the live snapshot and JS aggregate untouched.
	assert.throws(() => gtfs.loadCompiledSnapshot("test_cache/missing-safety.bin"), /Cannot read compiled snapshot/);
	assert.equal(gtfs.getStops()[0].stop_name, "Safety");
	assert.equal(gtfs.getRealtimeVehiclePositions().length, 1);
	// A successful load preserves the native realtime overlay and the JS aggregate.
	gtfs.loadCompiledSnapshot(snapshotPath);
	assert.equal(gtfs.getStops()[0].stop_name, "Safety");
	assert.equal(gtfs.getRealtimeVehiclePositions().length, 1);
	assert.deepEqual(gtfs.getLastChangedTripIds(), changedBefore);
	assert.throws(() => gtfs.loadCompiledSnapshot("  "), /non-empty/);
}

async function testPackageMetadata() {
	const { readFileSync, existsSync } = await import("node:fs");
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(pkg.browser, undefined, "browser field must stay removed (browser.ts was deleted)");
	assert.ok(Array.isArray(pkg.files), "files whitelist must exist so stale build outputs are not packed");
	assert.ok(pkg.files.includes("dist/*.js") || pkg.files.includes("dist/index.js"), "dist output must be packaged");
	assert.ok(!pkg.files.includes("build") && !pkg.files.includes("dist/build"), "stale native outputs must not be packaged");
	assert.ok(existsSync("dist/index.js") && existsSync("dist/types.js"), "exported entry points must exist after build");
	assert.equal(existsSync("dist/build/Release/gtfs_addon.node"), false, "stale dist/build ABI copy must not exist");
}

await testSharedCalendarExpansionKeepsServiceExceptionsSeparate();
await testShapeFiltersAndMergeStrategies();
await testQualifiedIdentityAndRealtimeProvenance();
await testTripStopTimeIndexAcrossFeeds();
await testQuotedTripAndStopTimeRows();
await testRepeatedStopTimeGroupsAfterGrowth();
await testStopTimeOrderingAndIndexes();
await testTripStopTimeBatchIndex();
await testTripStopTimeBoundsAcrossFeeds();
testFeedIdentityValidation();
testNestedArchiveExtraction();
await testRealtimeIndexesAndRefreshResult();
await testIndexedLookupScaling();
await testAdversarialParserAndAtomicPublication();
testRealtimeAtomicityAndIncrementality();
testRealtimeTripUpdateStopIdFilter();
await testParentStationExactMatchContract();
await testCompiledSnapshotIntegrity();
await testGenerationOwnershipAndMetadata();
await testRedirectPolicy();
await testStaticDownloadBuffering();
await testStaticFallbackUrls();
await testRealtimeAggregateDeadline();
await testStaticCacheHeadersAndTempNaming();
await testCompiledSnapshotPreservesRealtime();
await testPackageMetadata();
console.log("All QDF-GTFS tests passed.");
