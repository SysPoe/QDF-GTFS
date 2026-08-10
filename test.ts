import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { GTFS, GTFSMergeStrategy, type Shape } from "./index.js";

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
			"route_id,service_id,trip_id,shape_id\n" +
			"shared-route,shared-service,shared-trip,shared-shape\n",
		"stops.txt":
			"stop_id,stop_name,stop_lat,stop_lon\n" +
			`shared-stop,${name} Stop,-27.0,153.0\n`,
		"stop_times.txt":
			"trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
			"shared-trip,25:30:00,25:31:00,shared-stop,1\n",
		"calendar.txt":
			"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
			"shared-service,1,1,1,1,1,1,1,20260801,20260831\n",
		"calendar_dates.txt":
			"service_id,date,exception_type\n" +
			"shared-service,20260805,2\n",
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

function makeTripUpdateFeed(updateId: string, tripId: string): Buffer {
	const header = protobufField(1, "2.0");
	const descriptor = protobufField(1, tripId);
	const tripUpdate = protobufField(1, descriptor);
	const entity = Buffer.concat([protobufField(1, updateId), protobufField(3, tripUpdate)]);
	return Buffer.concat([protobufField(1, header), protobufField(2, entity)]);
}

async function testQualifiedIdentityAndRealtimeProvenance() {
	const gtfs = new GTFS();
	await gtfs.loadFromBuffers(
		[makeCollisionFeed("Alpha"), makeCollisionFeed("Beta")],
		["feed-a", "feed-b"],
	);

	assert.equal(gtfs.getTrips({ trip_id: "shared-trip" }).length, 2);
	assert.equal(gtfs.getStops({ stop_id: "shared-stop" }).length, 2);
	assert.equal(gtfs.getRoutes({ route_id: "shared-route" }).length, 2);
	assert.equal(gtfs.getStopTimes({ trip_id: "shared-trip" }).length, 2);
	assert.equal(gtfs.getShapes({ shape_id: "shared-shape" }).length, 2);
	assert.equal(gtfs.getCalendars({ service_id: "shared-service" }).length, 2);
	assert.equal(gtfs.getStopTimes({ trip_id: "shared-trip", feed_id: "feed-a" })[0].arrival_time, 91800);
	assert.equal(gtfs.getServiceDatesByTrip({ feedId: "feed-a", localId: "shared-trip" }).includes("20260805"), false);
	assert.equal(gtfs.getServiceDatesByTrip({ feedId: "feed-b", localId: "shared-trip" }).includes("20260806"), true);

	gtfs.updateRealtime({
		kind: "trip-updates",
		data: makeTripUpdateFeed("a-1", "shared-trip"),
		targetFeedId: "feed-a",
		sourceId: "source-a",
	});
	gtfs.updateRealtime({
		kind: "trip-updates",
		data: makeTripUpdateFeed("b-1", "shared-trip"),
		targetFeedId: "feed-b",
		sourceId: "source-b",
	});
	assert.deepEqual(
		gtfs.getRealtimeTripUpdates().map(({ update_id, feed_id, source_id }) => ({ update_id, feed_id, source_id })),
		[
			{ update_id: "a-1", feed_id: "feed-a", source_id: "source-a" },
			{ update_id: "b-1", feed_id: "feed-b", source_id: "source-b" },
		],
	);

	gtfs.updateRealtime({
		kind: "trip-updates",
		data: makeTripUpdateFeed("a-2", "shared-trip"),
		targetFeedId: "feed-a",
		sourceId: "source-a",
	});
	assert.deepEqual(
		gtfs.getRealtimeTripUpdates().map((update) => update.update_id).sort(),
		["a-2", "b-1"],
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

function testFeedIdentityValidation() {
	const gtfs = new GTFS();
	assert.throws(() => gtfs.loadFromBuffers([], []), /At least one GTFS buffer/);
	assert.throws(() => gtfs.loadFromBuffers([Buffer.alloc(0)], []), /one feed ID per GTFS buffer/);
	assert.throws(() => gtfs.loadFromBuffers([Buffer.alloc(0)], [" "]), /non-empty/);
	assert.throws(() => gtfs.loadFromBuffers([Buffer.alloc(0), Buffer.alloc(0)], ["same", "same"]), /unique/);
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

await testShapeFiltersAndMergeStrategies();
await testQualifiedIdentityAndRealtimeProvenance();
await testTripStopTimeIndexAcrossFeeds();
testFeedIdentityValidation();
await testIndexedLookupScaling();
console.log("All QDF-GTFS tests passed.");
