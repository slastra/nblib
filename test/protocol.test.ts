import { describe, expect, test } from 'bun:test';
import {
	Cmd,
	REPLIES,
	LabelType,
	PrintError,
	Resp,
	checksum,
	describeHeartbeat,
	describePrintError,
	encodePacket,
	hexToBytes,
	parseHeartbeat,
	parsePackets,
	parsePrintStatus,
	readU16,
	toHex,
	u16
} from '../src/protocol.js';

/**
 * Command bytes taken verbatim from niimbluelib's PacketGenerator — the
 * reference implementation standing in for a hardware capture. Regenerate
 * against it if these ever need to change; never paste in what this code
 * currently emits.
 */
const REFERENCE: [string, Uint8Array, string][] = [
	['connect', encodePacket(Cmd.Connect, [1]), '035555c10101c1aaaa'],
	['density 3', encodePacket(Cmd.SetDensity, [3]), '555521010323aaaa'],
	['density 5', encodePacket(Cmd.SetDensity, [5]), '555521010525aaaa'],
	['label type gaps', encodePacket(Cmd.SetLabelType, [LabelType.WithGaps]), '555523010123aaaa'],
	['label type black', encodePacket(Cmd.SetLabelType, [LabelType.Black]), '555523010220aaaa'],
	[
		'print start, 1 page',
		encodePacket(Cmd.PrintStart, [...u16(1), 0, 0, 0, 0, 0]),
		'555501070001000000000007aaaa'
	],
	[
		'print start, 500 pages',
		encodePacket(Cmd.PrintStart, [...u16(500), 0, 0, 0, 0, 0]),
		'5555010701f40000000000f3aaaa'
	],
	['page start', encodePacket(Cmd.PageStart, [1]), '555503010103aaaa'],
	[
		'page size 240 rows × 384 cols',
		encodePacket(Cmd.SetPageSize, [...u16(240), ...u16(384), ...u16(1)]),
		'5555130600f00180000165aaaa'
	],
	[
		'page size 1600 rows × 96 cols, 3 copies',
		encodePacket(Cmd.SetPageSize, [...u16(1600), ...u16(96), ...u16(3)]),
		'5555130606400060000330aaaa'
	],
	['page end', encodePacket(Cmd.PageEnd, [1]), '5555e30101e3aaaa'],
	['print end', encodePacket(Cmd.PrintEnd, [1]), '5555f30101f3aaaa'],
	['print status', encodePacket(Cmd.PrintStatus, [1]), '5555a30101a3aaaa'],
	['heartbeat', encodePacket(Cmd.Heartbeat, [1]), '5555dc0101dcaaaa'],
	['model id', encodePacket(Cmd.PrinterInfo, [8]), '555540010849aaaa'],
	['cancel print', encodePacket(Cmd.CancelPrint, [1]), '5555da0101daaaaa']
];

describe('packet framing matches the reference', () => {
	for (const [name, got, want] of REFERENCE) {
		test(name, () => expect(toHex(got)).toBe(want));
	}

	test('Connect, and only Connect, carries the 0x03 prefix', () => {
		expect(encodePacket(Cmd.Connect, [1])[0]).toBe(0x03);
		expect(encodePacket(Cmd.PageStart, [1])[0]).toBe(0x55);
	});

	test('refuses data the single length byte cannot describe', () => {
		expect(() => encodePacket(Cmd.PrintBitmapRow, new Uint8Array(256))).toThrow(/max 255/);
		expect(() => encodePacket(Cmd.PrintBitmapRow, new Uint8Array(255))).not.toThrow();
	});

	test('checksum is an xor over the command, the length and the data', () => {
		expect(checksum(Cmd.SetDensity, [3])).toBe(0x21 ^ 0x01 ^ 0x03);
	});
});

describe('integers are big-endian', () => {
	test('u16 puts the high byte first', () => {
		expect(u16(0x01f4)).toEqual([0x01, 0xf4]);
		expect(readU16(Uint8Array.from([0x01, 0xf4]))).toBe(500);
	});
});

describe('parsePackets', () => {
	const a = encodePacket(Cmd.PageStart, [1]);
	const b = encodePacket(Cmd.PrintStatus, [1]);
	const join = (...parts: Uint8Array[]) => {
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let o = 0;
		for (const p of parts) {
			out.set(p, o);
			o += p.length;
		}
		return out;
	};

	test('reads several packets out of one buffer', () => {
		const { packets, rest } = parsePackets(join(a, b));
		expect(packets.map((p) => p.cmd)).toEqual([Cmd.PageStart, Cmd.PrintStatus]);
		expect(rest.length).toBe(0);
	});

	test('holds a straddling packet back as rest', () => {
		// what a 20-byte BLE notification does to a reply that spans two of them
		const buf = join(a, b);
		const first = parsePackets(buf.slice(0, a.length + 4));
		expect(first.packets.map((p) => p.cmd)).toEqual([Cmd.PageStart]);
		expect(first.rest.length).toBe(4);
		const second = parsePackets(join(first.rest, buf.slice(a.length + 4)));
		expect(second.packets.map((p) => p.cmd)).toEqual([Cmd.PrintStatus]);
		expect(second.rest.length).toBe(0);
	});

	test('resynchronises past leading garbage', () => {
		const { packets } = parsePackets(join(hexToBytes('00ff55aa13'), a));
		expect(packets.map((p) => p.cmd)).toEqual([Cmd.PageStart]);
	});

	test('drops a packet whose checksum is wrong', () => {
		const bad = Uint8Array.from(a);
		bad[bad.length - 3] ^= 0xff;
		expect(parsePackets(bad).packets).toEqual([]);
	});

	test('drops a packet whose tail is wrong', () => {
		const bad = Uint8Array.from(a);
		bad[bad.length - 1] = 0x00;
		expect(parsePackets(bad).packets).toEqual([]);
	});
});

describe('print status', () => {
	test('reads the page counter and both progress bytes', () => {
		expect(parsePrintStatus(hexToBytes('0002 64 32'.replace(/ /g, '')))).toEqual({
			page: 2,
			pagePrintProgress: 100,
			pageFeedProgress: 50
		});
	});

	test('raises the error the ten-byte form carries', () => {
		// page 1, progress 100/0, then the long form's error flag: 2 = no paper
		const data = hexToBytes('00016400' + '0000' + '02' + '000000');
		expect(() => parsePrintStatus(data)).toThrow(PrintError);
		expect(() => parsePrintStatus(data)).toThrow(/out of paper/);
	});

	test('refuses a reply too short to mean anything', () => {
		expect(() => parsePrintStatus(hexToBytes('0001'))).toThrow(/expected 4/);
	});
});

describe('heartbeat', () => {
	test('reads the B1 thirteen-byte form from the tail', () => {
		// nine bytes of preamble, then lid, charge, paper, rfid
		const data = hexToBytes('000000000000000000' + '00' + '04' + '00' + '01');
		expect(parseHeartbeat(data)).toEqual({
			lidClosed: true,
			chargeLevel: 4,
			paperInserted: true,
			paperRfidSuccess: true
		});
	});

	test('both booleans are inverted on the wire', () => {
		const data = hexToBytes('000000000000000000' + '01' + '02' + '01' + '00');
		expect(parseHeartbeat(data)).toEqual({
			lidClosed: false,
			chargeLevel: 2,
			paperInserted: false,
			paperRfidSuccess: false
		});
	});

	test('rejects a length it does not recognise', () => {
		expect(() => parseHeartbeat(hexToBytes('0000'))).toThrow(/heartbeat length 2/);
	});

	test('describes what would stop a job, and nothing else', () => {
		expect(describeHeartbeat({ lidClosed: true, paperInserted: true })).toBe('ready');
		expect(describeHeartbeat({ lidClosed: false, paperInserted: true })).toBe('cover open');
		expect(describeHeartbeat({ lidClosed: false, paperInserted: false })).toBe(
			'cover open, out of paper'
		);
		// a printer that reports neither field is not thereby broken
		expect(describeHeartbeat({ chargeLevel: 3 })).toBe('ready');
	});
});

describe('error codes', () => {
	test('names the ones a job actually hits', () => {
		expect(describePrintError(1)).toBe('cover open');
		expect(describePrintError(2)).toBe('out of paper');
		expect(describePrintError(7)).toBe('overheated');
	});

	test('keeps an unknown code legible', () => {
		expect(describePrintError(0x99)).toBe('unknown error 0x99');
	});
});

describe('response ids', () => {
	test('every request we send has a reply mapped, or is marked one-way', () => {
		for (const cmd of Object.values(Cmd)) {
			expect(Object.prototype.hasOwnProperty.call(REPLIES, cmd)).toBe(true);
		}
	});

	test('the three raster commands are the one-way ones', () => {
		expect(REPLIES[Cmd.PrintBitmapRow]).toBeNull();
		expect(REPLIES[Cmd.PrintBitmapRowIndexed]).toBeNull();
		expect(REPLIES[Cmd.PrintEmptyRow]).toBeNull();
		expect(REPLIES[Cmd.PageStart]).toEqual([Resp.PageStart]);
	});
});
