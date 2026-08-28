import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { GTFS } from "../index.js";

const stopTimesHeader = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n";

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

/** Build a stored ZIP so the benchmark does not depend on a system ZIP tool. */
function createStoredZip(files: Record<string, string>): Buffer {
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

function createDeterministicFixture(tripCount = 50_000, stopsPerTrip = 8): Buffer {
	const rows = new Array<string>(tripCount * stopsPerTrip + 1);
	rows[0] = stopTimesHeader;
	let rowIndex = 1;
	for (let tripIndex = 0; tripIndex < tripCount; tripIndex++) {
		const tripId = `trip-${tripIndex.toString().padStart(6, "0")}`;
		for (let sequence = stopsPerTrip; sequence > 0; sequence--) {
			const hour = 6 + (tripIndex % 12);
			const minute = (tripIndex * 7 + sequence) % 60;
			const time = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:00`;
			rows[rowIndex++] = `${tripId},${time},${time},stop-${sequence},${sequence}\n`;
		}
	}
	return createStoredZip({ "stop_times.txt": rows.join("") });
}

function readTiming(logs: string[], pattern: RegExp): number | null {
	const message = logs.find((entry) => pattern.test(entry));
	const match = message?.match(pattern);
	return match ? Number(match[1]) : null;
}

function readRows(logs: string[], pattern: RegExp): number | null {
	const message = logs.find((entry) => pattern.test(entry));
	const match = message?.match(pattern);
	return match ? Number(match[2]) : null;
}

async function benchmark(name: string, archive: Buffer, feedId: string) {
	const logs: string[] = [];
	const started = performance.now();
	const gtfs = new GTFS({ logger: (message) => logs.push(message) });
	await gtfs.loadFromBuffers([archive], [feedId]);
	const totalMs = performance.now() - started;
	await new Promise<void>((resolve) => setImmediate(resolve));

	console.log(JSON.stringify({
		name,
		archiveBytes: archive.length,
		stopTimeRows: readRows(logs, /Parsed stop_times\.txt in ([0-9.]+)ms \(([0-9]+) records\)/),
		stopTimesParseMs: readTiming(logs, /Parsed stop_times\.txt in ([0-9.]+)ms/),
		finalizationMs: readTiming(logs, /Finalized data in ([0-9.]+)ms/),
		totalStaticLoadMs: Number(totalMs.toFixed(3)),
		maxRssKb: process.resourceUsage().maxRSS,
	}));
}

await benchmark("deterministic", createDeterministicFixture(), "fixture-feed");

const archivePath = process.argv[2];
if (archivePath) {
	await benchmark("real-seq", fs.readFileSync(archivePath), "translink-seq");
}
