import { describe, expect, test } from 'bun:test';
import { buildPage, countPixels, indexPixels, type PrintDirection } from '../src/encode.js';
import { Cmd, parsePackets, readU16, toHex } from '../src/protocol.js';

/**
 * Rasters as rows of 0/1 dots.
 *
 * `fill` is called per dot; anything truthy burns.
 */
const mk = (w: number, h: number, fill: (x: number, y: number) => unknown = () => 0) =>
	Array.from({ length: h }, (_, y) => {
		const r = new Uint8Array(w);
		for (let x = 0; x < w; x++) r[x] = fill(x, y) ? 1 : 0;
		return r;
	});

/**
 * Expected bytes, taken verbatim from niimbluelib's encoder driven over the
 * same rasters — the reference implementation standing in for the hardware
 * captures we cannot take without a logic analyser on the BLE link.
 *
 * These are not our own formatting pinned to itself. Each was produced by
 * `ImageEncoder.encode` + `PacketGenerator.writeImageData`, and every one of
 * them was byte-identical on first run; a further 600 randomised rasters
 * matched too. Regenerate them the same way if the encoder is ever changed on
 * purpose, never by pasting in what this code currently emits.
 */
const REFERENCE: Record<
	string,
	{
		rows: Uint8Array[];
		direction: PrintDirection;
		head: number;
		cols: number;
		count: number;
		data: string;
	}
> = {
	// a blank page collapses to one empty-row run, whatever its height
	blank: {
		rows: mk(384, 8),
		direction: 'top',
		head: 384,
		cols: 384,
		count: 8,
		data: '555584030000088faaaa'
	},
	// solid black: identical rows merge, and the counts split across three chunks
	solid: {
		rows: mk(384, 6, () => 1),
		direction: 'top',
		head: 384,
		cols: 384,
		count: 6,
		data: '55558536000080808006' + 'ff'.repeat(48) + '35aaaa'
	},
	// three dots takes the indexed path, and the dots are named by bit position
	sparse: {
		rows: mk(384, 4, (x, y) => y === 1 && (x === 0 || x === 7 || x === 383)),
		direction: 'top',
		head: 384,
		cols: 384,
		count: 4,
		data: '5555840300000186aaaa5555830c00010200010100000007017ff5aaaa5555840300020287aaaa'
	},
	// seven dots is one over the line, so it falls back to the full bitmap
	seven: {
		rows: mk(384, 3, (x, y) => y === 1 && x < 7),
		direction: 'top',
		head: 384,
		cols: 384,
		count: 3,
		data:
			'5555840300000186aaaa' +
			'55558536000107000001fe' +
			'00'.repeat(47) +
			'4aaaaa' +
			'5555840300020184aaaa'
	},
	// 100 dots wide pads out to 104, with the pad on the right
	stripe: {
		rows: mk(100, 5, (x) => x >= 10 && x < 30),
		direction: 'top',
		head: 384,
		cols: 104,
		count: 5,
		data: '55558513000014000005003ffffc000000000000000000bbaaaa'
	},
	// a row too wide for three chunks carries the total instead of a split
	narrowhead: {
		rows: mk(64, 3, (x, y) => y === 0 && x < 40),
		direction: 'top',
		head: 64,
		cols: 64,
		count: 3,
		data: '5555850e000000280001ffffffffff0000005daaaa5555840300010284aaaa'
	},
	// printDirection "left" rotates the raster a quarter turn clockwise
	rot: {
		rows: mk(48, 96, (x, y) => x === 0 || y === 0),
		direction: 'left',
		head: 384,
		cols: 96,
		count: 48,
		data: '55558512000060000001fffffffffffffffffffffffff6aaaa5555830800010100002f005ffbaaaa'
	},
	rotsparse: {
		rows: mk(24, 40, (x, y) => x === 3 && y === 4),
		direction: 'left',
		head: 384,
		cols: 40,
		count: 24,
		data: '5555840300000384aaaa555583080003010000010023abaaaa5555840300041497aaaa'
	}
};

describe('buildPage matches the reference encoder', () => {
	for (const [name, v] of Object.entries(REFERENCE)) {
		test(name, () => {
			const page = buildPage(v.rows, { direction: v.direction, printheadPixels: v.head });
			expect(page.cols).toBe(v.cols);
			expect(page.rows).toBe(v.count);
			expect(toHex(page.data)).toBe(v.data);
		});
	}
});

/** Expand a page's packets back into the rows they draw. */
function expand(page: { data: Uint8Array; cols: number; rows: number }): Uint8Array[] {
	const out = Array.from({ length: page.rows }, () => new Uint8Array(page.cols));
	const { packets, rest } = parsePackets(page.data);
	expect(rest.length).toBe(0);
	for (const p of packets) {
		const pos = readU16(p.data);
		if (p.cmd === Cmd.PrintEmptyRow) continue; // blank rows are already blank
		const repeat = p.data[5];
		const row = new Uint8Array(page.cols);
		if (p.cmd === Cmd.PrintBitmapRow) {
			const bits = p.data.slice(6);
			for (let x = 0; x < page.cols; x++) if (bits[x >> 3] & (0x80 >> (x & 7))) row[x] = 1;
		} else if (p.cmd === Cmd.PrintBitmapRowIndexed) {
			const idx = p.data.slice(6);
			for (let k = 0; k + 1 < idx.length; k += 2) row[readU16(idx, k)] = 1;
		} else {
			throw new Error(`unexpected packet 0x${p.cmd.toString(16)}`);
		}
		for (let r = 0; r < repeat; r++) if (pos + r < page.rows) out[pos + r] = row.slice();
	}
	return out;
}

describe('the packet stream draws the raster it was given', () => {
	test('round-trips a mixed raster', () => {
		const rows = mk(384, 60, (x, y) => (y % 7 === 0 && x % 3 === 0) || (y > 40 && x < 100));
		const page = buildPage(rows, { printheadPixels: 384 });
		expect(expand(page).map((r) => [...r])).toEqual(rows.map((r) => [...r]));
	});

	test('round-trips a rotated raster', () => {
		const rows = mk(48, 96, (x, y) => x === y % 48);
		const page = buildPage(rows, { direction: 'left', printheadPixels: 384 });
		// rotated 90° clockwise: out[y][x] = src[h-1-x][y]
		const want = Array.from({ length: 48 }, (_, y) =>
			Array.from({ length: 96 }, (_, x) => rows[96 - 1 - x][y])
		);
		expect(expand(page).map((r) => [...r])).toEqual(want);
	});

	test('a run longer than a repeat byte is split, not truncated', () => {
		// 600 blank rows cannot ride in one packet: repeat is a single byte
		const page = buildPage(mk(384, 600), { printheadPixels: 384 });
		const { packets } = parsePackets(page.data);
		expect(packets).toHaveLength(3);
		expect(packets.map((p) => [readU16(p.data), p.data[2]])).toEqual([
			[0, 255],
			[255, 255],
			[510, 90]
		]);
		expect(expand(page).every((r) => r.every((v) => v === 0))).toBe(true);
	});
});

describe('buildPage guards', () => {
	test('refuses a raster wider than the print head', () => {
		// 50 mm of stock is 400 dots, and the B1's head is 384 — the case that
		// sends printrow's default label at this printer
		expect(() => buildPage(mk(400, 240), { printheadPixels: 384 })).toThrow(/384 dots wide/);
	});

	test('names the escape hatch when the design is merely the wrong way round', () => {
		expect(() => buildPage(mk(400, 240), { printheadPixels: 384 })).toThrow(
			/printDirection "left"/
		);
		// …and rotating it does fit, because 240 crosses the head instead
		expect(() =>
			buildPage(mk(400, 240), { direction: 'left', printheadPixels: 384 })
		).not.toThrow();
	});

	test('refuses a ragged raster', () => {
		const rows = [new Uint8Array(384), new Uint8Array(383)];
		expect(() => buildPage(rows, { printheadPixels: 384 })).toThrow(/row 1/);
	});

	test('refuses an empty raster', () => {
		expect(() => buildPage([], { printheadPixels: 384 })).toThrow(/no rows/);
	});
});

describe('pixel counting', () => {
	test('splits across three chunks when the row fits them', () => {
		const data = new Uint8Array(48);
		data[0] = 0b11000000; // chunk 0
		data[20] = 0b10000000; // chunk 1
		data[47] = 0b11100000; // chunk 2
		expect(countPixels(data, 384)).toEqual({ total: 6, parts: [2, 1, 3] });
	});

	test('falls back to a little-endian total when it does not', () => {
		// 8 bytes against a 64-dot head: chunks are 2 bytes, so 3 chunks hold 6
		const data = new Uint8Array(8).fill(0xff);
		expect(countPixels(data, 64)).toEqual({ total: 64, parts: [0, 64, 0] });
	});

	test('indexes dots most significant bit first', () => {
		const data = new Uint8Array([0b10000001, 0x00, 0b00000001]);
		expect(indexPixels(data)).toEqual([0, 0, 0, 7, 0, 23]);
	});
});
