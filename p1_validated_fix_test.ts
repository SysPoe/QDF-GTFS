import assert from "node:assert/strict";
import * as dns from "node:dns";
import { createServer, type Server } from "node:http";
import { existsSync, unlinkSync, statSync } from "node:fs";

// Dedicated P1 validation: IPv4-mapped IPv6 SSRF + bare snapshot filename.
// Uses runtime import so a missing export is a clean FAIL (red) rather than a load error.
const mod = (await import("./index.js")) as any;
const { GTFS } = mod;

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof assert.AssertionError) console.log(e.stack?.split("\n").slice(0, 8).join("\n"));
  }
}

// --- (1) isNonPublicAddress must reject IPv4-mapped IPv6 ---
await check("isNonPublicAddress export exists", () => {
  assert.equal(typeof mod.isNonPublicAddress, "function", "isNonPublicAddress must be exported for validation");
});

await check("mapped loopback ::ffff:127.0.0.1 is non-public", () => {
  assert.equal(mod.isNonPublicAddress("::ffff:127.0.0.1"), true);
});

await check("mapped private ::ffff:10.0.0.1 is non-public", () => {
  assert.equal(mod.isNonPublicAddress("::ffff:10.0.0.1"), true);
});

await check("mapped private ::ffff:192.168.1.1 is non-public", () => {
  assert.equal(mod.isNonPublicAddress("::ffff:192.168.1.1"), true);
});

await check("mapped public ::ffff:8.8.8.8 stays public", () => {
  assert.equal(mod.isNonPublicAddress("::ffff:8.8.8.8"), false);
});

await check("plain public 8.8.8.8 stays public", () => {
  assert.equal(mod.isNonPublicAddress("8.8.8.8"), false);
});

// --- (1b) DNS redirect checks must also reject mapped ---
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return address.port;
}

await check("DNS redirect to ::ffff:127.0.0.1 is refused before request", async () => {
  let targetRequests = 0;
  const target = createServer((_req, res) => {
    targetRequests++;
    res.end("unexpected");
  });
  const targetPort = await listen(target);
  const source = createServer((_req, res) => {
    // Different hostname => redirectHeaders performs dns.lookup on it.
    res.writeHead(302, { location: `http://p1-mapped-redirect.invalid:${targetPort}/feed.zip` });
    res.end();
  });
  const sourcePort = await listen(source);
  const originalLookup = dns.promises.lookup;
  // @ts-expect-error monkey-patch for test
  dns.promises.lookup = async (hostname: string, options: any) => {
    if (hostname === "p1-mapped-redirect.invalid") {
      const result = [{ address: "::ffff:127.0.0.1", family: 6 }];
      return options?.all ? result : result[0];
    }
    return (originalLookup as any)(hostname, options);
  };
  try {
    await assert.rejects(
      new GTFS().loadStatic({
        id: "p1-mapped",
        url: `http://127.0.0.1:${sourcePort}/start`,
        headers: { Authorization: "Bearer test-only" },
      }),
      /non-public address/,
      "redirect whose DNS resolves to ::ffff:127.0.0.1 must be refused",
    );
    assert.equal(targetRequests, 0, "mapped redirect must be rejected before credentials or a request reach it");
  } finally {
    dns.promises.lookup = originalLookup;
    await Promise.all([
      new Promise<void>((resolve, reject) => target.close((e) => (e ? reject(e) : resolve()))),
      new Promise<void>((resolve, reject) => source.close((e) => (e ? reject(e) : resolve()))),
    ]);
  }
});

await check("same-origin redirect keeps auth (auth stripping preserved)", async () => {
  // Same origin (same host:port) must preserve Authorization; proves we did not over-strip.
  let sawAuth: string | undefined;
  let serverPort = 0;
  const server = createServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: `http://127.0.0.1:${serverPort}/feed.zip` });
      res.end();
      return;
    }
    sawAuth = req.headers.authorization as string | undefined;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not-a-zip-but-should-fail-later");
  });
  serverPort = await listen(server);
  try {
    // Load will fail ZIP parse, but only after following the same-origin redirect.
    // We assert on the auth header observed, not on load success.
    await new GTFS().loadStatic({
      id: "p1-auth",
      url: `http://127.0.0.1:${serverPort}/start`,
      headers: { Authorization: "Bearer keep-me" },
    }).catch(() => {});
    assert.equal(sawAuth, "Bearer keep-me", "same-origin redirect must preserve Authorization");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

// --- (2) bare snapshot filename must not create_directories("") ---
await check("saveCompiledSnapshot with bare filename works", async () => {
  const crcTable = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
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

  const bare = "p1_bare_snapshot_test.bin";
  try {
    if (existsSync(bare)) unlinkSync(bare);
  } catch {}
  const gtfs = new GTFS({ filesToLoad: ["stops.txt"] });
  await gtfs.loadFromBuffers([createZip({ "stops.txt": "stop_id,stop_name\ns,Bare\n" })], ["bare"]);
  gtfs.saveCompiledSnapshot(bare);
  assert.ok(existsSync(bare), "bare snapshot file must exist in cwd");
  assert.ok(statSync(bare).size >= 32, "bare snapshot must not be truncated");
  const restored = new GTFS();
  restored.loadCompiledSnapshot(bare);
  assert.equal(restored.getStops()[0]?.stop_name, "Bare");
  try {
    unlinkSync(bare);
  } catch {}
});

if (failures) {
  console.log(`\n${failures} P1 check(s) FAILED`);
  process.exit(1);
} else console.log("\nAll P1 checks passed.");
