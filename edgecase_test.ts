import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GTFS, GTFSMergeStrategy } from "./index.js";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
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

let failures = 0;
function check(name: string, fn: () => Promise<void> | void) {
  return (async () => {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (e) {
      failures++;
      console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof assert.AssertionError) console.log(e.stack?.split("\n").slice(0, 6).join("\n"));
    }
  })();
}

// 1. shapes empty/invalid must throw, not 0,0
await check("shapes empty lat throws", async () => {
  const g = new GTFS({ filesToLoad: ["shapes.txt"] });
  const z = createZip({ "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns,,153.0,1\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /shapes\.txt/i);
});
await check("shapes empty lon throws", async () => {
  const g = new GTFS({ filesToLoad: ["shapes.txt"] });
  const z = createZip({ "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns,-27.0,,1\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /shapes\.txt/i);
});
await check("shapes invalid lat throws", async () => {
  const g = new GTFS({ filesToLoad: ["shapes.txt"] });
  const z = createZip({ "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns,oops,153.0,1\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /shapes\.txt|floating-point|coordinate/i);
});
await check("shapes NaN throws", async () => {
  const g = new GTFS({ filesToLoad: ["shapes.txt"] });
  const z = createZip({ "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns,NaN,153.0,1\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /shapes\.txt|floating-point|coordinate|finite/i);
});
await check("shapes Infinity throws", async () => {
  const g = new GTFS({ filesToLoad: ["shapes.txt"] });
  const z = createZip({ "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns,Infinity,153.0,1\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /shapes\.txt|floating-point|coordinate|finite|range/i);
});
await check("shapes valid passes", async () => {
  const g = new GTFS({ filesToLoad: ["shapes.txt"] });
  const z = createZip({ "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns,-27.0,153.0,1\n" });
  await g.loadFromBuffers([z], ["f"]);
  assert.equal(g.getShapes().length, 1);
});

// 2. route enum bounds
await check("routes empty route_type throws (no 0 fabrication)", async () => {
  const g = new GTFS({ filesToLoad: ["routes.txt"] });
  const z = createZip({ "routes.txt": "route_id,route_type\nr,\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /routes\.txt|route_type/i);
});
await check("routes negative route_type throws", async () => {
  const g = new GTFS({ filesToLoad: ["routes.txt"] });
  const z = createZip({ "routes.txt": "route_id,route_type\nr,-1\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /route_type|range/i);
});
await check("routes non-numeric route_type throws", async () => {
  const g = new GTFS({ filesToLoad: ["routes.txt"] });
  const z = createZip({ "routes.txt": "route_id,route_type\nr,oops\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /routes\.txt|integer|route_type/i);
});
await check("routes extended route_type 100 passes", async () => {
  const g = new GTFS({ filesToLoad: ["routes.txt"] });
  const z = createZip({ "routes.txt": "route_id,route_type\nr,100\n" });
  await g.loadFromBuffers([z], ["f"]);
  assert.equal(g.getRoutes()[0].route_type, 100);
});
await check("routes extended route_type 1501 passes", async () => {
  const g = new GTFS({ filesToLoad: ["routes.txt"] });
  const z = createZip({ "routes.txt": "route_id,route_type\nr,1501\n" });
  await g.loadFromBuffers([z], ["f"]);
  assert.equal(g.getRoutes()[0].route_type, 1501);
});
await check("routes continuous_pickup 5 throws", async () => {
  const g = new GTFS({ filesToLoad: ["routes.txt"] });
  const z = createZip({ "routes.txt": "route_id,route_type,continuous_pickup\nr,3,5\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /continuous_pickup|range/i);
});
await check("routes continuous_drop_off -1 throws", async () => {
  const g = new GTFS({ filesToLoad: ["routes.txt"] });
  const z = createZip({ "routes.txt": "route_id,route_type,continuous_drop_off\nr,3,-1\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /continuous_drop_off|range/i);
});
await check("routes continuous 0-3 pass + empty null", async () => {
  const g = new GTFS({ filesToLoad: ["routes.txt"] });
  const z = createZip({ "routes.txt": "route_id,route_type,continuous_pickup,continuous_drop_off\nr,3,0,3\n" });
  await g.loadFromBuffers([z], ["f"]);
  assert.equal(g.getRoutes()[0].continuous_pickup, 0);
  const g2 = new GTFS({ filesToLoad: ["routes.txt"] });
  const z2 = createZip({ "routes.txt": "route_id,route_type\nr2,3\n" });
  await g2.loadFromBuffers([z2], ["f"]);
  assert.equal(g2.getRoutes()[0].continuous_pickup, null);
});
await check("routes sort_order -1 throws", async () => {
  const g = new GTFS({ filesToLoad: ["routes.txt"] });
  const z = createZip({ "routes.txt": "route_id,route_type,route_sort_order\nr,3,-1\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /route_sort_order|range/i);
});
await check("routes sort_order 0 passes", async () => {
  const g = new GTFS({ filesToLoad: ["routes.txt"] });
  const z = createZip({ "routes.txt": "route_id,route_type,route_sort_order\nr,3,0\n" });
  await g.loadFromBuffers([z], ["f"]);
  assert.equal(g.getRoutes()[0].route_sort_order, 0);
});

// 4. occupancies malformed must throw atomically
await check("occupancies invalid status throws (not skip)", async () => {
  const g = new GTFS({ filesToLoad: ["occupancies.txt"] });
  const z = createZip({ "occupancies.txt": "trip_id,stop_sequence,occupancy_status,start_date\nt,1,99,20260801\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /occupancies|occupancy_status/i);
});
await check("occupancies empty trip throws", async () => {
  const g = new GTFS({ filesToLoad: ["occupancies.txt"] });
  const z = createZip({ "occupancies.txt": "trip_id,stop_sequence,occupancy_status,start_date\n,1,1,20260801\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /occupancies\.txt/i);
});
await check("occupancies non-numeric status throws", async () => {
  const g = new GTFS({ filesToLoad: ["occupancies.txt"] });
  const z = createZip({ "occupancies.txt": "trip_id,stop_sequence,occupancy_status,start_date\nt,1,oops,20260801\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /occupancies\.txt|integer/i);
});
await check("occupancies atomic: good rows not published on bad row", async () => {
  const g = new GTFS({ filesToLoad: ["occupancies.txt"] });
  const good = createZip({ "occupancies.txt": "trip_id,stop_sequence,occupancy_status,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date\nt,1,1,1,1,1,1,1,1,1,20260801\n" });
  await g.loadFromBuffers([good], ["good"]);
  assert.equal(g.getStaticOccupancies({ trip_id: "t", feed_id: "good", date: "20260801" }).length, 1);
  const bad = createZip({ "occupancies.txt": "trip_id,stop_sequence,occupancy_status,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date\nt,1,1,1,1,1,1,1,1,1,20260801\nt,2,99,1,1,1,1,1,1,1,20260801\n" });
  await assert.rejects(g.loadFromBuffers([bad], ["bad"]), /occupancies|occupancy_status/i);
  // previous snapshot must survive the failed load
  assert.equal(g.getStaticOccupancies({ trip_id: "t", feed_id: "good", date: "20260801" }).length, 1);
});

// 3. merge strategy for 4 entities
await check("feed_info THROW on second row same feed", async () => {
  const g = new GTFS({ filesToLoad: ["feed_info.txt"], mergeStrategy: GTFSMergeStrategy.THROW });
  const z = createZip({ "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang\nA,https://a.invalid,en\nB,https://b.invalid,en\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /uplicate|feed_info/i);
});
await check("feed_info IGNORE keeps first", async () => {
  const g = new GTFS({ filesToLoad: ["feed_info.txt"], mergeStrategy: GTFSMergeStrategy.IGNORE });
  const z = createZip({ "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang\nFirst,https://a.invalid,en\nSecond,https://b.invalid,en\n" });
  await g.loadFromBuffers([z], ["f"]);
  const infos = g.getFeedInfo();
  assert.equal(infos.length, 1);
  assert.equal(infos[0].feed_publisher_name, "First");
});
await check("feed_info OVERWRITE keeps last", async () => {
  const g = new GTFS({ filesToLoad: ["feed_info.txt"], mergeStrategy: GTFSMergeStrategy.OVERWRITE });
  const z = createZip({ "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang\nFirst,https://a.invalid,en\nSecond,https://b.invalid,en\n" });
  await g.loadFromBuffers([z], ["f"]);
  const infos = g.getFeedInfo();
  assert.equal(infos.length, 1);
  assert.equal(infos[0].feed_publisher_name, "Second");
});
await check("feed_info cross-feed both kept under THROW", async () => {
  const g = new GTFS({ filesToLoad: ["feed_info.txt"], mergeStrategy: GTFSMergeStrategy.THROW });
  const za = createZip({ "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang\nA,https://a.invalid,en\n" });
  const zb = createZip({ "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang\nB,https://b.invalid,en\n" });
  await g.loadFromBuffers([za, zb], ["fa", "fb"]);
  assert.equal(g.getFeedInfo().length, 2);
});
await check("frequencies THROW on duplicate trip+start", async () => {
  const g = new GTFS({ filesToLoad: ["frequencies.txt"], mergeStrategy: GTFSMergeStrategy.THROW });
  const z = createZip({ "frequencies.txt": "trip_id,start_time,end_time,headway_secs\nt,06:00:00,09:00:00,600\nt,06:00:00,10:00:00,300\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /uplicate|frequencies/i);
});
await check("frequencies IGNORE keeps first", async () => {
  const g = new GTFS({ filesToLoad: ["frequencies.txt"], mergeStrategy: GTFSMergeStrategy.IGNORE });
  const z = createZip({ "frequencies.txt": "trip_id,start_time,end_time,headway_secs\nt,06:00:00,09:00:00,600\nt,06:00:00,10:00:00,300\n" });
  await g.loadFromBuffers([z], ["f"]);
  const rows = g.getFrequencies({ trip_id: "t" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].headway_secs, 600);
});
await check("frequencies OVERWRITE keeps last", async () => {
  const g = new GTFS({ filesToLoad: ["frequencies.txt"], mergeStrategy: GTFSMergeStrategy.OVERWRITE });
  const z = createZip({ "frequencies.txt": "trip_id,start_time,end_time,headway_secs\nt,06:00:00,09:00:00,600\nt,06:00:00,10:00:00,300\n" });
  await g.loadFromBuffers([z], ["f"]);
  const rows = g.getFrequencies({ trip_id: "t" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].headway_secs, 300);
});
await check("frequencies cross-feed same key both kept under THROW", async () => {
  const g = new GTFS({ filesToLoad: ["frequencies.txt"], mergeStrategy: GTFSMergeStrategy.THROW });
  const mk = () => createZip({ "frequencies.txt": "trip_id,start_time,end_time,headway_secs\nt,06:00:00,09:00:00,600\n" });
  await g.loadFromBuffers([mk(), mk()], ["fa", "fb"]);
  assert.equal(g.getFrequencies({ trip_id: "t" }).length, 2);
});
await check("transfers THROW on duplicate key", async () => {
  const g = new GTFS({ filesToLoad: ["transfers.txt"], mergeStrategy: GTFSMergeStrategy.THROW });
  const z = createZip({ "transfers.txt": "from_stop_id,to_stop_id,transfer_type,min_transfer_time\na,b,2,60\na,b,2,120\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /uplicate|transfers/i);
});
await check("transfers IGNORE keeps first", async () => {
  const g = new GTFS({ filesToLoad: ["transfers.txt"], mergeStrategy: GTFSMergeStrategy.IGNORE });
  const z = createZip({ "transfers.txt": "from_stop_id,to_stop_id,transfer_type,min_transfer_time\na,b,2,60\na,b,2,120\n" });
  await g.loadFromBuffers([z], ["f"]);
  const rows = g.getTransfers();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].min_transfer_time, 60);
});
await check("transfers OVERWRITE keeps last", async () => {
  const g = new GTFS({ filesToLoad: ["transfers.txt"], mergeStrategy: GTFSMergeStrategy.OVERWRITE });
  const z = createZip({ "transfers.txt": "from_stop_id,to_stop_id,transfer_type,min_transfer_time\na,b,2,60\na,b,2,120\n" });
  await g.loadFromBuffers([z], ["f"]);
  const rows = g.getTransfers();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].min_transfer_time, 120);
});
await check("transfers cross-feed same key both kept under THROW", async () => {
  const g = new GTFS({ filesToLoad: ["transfers.txt"], mergeStrategy: GTFSMergeStrategy.THROW });
  const mk = () => createZip({ "transfers.txt": "from_stop_id,to_stop_id,transfer_type\na,b,2\n" });
  await g.loadFromBuffers([mk(), mk()], ["fa", "fb"]);
  assert.equal(g.getTransfers().length, 2);
});
await check("occupancies THROW on exact duplicate", async () => {
  const g = new GTFS({ filesToLoad: ["occupancies.txt"], mergeStrategy: GTFSMergeStrategy.THROW });
  const z = createZip({ "occupancies.txt": "trip_id,stop_sequence,occupancy_status,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date\nt,1,1,1,1,1,1,1,1,1,20260801\nt,1,1,1,1,1,1,1,1,1,20260801\n" });
  await assert.rejects(g.loadFromBuffers([z], ["f"]), /uplicate|occupancies/i);
});
await check("occupancies IGNORE dedups exact duplicate", async () => {
  const g = new GTFS({ filesToLoad: ["occupancies.txt"], mergeStrategy: GTFSMergeStrategy.IGNORE });
  const z = createZip({ "occupancies.txt": "trip_id,stop_sequence,occupancy_status,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date\nt,1,1,1,1,1,1,1,1,1,20260801\nt,1,1,1,1,1,1,1,1,1,20260801\n" });
  await g.loadFromBuffers([z], ["f"]);
  const rows = g.getStaticOccupancies({ trip_id: "t", feed_id: "f", date: "20260801" });
  assert.equal(rows.length, 1);
});
await check("occupancies OVERWRITE replaces exact duplicate", async () => {
  const g = new GTFS({ filesToLoad: ["occupancies.txt"], mergeStrategy: GTFSMergeStrategy.OVERWRITE });
  const z = createZip({ "occupancies.txt": "trip_id,stop_sequence,occupancy_status,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date\nt,1,1,1,1,1,1,1,1,1,20260801\nt,1,1,1,1,1,1,1,1,1,20260801\n" });
  await g.loadFromBuffers([z], ["f"]);
  const rows = g.getStaticOccupancies({ trip_id: "t", feed_id: "f", date: "20260801" });
  assert.equal(rows.length, 1);
});
await check("occupancies cross-feed same row both kept under THROW", async () => {
  const g = new GTFS({ filesToLoad: ["occupancies.txt"], mergeStrategy: GTFSMergeStrategy.THROW });
  const mk = () => createZip({ "occupancies.txt": "trip_id,stop_sequence,occupancy_status,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date\nt,1,1,1,1,1,1,1,1,1,20260801\n" });
  await g.loadFromBuffers([mk(), mk()], ["fa", "fb"]);
  // should not throw; both feeds' rows preserved (query per-feed)
  const a = g.getStaticOccupancies({ trip_id: "t", feed_id: "fa", date: "20260801" });
  const b = g.getStaticOccupancies({ trip_id: "t", feed_id: "fb", date: "20260801" });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

// 5. snapshot.h stale
await check("snapshot.h version reconciled to 4 + frequencyCount", async () => {
  const text = readFileSync("src/snapshot.h", "utf8");
  assert.match(text, /SNAPSHOT_VERSION\s*=\s*4/);
  assert.match(text, /frequencyCount/);
  assert.doesNotMatch(text, /computeSnapshotContentKey/);
});

if (failures) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else console.log("\nAll edge-case checks passed.");
