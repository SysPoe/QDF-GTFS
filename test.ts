import { GTFS } from "./index.js";
import fs from "fs";

async function main() {
	let g = new GTFS( { ansi: true, logger: console.log } );

	console.log( "Loading..." );
	let startTime = Date.now();

	if ( fs.existsSync( "cache/SEQ_GTFS.zip" ) ) await g.loadFromPath( ["cache/SEQ_GTFS.zip"] );
	else await g.loadStatic( ["https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"] );

	getAppMemoryUsage();

	console.log( "Done in", Date.now() - startTime, "ms" );
	console.log( "Found", g.getAgencies().length, "agencies" );
	console.log( "Found", g.getCalendars().length, "calendars" );
	console.log( "Found", g.getCalendarDates().length, "calendar dates" );
	console.log( "Found", g.getFeedInfo(), "feed info" );
	console.log( "Found", g.getShapes().length, "shapes" );
	console.log( "Found", g.getStops().length, "stops" );
	console.log( "Found", g.getTrips().length, "trips" );
	console.log( "Found", g.getStopTimes().length, "stopTimes" );
}

function getAppMemoryUsage() {
	const usage = process.memoryUsage();

	console.log( "--- Current Node.js App Memory Usage ---" );
	console.log( `RSS (Resident Set Size): ${( usage.rss / 1024 / 1024 ).toFixed( 2 )} MB` );
	console.log( `Heap Total: ${( usage.heapTotal / 1024 / 1024 ).toFixed( 2 )} MB` );
	console.log( `Heap Used: ${( usage.heapUsed / 1024 / 1024 ).toFixed( 2 )} MB` );
	console.log( `External: ${( usage.external / 1024 / 1024 ).toFixed( 2 )} MB` );
	console.log( "------------------------------------------" );
}
main();
