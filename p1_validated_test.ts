import assert from "node:assert/strict";
import { GTFS } from "./index.js";

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
function makeAlertFeedWithCauseEffect(id: string, cause: number | null, effect: number | null): Buffer {
  const parts: Buffer[] = [];
  if (cause !== null) parts.push(protobufVarintField(6, cause));
  if (effect !== null) parts.push(protobufVarintField(7, effect));
  const alert = Buffer.concat(parts);
  const entity = Buffer.concat([protobufField(1, id), protobufField(5, alert)]);
  return Buffer.concat([protobufField(1, protobufField(1, "2.0")), protobufField(2, entity)]);
}

// (1) transfers.txt must require transfer_type rather than fabricate 0
async function testTransfersRequiresType() {
  const missingCol = new GTFS({ filesToLoad: ["transfers.txt"] });
  await assert.rejects(
    missingCol.loadFromBuffers([createZip({ "transfers.txt": "from_stop_id,to_stop_id\na,b\n" })], ["f"]),
    /transfer_type/i,
  );
  const emptyVal = new GTFS({ filesToLoad: ["transfers.txt"] });
  await assert.rejects(
    emptyVal.loadFromBuffers([createZip({ "transfers.txt": "from_stop_id,to_stop_id,transfer_type\na,b,\n" })], ["f"]),
    /transfer_type/i,
  );
  const explicitZero = new GTFS({ filesToLoad: ["transfers.txt"] });
  await explicitZero.loadFromBuffers([createZip({ "transfers.txt": "from_stop_id,to_stop_id,transfer_type\na,b,0\n" })], ["f"]);
  assert.equal(explicitZero.getTransfers()[0].transfer_type, 0);
  const maxValid = new GTFS({ filesToLoad: ["transfers.txt"] });
  await maxValid.loadFromBuffers([createZip({ "transfers.txt": "from_stop_id,to_stop_id,transfer_type\na,b,5\n" })], ["f"]);
  assert.equal(maxValid.getTransfers()[0].transfer_type, 5);
}

// (2) GTFS-RT alert cause/effect explicitly present as 0 must be rejected
function testAlertCauseEffectZeroRejected() {
  assert.throws(() => new GTFS().updateRealtime({
    kind: "alerts", data: makeAlertFeedWithCauseEffect("c0", 0, 1),
    targetFeedId: "f", sourceId: "s",
  }), /parse|cause/i);
  assert.throws(() => new GTFS().updateRealtime({
    kind: "alerts", data: makeAlertFeedWithCauseEffect("e0", 1, 0),
    targetFeedId: "f", sourceId: "s",
  }), /parse|effect/i);
  // absent remains null
  const absent = new GTFS();
  absent.updateRealtime({ kind: "alerts", data: makeAlertFeedWithCauseEffect("absent", null, null), targetFeedId: "f", sourceId: "s" });
  const [alert] = absent.getRealtimeAlerts();
  assert.equal(alert.cause, null);
  assert.equal(alert.effect, null);
  // valid ranges: cause 1..12, effect 1..11
  for (const cause of [1, 12]) {
    const g = new GTFS();
    g.updateRealtime({ kind: "alerts", data: makeAlertFeedWithCauseEffect(`c${cause}`, cause, 1), targetFeedId: "f", sourceId: "s" });
    assert.equal(g.getRealtimeAlerts()[0].cause, cause);
  }
  for (const effect of [1, 11]) {
    const g = new GTFS();
    g.updateRealtime({ kind: "alerts", data: makeAlertFeedWithCauseEffect(`e${effect}`, 1, effect), targetFeedId: "f", sourceId: "s" });
    assert.equal(g.getRealtimeAlerts()[0].effect, effect);
  }
  assert.throws(() => new GTFS().updateRealtime({
    kind: "alerts", data: makeAlertFeedWithCauseEffect("c13", 13, 1),
    targetFeedId: "f", sourceId: "s",
  }), /parse|cause/i);
  assert.throws(() => new GTFS().updateRealtime({
    kind: "alerts", data: makeAlertFeedWithCauseEffect("e12", 1, 12),
    targetFeedId: "f", sourceId: "s",
  }), /parse|effect/i);
}

// (3) stops.txt tts_stop_name is parsed and preserved
async function testTtsStopName() {
  const g = new GTFS({ filesToLoad: ["stops.txt"] });
  await g.loadFromBuffers([createZip({
    "stops.txt": "stop_id,stop_name,tts_stop_name\ns1,Main St,Main Street spoken\ns2,Other,\n",
  })], ["f"]);
  const byId = new Map(g.getStops().map((s) => [s.stop_id, s]));
  assert.equal(byId.get("s1")!.tts_stop_name, "Main Street spoken");
  assert.equal(byId.get("s2")!.tts_stop_name, null);
}

// (4) feed_info with both dates and start>end must fail atomically
async function testFeedInfoDatesAtomic() {
  const g = new GTFS({ filesToLoad: ["feed_info.txt"] });
  await g.loadFromBuffers([createZip({
    "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nA,https://a.invalid,en,20260101,20261231\n",
  })], ["good"]);
  assert.equal(g.getFeedInfo().length, 1);
  await assert.rejects(g.loadFromBuffers([createZip({
    "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nB,https://b.invalid,en,20261231,20260101\n",
  })], ["bad"]), /feed_start_date|feed_end_date|start.*end|end.*start/i);
  // atomic: previous snapshot survives, bad row not published
  assert.equal(g.getFeedInfo().length, 1);
  assert.equal(g.getFeedInfo()[0].feed_publisher_name, "A");
  // single-date and equal-date rows remain valid
  const single = new GTFS({ filesToLoad: ["feed_info.txt"] });
  await single.loadFromBuffers([createZip({
    "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date\nA,https://a.invalid,en,20260101\n",
  })], ["f"]);
  assert.equal(single.getFeedInfo()[0].feed_start_date, "20260101");
  const equal = new GTFS({ filesToLoad: ["feed_info.txt"] });
  await equal.loadFromBuffers([createZip({
    "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nA,https://a.invalid,en,20260101,20260101\n",
  })], ["f"]);
  assert.equal(equal.getFeedInfo()[0].feed_end_date, "20260101");
}

await testTransfersRequiresType();
console.log("PASS transfers transfer_type required");
testAlertCauseEffectZeroRejected();
console.log("PASS alert cause/effect 0 rejected");
await testTtsStopName();
console.log("PASS tts_stop_name preserved");
await testFeedInfoDatesAtomic();
console.log("PASS feed_info dates atomic");
console.log("All P1 validated checks passed.");
