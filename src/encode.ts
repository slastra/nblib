import { Cmd, encodePacket, u16 } from './protocol.js';

/** One row of dots, 0 = bare stock, 1 = burn. Length = the row's width. */
export type RasterRow = Uint8Array;

/**
 * Which edge of the design leaves the printer first.
 *
 * This is a property of the LABEL, not of the printer: it says how the stock
 * is oriented on the roll, so it decides which of the design's two dimensions
 * has to fit across the print head.
 *
 *  - `top`  — the design's top edge feeds first. Its WIDTH crosses the head.
 *  - `left` — the design's left edge feeds first, i.e. the raster is rotated
 *             90° clockwise. Its HEIGHT crosses the head.
 *
 * Getting this wrong is not subtle: the label comes out rotated a quarter
 * turn, which only goes unnoticed on square stock.
 */
export type PrintDirection = 'top' | 'left';

/** The B1's head: 384 dots at 203 dpi, which is 48 mm — not the 50 mm stock. */
export const B1_PRINTHEAD_PIXELS = 384;
export const B1_DPMM = 8;

export interface Page {
	/** Dots across the head, padded up to a multiple of 8. */
	cols: number;
	/** Rows along the feed. */
	rows: number;
	/** The row packets, concatenated. All one-way — nothing replies to these. */
	data: Uint8Array;
}

export interface PageOptions {
	direction?: PrintDirection;
	/** Dots across the print head. Decides the row guard and the count split. */
	printheadPixels?: number;
}

/**
 * Rotate a raster 90° clockwise, so the source's left edge becomes the leading
 * edge of the print.
 */
function rotateCW(rows: RasterRow[]): RasterRow[] {
	const h = rows.length;
	const w = h ? rows[0].length : 0;
	const out: RasterRow[] = [];
	for (let y = 0; y < w; y++) {
		const row = new Uint8Array(h);
		for (let x = 0; x < h; x++) row[x] = rows[h - 1 - x][y];
		out.push(row);
	}
	return out;
}

/**
 * Pack a row of dots into bits, most significant bit leftmost, padded out to a
 * whole number of bytes. The pad lands on the RIGHT, so the image stays
 * anchored to the left of the head rather than shifting.
 */
function packRow(row: RasterRow, cols: number): Uint8Array {
	const out = new Uint8Array(cols / 8);
	for (let x = 0; x < row.length; x++) {
		if (row[x]) out[x >> 3] |= 0x80 >> (x & 7);
	}
	return out;
}

export interface PixelCounts {
	total: number;
	parts: [number, number, number];
}

/**
 * The three count bytes every row packet carries.
 *
 * When the row fits in three equal chunks of the head, each byte is that
 * chunk's black-dot count. When it does not, the same three bytes carry the
 * total instead, as `[0, low, high]`. The printer uses these to pace the head
 * current, so getting them wrong shows up as uneven burn, not as an error.
 */
export function countPixels(data: Uint8Array, printheadPixels: number): PixelCounts {
	let total = 0;
	const parts: [number, number, number] = [0, 0, 0];
	const chunkSize = Math.floor(printheadPixels / 8 / 3);
	const split = chunkSize > 0 && data.length <= chunkSize * 3;
	for (let byteN = 0; byteN < data.length; byteN++) {
		const value = data[byteN];
		if (!value) continue;
		const chunk = split ? Math.floor(byteN / chunkSize) : -1;
		for (let bit = 0; bit < 8; bit++) {
			if (value & (1 << bit)) {
				total++;
				if (chunk >= 0 && chunk < 3) parts[chunk]++;
			}
		}
	}
	if (split) return { total, parts };
	return { total, parts: [0, total & 0xff, (total >> 8) & 0xff] };
}

/**
 * Bit positions of the set dots, each as a big-endian u16. Only used for rows
 * with six or fewer dots, where naming the dots is smaller than sending the
 * whole row.
 */
export function indexPixels(data: Uint8Array): number[] {
	const out: number[] = [];
	for (let byteN = 0; byteN < data.length; byteN++) {
		const b = data[byteN];
		if (!b) continue;
		for (let bit = 0; bit < 8; bit++) {
			if (b & (0x80 >> bit)) out.push(...u16(byteN * 8 + bit));
		}
	}
	return out;
}

/** A row packet's repeat count is one byte, so a longer run is split. */
const MAX_REPEAT = 255;

/**
 * Rows with this many dots or fewer are sent as a list of dot positions
 * instead of a bitmap. Above it the bitmap is smaller.
 */
const INDEX_THRESHOLD = 6;

/**
 * Encode a raster into the packets that draw one page.
 *
 * Identical consecutive rows collapse into a single packet with a repeat
 * count, and blank rows become a position-and-count with no data at all —
 * which is what keeps a mostly-empty label from spending 240 packets saying
 * nothing.
 *
 * Check-line packets are deliberately not emitted: the B1's print task does
 * not enable them, and sending them to a printer that is not expecting them
 * draws a reply mid-raster that nothing is waiting for.
 */
export function buildPage(rows: RasterRow[], options: PageOptions = {}): Page {
	const { direction = 'top', printheadPixels = B1_PRINTHEAD_PIXELS } = options;
	if (!rows.length) throw new Error('raster has no rows');
	for (const [i, row] of rows.entries()) {
		if (row.length !== rows[0].length) {
			throw new Error(`raster row ${i} is ${row.length} px, expected ${rows[0].length}`);
		}
	}

	const oriented = direction === 'left' ? rotateCW(rows) : rows;
	const across = oriented[0].length;
	// The head cannot be told to print wider than it is: the printer would read
	// the overhang as the start of the next row and walk the rest of the page
	// out of alignment. Fail here rather than emit that.
	if (across > printheadPixels) {
		throw new Error(
			`raster is ${across} dots across the head, which is ${printheadPixels} dots wide` +
				(direction === 'top' ? ' — try printDirection "left"' : '')
		);
	}
	const cols = Math.ceil(across / 8) * 8;

	const parts: Uint8Array[] = [];
	const emit = (cmd: number, data: number[]) => parts.push(encodePacket(cmd, data));

	/** Flush one run of identical rows, splitting it across the repeat cap. */
	const flush = (start: number, count: number, packed: Uint8Array, blank: boolean) => {
		for (let done = 0; done < count; done += MAX_REPEAT) {
			const pos = start + done;
			const repeat = Math.min(MAX_REPEAT, count - done);
			if (blank) {
				emit(Cmd.PrintEmptyRow, [...u16(pos), repeat]);
				continue;
			}
			const counts = countPixels(packed, printheadPixels);
			if (counts.total <= INDEX_THRESHOLD) {
				emit(Cmd.PrintBitmapRowIndexed, [
					...u16(pos),
					...counts.parts,
					repeat,
					...indexPixels(packed)
				]);
			} else {
				emit(Cmd.PrintBitmapRow, [...u16(pos), ...counts.parts, repeat, ...packed]);
			}
		}
	};

	let runStart = 0;
	let runCount = 0;
	let runPacked: Uint8Array | null = null;
	let runBlank = false;
	const same = (a: Uint8Array, b: Uint8Array) => a.every((v, i) => v === b[i]);

	for (const [y, row] of oriented.entries()) {
		const packed = packRow(row, cols);
		const blank = packed.every((b) => b === 0);
		if (runPacked && blank === runBlank && (blank || same(packed, runPacked))) {
			runCount++;
			continue;
		}
		if (runPacked) flush(runStart, runCount, runPacked, runBlank);
		runStart = y;
		runCount = 1;
		runPacked = packed;
		runBlank = blank;
	}
	if (runPacked) flush(runStart, runCount, runPacked, runBlank);

	const size = parts.reduce((n, p) => n + p.length, 0);
	const data = new Uint8Array(size);
	let o = 0;
	for (const p of parts) {
		data.set(p, o);
		o += p.length;
	}
	return { cols, rows: oriented.length, data };
}
