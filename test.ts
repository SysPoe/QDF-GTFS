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
	assert.equal(all.length, 4);

	const shared = overwrite.getShapes({ shape_id: "shared" });
	assert.deepEqual(project(shared), [
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
		shared,
	);
	assert.deepEqual(
		overwrite.getShapes({ shape_id: "shared", feed_id: "feed-a" }),
		[],
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
		["feed-a", "feed-a"],
	);

	const throwing = new GTFS({
		filesToLoad: ["shapes.txt"],
		mergeStrategy: GTFSMergeStrategy.THROW,
	});
	await assert.rejects(
		throwing.loadFromBuffers([feedA, feedB], ["feed-a", "feed-b"]),
		/Duplicate shape: shared/,
	);
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
await testIndexedLookupScaling();
console.log("All QDF-GTFS tests passed.");
