import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as dns from 'node:dns';
import { mkdtemp, readFile, writeFile, utimes } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GTFS, parseGtfsRtMultiCarriageDetails } from './index.js';
import { createZip, message, scalar, vehicleFeed, tripFeed } from './audit_fixtures.js';
import { TripScheduleRelationship } from './types.js';

let failures = 0;
async function check(name: string, run: () => Promise<void> | void) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error}`); }
}
async function listen(server: Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
const input = (data: Buffer | Buffer[], sourceId = 'vehicles', targetFeedId = 'feed') =>
    ({ kind: 'vehicles' as const, data, sourceId, targetFeedId });
const good = createZip({ 'stops.txt': 'stop_id,stop_name\ns,Healthy\n' });
const malformedCsv = createZip({ 'stops.txt': 'stop_id,stop_name\ns,\n' });

function tripRelationshipFeed(relationships: number[], vehicles = false): Buffer {
    const timestamp = 1791066800;
    const entities = relationships.map((relationship, i) => {
        const trip = Buffer.concat([
            message(1, `trip${i}`), message(3, '20261003'), scalar(4, relationship), message(5, 'route'),
        ]);
        const stop = Buffer.concat([
            scalar(1, 1), message(3, Buffer.concat([scalar(1, 60), scalar(2, timestamp + 600 + i)])), message(4, 'UN'),
        ]);
        const payload = Buffer.concat([
            message(1, trip), ...(vehicles ? [] : [message(2, stop)]), scalar(vehicles ? 5 : 4, timestamp),
        ]);
        return message(2, Buffer.concat([message(1, `entity${i}`), message(vehicles ? 4 : 3, payload)]));
    });
    return Buffer.concat([message(1, Buffer.concat([message(1, '2.0'), scalar(3, timestamp)])), ...entities]);
}

await check('NEW trip among scheduled Union estimates preserves the entire source and indexes', () => {
    const gtfs = new GTFS();
    const result = gtfs.updateRealtime({ kind: 'trip-updates', data: tripRelationshipFeed([0, 8, 0]), sourceId: 'go-trip-updates', targetFeedId: 'go' });
    const updates = gtfs.getRealtimeTripUpdates({ source_id: 'go-trip-updates', feed_id: 'go' });
    assert.equal(updates.length, 3);
    assert.deepEqual(updates.map(row => row.trip.schedule_relationship), [0, 8, 0]);
    assert.deepEqual(updates.map(row => row.stop_time_updates[0].departure_time), [1791067400, 1791067401, 1791067402]);
    assert.equal(gtfs.getRealtimeTripUpdates({ trip_id: 'trip2' })[0].stop_time_updates[0].stop_id, 'UN');
    assert.deepEqual(new Set(result.changed_trip_ids.map(row => row.trip_id)), new Set(['trip0', 'trip1', 'trip2']));
});
await check('TripDescriptor relationships preserve current GTFS wire values in trips and vehicles', () => {
    assert.equal(TripScheduleRelationship.DUPLICATED, 6);
    assert.equal(TripScheduleRelationship.DELETED, 7);
    assert.equal(TripScheduleRelationship.NEW, 8);
    const relationships = [0, 1, 2, 3, 5, 6, 7, 8];
    for (const vehicles of [false, true]) {
        const gtfs = new GTFS();
        gtfs.updateRealtime({ kind: vehicles ? 'vehicles' : 'trip-updates', data: tripRelationshipFeed(relationships, vehicles), sourceId: 'source', targetFeedId: 'feed' });
        const rows = vehicles ? gtfs.getRealtimeVehiclePositions() : gtfs.getRealtimeTripUpdates();
        assert.deepEqual(rows.map(row => row.trip.schedule_relationship), relationships);
    }
});
await check('reserved and unknown trip relationships reject atomically and retain healthy observations', () => {
    for (const vehicles of [false, true]) {
        const gtfs = new GTFS();
        const source = { kind: vehicles ? 'vehicles' as const : 'trip-updates' as const, sourceId: 'source', targetFeedId: 'feed' };
        gtfs.updateRealtime({ ...source, data: tripRelationshipFeed([0], vehicles) });
        const read = () => vehicles ? gtfs.getRealtimeVehiclePositions() : gtfs.getRealtimeTripUpdates();
        const previous = read();
        const revision = gtfs.getRealtimeRevision();
        for (const relationship of [4, 9]) {
            assert.throws(() => gtfs.updateRealtime({ ...source, data: tripRelationshipFeed([0, relationship], vehicles) }));
            assert.deepEqual(read(), previous);
            assert.equal(gtfs.getRealtimeRevision(), revision);
        }
    }
});

await check('documented occupancy values and unknown carriage percentage survive native replacement', () => {
    for (const options of [
        { status: 7 }, { status: 8 }, { carriageStatus: 7 }, { carriageStatus: 8 },
        { carriagePercentage: -1 }, { vehiclePercentage: 110 }, { carriagePercentage: 110 },
        { vehiclePercentage: 0xffffffff }, { carriagePercentage: 0x7fffffff },
    ]) {
        const gtfs = new GTFS();
        gtfs.updateRealtime(input(vehicleFeed(1)));
        gtfs.updateRealtime(input(vehicleFeed(1, { ...options, offset: 1 })));
        const [vehicle] = gtfs.getRealtimeVehiclePositions();
        assert.equal(vehicle.trip.trip_id, 'trip1');
        if (options.status !== undefined) assert.equal(vehicle.occupancy_status, options.status);
        if (options.vehiclePercentage !== undefined) assert.equal(vehicle.occupancy_percentage, options.vehiclePercentage);
        if (options.carriageStatus !== undefined) assert.equal(vehicle.multi_carriage_details[0].occupancy_status, options.carriageStatus);
        if (options.carriagePercentage !== undefined) assert.equal(vehicle.multi_carriage_details[0].occupancy_percentage, options.carriagePercentage === -1 ? null : options.carriagePercentage);
    }
});
await check('legacy carriage decoder agrees with native signed and extended values', () => {
    const feed = vehicleFeed(1, { carriageStatus: 8, carriagePercentage: -1 });
    assert.deepEqual(parseGtfsRtMultiCarriageDetails(feed).get('entity0'), [
        { id: '', label: '', occupancy_status: 8, occupancy_percentage: null, carriage_sequence: 1 },
    ]);
    assert.equal(parseGtfsRtMultiCarriageDetails(vehicleFeed(1, { carriagePercentage: 110 })).get('entity0')![0].occupancy_percentage, 110);
});
await check('invalid occupancy rejects atomically without losing a healthy source', () => {
    const gtfs = new GTFS();
    gtfs.updateRealtime(input(vehicleFeed(1)));
    const previous = gtfs.getRealtimeVehiclePositions();
    for (const options of [{ status: 9 }, { carriageStatus: 9 }, { carriagePercentage: -2 }]) {
        assert.throws(() => gtfs.updateRealtime(input(vehicleFeed(1, options))));
        assert.deepEqual(gtfs.getRealtimeVehiclePositions(), previous);
    }
});

await check('aggregate deadline destroys chunking downloads and never starts fallbacks or late commits', async () => {
    const sockets = new Set<Socket>();
    let fallbackRequests = 0;
    const server = createServer((req, res) => {
        if (req.url === '/fallback') { fallbackRequests++; res.end(vehicleFeed(1)); return; }
        if (req.url === '/headers') return;
        res.writeHead(200); res.write(Buffer.from([0]));
        const timer = setInterval(() => res.write(Buffer.from([0])), 10);
        res.on('close', () => clearInterval(timer));
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    const url = await listen(server);
    const gtfs = new GTFS({ requestTimeoutMs: 100, realtimeTimeoutMs: 60 });
    gtfs.updateRealtime(input(vehicleFeed(1)));
    const revision = gtfs.getRealtimeRevision();
    try {
        for (let cycle = 0; cycle < 3; cycle++) {
            const sources = Array.from({ length: cycle === 0 ? 8 : 1 }, (_, index) => ({
                id: `vehicles${index}`, kind: 'vehicles' as const, targetFeedId: 'feed',
                url: `${url}/${cycle === 2 ? 'headers' : 'slow'}`, fallbackUrls: [`${url}/fallback`],
            }));
            await assert.rejects(gtfs.updateRealtimeFromUrl(sources), /timed out after 60ms/);
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(sockets.size, 0, 'all unfinished requests must be closed');
        }
        assert.equal(fallbackRequests, 0, 'aborted requests must not retry through fallbacks');
        assert.equal(gtfs.getRealtimeRevision(), revision);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

await check('deadline during redirect DNS validation settles before DNS and opens no late request', async () => {
    const originalLookup = dns.promises.lookup;
    let releaseDns!: () => void;
    const pendingDns = new Promise<void>(resolve => { releaseDns = resolve; });
    let dnsCalls = 0;
    const server = createServer((_req, res) => {
        res.writeHead(302, { location: 'http://qdf-pending-dns.invalid/feed' }); res.end();
    });
    const url = await listen(server);
    // A synthetic public result avoids changing the existing redirect security policy.
    dns.promises.lookup = (async () => {
        dnsCalls++; await pendingDns;
        return [{ address: '8.8.8.8', family: 4 }];
    }) as unknown as typeof dns.promises.lookup;
    let watchdog: NodeJS.Timeout | undefined;
    try {
        const gtfs = new GTFS({ realtimeTimeoutMs: 60 });
        await Promise.race([
            assert.rejects(gtfs.fetchRealtimeSources([{ id: 'redirect', kind: 'vehicles', targetFeedId: 'feed', url }]), /timed out after 60ms/),
            new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('deadline waits for DNS')), 500); }),
        ]);
        assert.equal(dnsCalls, 1);
    } finally {
        if (watchdog) clearTimeout(watchdog);
        releaseDns(); dns.promises.lookup = originalLookup;
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

await check('invalid ZIP and malformed CSV primary recover through a healthy fallback', async () => {
    let goodRequests = 0;
    const server = createServer((req, res) => {
        if (req.url === '/html') res.end('<html>upstream error</html>');
        else if (req.url === '/csv') res.end(malformedCsv);
        else { goodRequests++; res.end(good); }
    });
    const url = await listen(server);
    try {
        for (const primary of ['html', 'csv']) {
            const gtfs = new GTFS({ filesToLoad: ['stops.txt'] });
            const result = await gtfs.loadStatic({ id: 'f', url: `${url}/${primary}`, fallbackUrls: [`${url}/good`] });
            assert.equal(result[0].source, 'network');
            assert.equal(gtfs.getStops()[0].stop_name, 'Healthy');
        }
        assert.equal(goodRequests, 2);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
await check('corrupt fresh cache recovers from origin; invalid origin preserves validated stale cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'qdf-audit-cache-'));
    let requests = 0;
    let body = good;
    const server = createServer((_req, res) => { requests++; res.end(body); });
    const url = await listen(server);
    const cachePath = join(cacheDir, createHash('md5').update(`${url}|{}`).digest('hex'));
    try {
        await writeFile(cachePath, 'truncated nonempty cache');
        const gtfs = new GTFS({ cache: true, cacheDir, filesToLoad: ['stops.txt'] });
        assert.equal((await gtfs.loadStatic({ id: 'f', url }))[0].source, 'network');
        assert.equal(requests, 1);
        assert.deepEqual(await readFile(cachePath), good);
        const past = new Date(Date.now() - 1000);
        await utimes(cachePath, past, past);
        body = Buffer.from('invalid primary');
        const fromStale = new GTFS({ cache: true, cacheDir, cacheMaxAgeMs: 1, filesToLoad: ['stops.txt'] });
        assert.equal((await fromStale.loadStatic({ id: 'f', url }))[0].source, 'stale-cache');
        assert.equal(fromStale.getStops()[0].stop_name, 'Healthy');
        assert.deepEqual(await readFile(cachePath), good);
        const strict = new GTFS({ cache: true, cacheDir, filesToLoad: ['stops.txt'], maxExtractedEntryBytes: 10 });
        await assert.rejects(strict.loadStatic({ id: 'f', url }), /size|limit|exceed/i, 'recovery failure must preserve the original validation diagnostic');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
await check('shared source extraction recovers without publishing partial multi-feed state', async () => {
    const nested = createZip({ 'one.zip': good });
    let healthyRequests = 0;
    // A plain healthy GTFS ZIP does not contain the requested nested archive.
    const server = createServer((req, res) => {
        if (req.url === '/healthy') { healthyRequests++; res.end(nested); }
        else res.end(good);
    });
    const url = await listen(server);
    const gtfs = new GTFS({ filesToLoad: ['stops.txt'] });
    await gtfs.loadFromBuffers([good], ['old']);
    try {
        await gtfs.loadStatic([
            { id: 'new', url: `${url}/bad`, archiveEntry: 'one.zip' },
            { id: 'other', url: `${url}/bad`, archiveEntry: 'one.zip', fallbackUrls: [`${url}/healthy`] },
        ]);
        assert.equal(healthyRequests, 1, 'shared sources should acquire one healthy fallback');
        assert.deepEqual(new Set(gtfs.getStops().map(stop => stop.feed_id)), new Set(['new', 'other']));
        const previous = gtfs.getStops();
        await assert.rejects(gtfs.loadStatic([
            { id: 'new', url: `${url}/bad` },
            { id: 'other', url: `${url}/bad`, archiveEntry: 'missing.zip', fallbackUrls: [`${url}/also-bad`] },
        ]));
        assert.deepEqual(gtfs.getStops(), previous);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

function entity(id: string, trip: string): Buffer { return message(2, Buffer.concat([message(1, id), message(4, message(1, message(1, trip)))])); }
function feed(entities: Buffer[], differential = true): Buffer { return Buffer.concat([message(1, Buffer.concat([message(1, '2.0'), scalar(2, differential ? 1 : 0)])), ...entities]); }
await check('differential replacement deletes and replaces once, preserves source/feed isolation and indexed reads', () => {
    const gtfs = new GTFS();
    gtfs.updateRealtime(input(feed([entity('same', 'old'), entity('delete', 'deleted'), entity('keep', 'kept')], false)));
    gtfs.updateRealtime(input(feed([entity('same', 'other-source')], false), 'other'));
    gtfs.updateRealtime(input(feed([entity('same', 'other-feed')], false), 'vehicles', 'other-feed'));
    gtfs.updateRealtime({ kind: 'trip-updates', data: tripFeed(10, 3), sourceId: 'trips', targetFeedId: 'feed' });
    const unchangedTrips = gtfs.getRealtimeTripUpdates({ source_id: 'trips' });
    const deleted = message(2, Buffer.concat([message(1, 'delete'), scalar(2, 1)]));
    const result = gtfs.updateRealtime(input(feed([deleted, entity('same', 'replacement'), entity('add', 'added')])));
    assert.deepEqual(gtfs.getRealtimeVehiclePositions({ source_id: 'vehicles', feed_id: 'feed' }).map(row => row.trip.trip_id), ['kept', 'replacement', 'added']);
    assert.equal(gtfs.getRealtimeVehiclePositions({ trip_id: 'old' }).length, 0);
    assert.equal(gtfs.getRealtimeVehiclePositions({ trip_id: 'replacement' }).length, 1);
    assert.equal(gtfs.getRealtimeVehiclePositions({ source_id: 'other' })[0].trip.trip_id, 'other-source');
    assert.equal(gtfs.getRealtimeVehiclePositions({ feed_id: 'other-feed' })[0].trip.trip_id, 'other-feed');
    assert.deepEqual(gtfs.getRealtimeTripUpdates({ source_id: 'trips' }), unchangedTrips);
    assert.deepEqual(new Set(result.changed_trip_ids.map(row => row.trip_id)), new Set(['old', 'deleted', 'replacement', 'added']));
    const previous = gtfs.getRealtimeVehiclePositions();
    const revision = gtfs.getRealtimeRevision();
    assert.throws(() => gtfs.updateRealtime(input([feed([entity('dup', 'one')]), feed([entity('dup', 'two')])])), /Duplicate/);
    assert.deepEqual(gtfs.getRealtimeVehiclePositions(), previous);
    assert.equal(gtfs.getRealtimeRevision(), revision);
    assert.throws(() => gtfs.updateRealtime(input([feed([deleted]), feed([deleted])])), /Duplicate/);
    assert.deepEqual(gtfs.getRealtimeVehiclePositions(), previous);
    assert.throws(() => gtfs.updateRealtime(input([feed([entity('one', 'one')]), feed([entity('two', 'two')], false)])), /Mixed/);
    assert.deepEqual(gtfs.getRealtimeVehiclePositions(), previous);
    const unknown = message(2, Buffer.concat([message(1, 'unknown'), scalar(2, 1)]));
    assert.equal(gtfs.updateRealtime(input(feed([unknown]))).realtime_revision, revision);
    gtfs.updateRealtime(input(feed([], false)));
    assert.equal(gtfs.getRealtimeVehiclePositions({ source_id: 'vehicles', feed_id: 'feed' }).length, 0);
    assert.equal(gtfs.getRealtimeVehiclePositions({ source_id: 'other' }).length, 1);
    assert.deepEqual(gtfs.getRealtimeTripUpdates({ source_id: 'trips' }), unchangedTrips);
});

console.log(`QDF audit regressions: ${failures} failed`);
process.exitCode = failures ? 1 : 0;
