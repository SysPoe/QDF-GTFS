import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { GTFS } from "../dist/index.js";

// An optional local archive measures captured feed calendars without network I/O.
const archive = process.argv[2];
const count = Number.parseInt(process.env.QDF_CALENDAR_COUNT ?? "1200", 10);
assert.ok(Number.isInteger(count) && count > 0);
let calendars;
let exceptions;
if (archive) {
	const parsed = new GTFS({ filesToLoad: ["calendar.txt", "calendar_dates.txt"], logger: () => {}, progress: () => {} });
	await parsed.loadFromBuffers([fs.readFileSync(archive)], ["calendar-benchmark"]);
	calendars = parsed.getCalendars();
	exceptions = parsed.getCalendarDates();
} else {
	calendars = Array.from({ length: count }, (_, index) => ({
		feed_id: `feed-${index % 2}`,
		service_id: `service-${index}`,
		start_date: "20240101",
		end_date: "20241231",
		monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
		saturday: index % 3 === 0, sunday: index % 3 === 1,
	}));
	exceptions = calendars.map((calendar, index) => ({
		feed_id: calendar.feed_id, service_id: calendar.service_id,
		date: "20240229", exception_type: index % 2 === 0 ? 1 : 2,
	}));
}
assert.ok(calendars.length > 0);
const variants = [["current", GTFS]];
if (process.env.QDF_CALENDAR_BASELINE_MODULE) {
	const baseline = await import(pathToFileURL(path.resolve(process.env.QDF_CALENDAR_BASELINE_MODULE)));
	variants.unshift(["baseline", baseline.GTFS]);
}
const samples = new Map(variants.map(([name]) => [name, []]));
let expectedHash;
for (let round = 0; round < 7; round++) {
	for (const [name, Constructor] of round % 2 ? [...variants].reverse() : variants) {
		const gtfs = new Constructor();
		gtfs.getCalendars = () => calendars;
		gtfs.getCalendarDates = () => exceptions;
		globalThis.gc?.();
		const cpuStart = process.cpuUsage();
		const start = performance.now();
		const dates = calendars.map(({ feed_id, service_id }) => gtfs.getServiceDates({ feedId: feed_id, localId: service_id }));
		const elapsedMs = performance.now() - start;
		const cpu = process.cpuUsage(cpuStart);
		const hash = crypto.createHash("sha256").update(JSON.stringify(dates)).digest("hex");
		expectedHash ??= hash;
		assert.equal(hash, expectedHash, "calendar results changed between implementations or runs");
		samples.get(name).push({ elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000 });
	}
}
for (const [name, rows] of samples) {
	const median = (key) => [...rows].sort((a, b) => a[key] - b[key])[Math.floor(rows.length / 2)][key];
	console.log(JSON.stringify({
		benchmark: "service-calendar-expansion", variant: name, source: archive ?? "synthetic", calendars: calendars.length,
		exceptions: exceptions.length, rounds: rows.length, sha256: expectedHash,
		medianMs: Number(median("elapsedMs").toFixed(3)), medianCpuMs: Number(median("cpuMs").toFixed(3)),
	}));
}
