import { Buffer } from "node:buffer";
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
function createZip(files: Record<string, string | Buffer>): Buffer {
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

export { createZip };
export function varint(value: number | bigint): Buffer {
    let n = BigInt(value); if (n < 0n) n = BigInt.asUintN(64, n);
    const bytes: number[] = [];
    do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; bytes.push(b); } while (n);
    return Buffer.from(bytes);
}
export function scalar(field: number, value: number | bigint): Buffer { return Buffer.concat([varint(field * 8), varint(value)]); }
export function message(field: number, value: Buffer | string): Buffer { const b = typeof value === "string" ? Buffer.from(value) : value; return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]); }
export function vehicleFeed(count: number, options: { differential?: boolean; status?: number; vehiclePercentage?: number; carriageStatus?: number; carriagePercentage?: number; offset?: number } = {}): Buffer {
    const header = Buffer.concat([message(1, "2.0"), scalar(2, options.differential ? 1 : 0), scalar(3, 1791028800)]);
    const entities: Buffer[] = [];
    for (let i = 0; i < count; i++) {
        const id = String(i + (options.offset ?? 0));
        const trip = message(1, "trip" + id);
        let vehicle = message(1, trip);
        if (options.status !== undefined) vehicle = Buffer.concat([vehicle, scalar(9, options.status)]);
        if (options.vehiclePercentage !== undefined) vehicle = Buffer.concat([vehicle, scalar(10, options.vehiclePercentage)]);
        if (options.carriageStatus !== undefined || options.carriagePercentage !== undefined) {
            let carriage = scalar(5, 1);
            if (options.carriageStatus !== undefined) carriage = Buffer.concat([carriage, scalar(3, options.carriageStatus)]);
            if (options.carriagePercentage !== undefined) carriage = Buffer.concat([carriage, scalar(4, options.carriagePercentage)]);
            vehicle = Buffer.concat([vehicle, message(11, carriage)]);
        }
        entities.push(message(2, Buffer.concat([message(1, "entity" + id), message(4, vehicle)])));
    }
    return Buffer.concat([message(1, header), ...entities]);
}

export function tripFeed(count: number, stops: number): Buffer {
    const entities: Buffer[] = [];
    for (let i = 0; i < count; i++) {
        const trip = message(1, "trip" + i);
        const stopUpdates: Buffer[] = [];
        for (let j = 0; j < stops; j++) stopUpdates.push(message(2, Buffer.concat([scalar(1, j + 1), message(3, scalar(2, 1791028800 + j * 60)), message(4, "stop" + j)])));
        entities.push(message(2, Buffer.concat([message(1, "tripentity" + i), message(3, Buffer.concat([message(1, trip), ...stopUpdates]))])));
    }
    return Buffer.concat([message(1, message(1, "2.0")), ...entities]);
}
