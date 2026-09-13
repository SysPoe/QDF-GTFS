import assert from "node:assert/strict";
import { GTFS } from "./index.js";

// Dedicated P1 red tests: (1) updateStop range validation, (2) mergeStops transfer remap.
// New file to avoid contention with test.ts / edgecase_test.ts / p1_validated_*.ts.

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

async function makeStopGtfs() {
  const g = new GTFS({ filesToLoad: ["stops.txt"] });
  await g.loadFromBuffers(
    [createZip({ "stops.txt": "stop_id,stop_name,location_type,wheelchair_boarding\ns,Main,1,1\n" })],
    ["f"],
  );
  return g;
}

// (1) updateStop must enforce the stops.txt parser contract:
// location_type 0..4, wheelchair_boarding 0..2. Null clears; out-of-range throws
// and leaves the stored row unchanged (validate before mutate, like stop_lat/lon).
async function testUpdateStopRanges() {
  for (const bad of [5, -1, 99, 1.5, Number.NaN]) {
    const g = await makeStopGtfs();
    assert.throws(
      () => g.actions.updateStop("s", { location_type: bad as never }, "f"),
      /out of range|must be an integer/i,
      `location_type ${String(bad)} must be rejected`,
    );
    // Atomic: failed validation must not mutate the row.
    assert.equal(g.getStops({ stop_id: "s" })[0].location_type, 1);
  }
  for (const bad of [3, -1, 99, 1.5, Number.NaN]) {
    const g = await makeStopGtfs();
    assert.throws(
      () => g.actions.updateStop("s", { wheelchair_boarding: bad as never }, "f"),
      /out of range|must be an integer/i,
      `wheelchair_boarding ${String(bad)} must be rejected`,
    );
    assert.equal(g.getStops({ stop_id: "s" })[0].wheelchair_boarding, 1);
  }
  // Wrong JS type (string) must also be rejected, not silently truncated.
  {
    const g = await makeStopGtfs();
    assert.throws(
      // @ts-expect-error runtime validation for wrong type
      () => g.actions.updateStop("s", { location_type: "1" }, "f"),
      /must be an integer/i,
    );
    assert.equal(g.getStops({ stop_id: "s" })[0].location_type, 1);
  }
  {
    const g = await makeStopGtfs();
    assert.throws(
      // @ts-expect-error runtime validation for wrong type
      () => g.actions.updateStop("s", { wheelchair_boarding: "1" }, "f"),
      /must be an integer/i,
    );
    assert.equal(g.getStops({ stop_id: "s" })[0].wheelchair_boarding, 1);
  }
  // Boundaries pass and null clears (optional semantics, consistent with lat/lon).
  {
    const g = await makeStopGtfs();
    assert.equal(g.actions.updateStop("s", { location_type: 4 }, "f"), true);
    assert.equal(g.getStops({ stop_id: "s" })[0].location_type, 4);
    assert.equal(g.actions.updateStop("s", { location_type: 0 }, "f"), true);
    assert.equal(g.getStops({ stop_id: "s" })[0].location_type, 0);
    assert.equal(g.actions.updateStop("s", { location_type: null }, "f"), true);
    assert.equal(g.getStops({ stop_id: "s" })[0].location_type, null);
  }
  {
    const g = await makeStopGtfs();
    assert.equal(g.actions.updateStop("s", { wheelchair_boarding: 2 }, "f"), true);
    assert.equal(g.getStops({ stop_id: "s" })[0].wheelchair_boarding, 2);
    assert.equal(g.actions.updateStop("s", { wheelchair_boarding: 0 }, "f"), true);
    assert.equal(g.getStops({ stop_id: "s" })[0].wheelchair_boarding, 0);
    assert.equal(g.actions.updateStop("s", { wheelchair_boarding: null }, "f"), true);
    assert.equal(g.getStops({ stop_id: "s" })[0].wheelchair_boarding, null);
  }
}

// (2) mergeStops must remap transfers feed-consistently, dedup by transfer
// identity (feed + from/to stops/routes/trips + transfer_type, min_transfer_time
// is the value, OVERWRITE/last-wins like the parser), and leave no dangling refs.
async function testMergeStopsRemapsTransfers() {
  const stops = "stop_id,stop_name\nT,Target\nS1,Source1\nS2,Source2\nX,Other\n";
  // a/b collide after remap (same identity, different min values).
  const transfers =
    "from_stop_id,to_stop_id,transfer_type,min_transfer_time\n" +
    "S1,X,2,60\n" + // a: becomes T->X type 2
    "T,X,2,120\n" + // b: pre-existing T->X type 2 (dedup to one, last wins => 120)
    "X,S1,0,\n" + // c: becomes X->T
    "S1,S2,0,\n" + // d: both sources => T->T type 0
    "S2,S2,1,\n"; // e: source self-loop => T->T type 1 (distinct type, kept)
  const g = new GTFS({ filesToLoad: ["stops.txt", "transfers.txt"] });
  const otherTransfers = "from_stop_id,to_stop_id,transfer_type,min_transfer_time\nS1,X,2,60\n";
  await g.loadFromBuffers(
    [
      createZip({ "stops.txt": stops, "transfers.txt": transfers }),
      createZip({ "stops.txt": stops, "transfers.txt": otherTransfers }),
    ],
    ["m", "other"],
  );

  g.actions.mergeStops("T", ["S1", "S2"], "m");

  // Sources deleted, target remains (existing behaviour, preserved).
  assert.deepEqual(g.getStops({ feed_id: "m" }).map((s) => s.stop_id).sort(), ["T", "X"]);
  // No dangling refs in the merged feed.
  for (const t of g.getTransfers({ feed_id: "m" })) {
    assert.notEqual(t.from_stop_id, "S1");
    assert.notEqual(t.from_stop_id, "S2");
    assert.notEqual(t.to_stop_id, "S1");
    assert.notEqual(t.to_stop_id, "S2");
  }
  // Remap directions: X->S1 becomes X->T.
  const xToT = g.getTransfers({ feed_id: "m", to_stop_id: "T" } as never);
  assert.ok(xToT.some((t) => t.from_stop_id === "X" && t.transfer_type === 0), "X->S1 must remap to X->T");
  // Both-sources transfer becomes a target self-loop.
  const selfZero = g.getTransfers({ feed_id: "m", from_stop_id: "T", to_stop_id: "T" } as never);
  assert.ok(selfZero.some((t) => t.transfer_type === 0), "S1->S2 must remap to T->T");
  assert.ok(selfZero.some((t) => t.transfer_type === 1), "S2->S2 must remap to T->T type 1");
  // Dedup: a/b collapse to a single T->X type-2 row (OVERWRITE parity: last wins).
  const tToX = g.getTransfers({ feed_id: "m", from_stop_id: "T", to_stop_id: "X" } as never);
  const type2 = tToX.filter((t) => t.transfer_type === 2);
  assert.equal(type2.length, 1, "remap-collided transfers must deduplicate by identity");
  assert.equal(type2[0].min_transfer_time, 120);
  assert.equal(g.getTransfers({ feed_id: "m" }).length, 4);
  // Adjacent invariant: other feed untouched (feed-scoped remap).
  assert.deepEqual(
    g.getTransfers({ feed_id: "other" }).map((t) => [t.from_stop_id, t.to_stop_id]),
    [["S1", "X"]],
  );
  assert.equal(g.getStops({ feed_id: "other" }).length, 4);
}

// Adjacent mutable action: updateStop must not disturb transfer identity.
async function testUpdateStopLeavesTransfersIntact() {
  const g = new GTFS({ filesToLoad: ["stops.txt", "transfers.txt"] });
  await g.loadFromBuffers(
    [
      createZip({
        "stops.txt": "stop_id,stop_name\nA,Alpha\nB,Beta\n",
        "transfers.txt": "from_stop_id,to_stop_id,transfer_type\nA,B,2\n",
      }),
    ],
    ["f"],
  );
  assert.equal(g.actions.updateStop("A", { stop_name: "Alpha2" }, "f"), true);
  assert.deepEqual(
    g.getTransfers({ feed_id: "f" }).map((t) => [t.from_stop_id, t.to_stop_id, t.transfer_type]),
    [["A", "B", 2]],
  );
}

await testUpdateStopRanges();
console.log("PASS updateStop range validation");
await testMergeStopsRemapsTransfers();
console.log("PASS mergeStops transfer remap+dedup");
await testUpdateStopLeavesTransfersIntact();
console.log("PASS adjacent updateStop transfer invariant");
console.log("All P1 stop-action checks passed.");
