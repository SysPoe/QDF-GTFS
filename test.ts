import { GTFS } from "./index.js";

async function main() {
	let g = new GTFS({ ansi: true, logger: console.log });

	console.log("Loading...");
	let startTime = Date.now();

	await g.loadFromUrl("https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip");

	getAppMemoryUsage();

	console.log("Done in", Date.now() - startTime, "ms");
}

function getAppMemoryUsage() {
	const usage = process.memoryUsage();

	console.log('--- Current Node.js App Memory Usage ---');
	console.log(`RSS (Resident Set Size): ${(usage.rss / 1024 / 1024).toFixed(2)} MB`);
	console.log(`Heap Total: ${(usage.heapTotal / 1024 / 1024).toFixed(2)} MB`);
	console.log(`Heap Used: ${(usage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
	console.log(`External: ${(usage.external / 1024 / 1024).toFixed(2)} MB`);
	console.log('------------------------------------------');
}


main();