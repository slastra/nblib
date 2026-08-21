// The NIIMBOT wire format, as spoken by the B1. See ACKNOWLEDGEMENTS.md for
// whose reverse-engineering this builds on.
//
//   packet := 55 55 <cmd:u8> <len:u8> <data:len> <xor:u8> aa aa
//   xor    := cmd ^ len ^ data[0] ^ … ^ data[len-1]
//   ints   := BIG-endian, everywhere, unlike most little-endian label protocols
//
// One byte of length means a packet's data can never exceed 255 bytes. That is
// the constraint the whole raster encoding is built around: rows are sent one
// packet each, not as a stream.
//
// Pure and DOM-free on purpose: browsers, Node, Bun and Deno all import this
// unchanged, and it carries no dependencies at all.

export const HEAD = 0x55;
export const TAIL = 0xaa;

/** Commands we send. Only the B1 print path plus what it needs to introspect. */
export const Cmd = {
	/** The one packet that carries a leading 0x03 byte outside the frame. */
	Connect: 0xc1,
	PrinterInfo: 0x40,
	PrinterStatusData: 0xa5,
	Heartbeat: 0xdc,
	SetDensity: 0x21,
	SetLabelType: 0x23,
	PrintStart: 0x01,
	PageStart: 0x03,
	SetPageSize: 0x13,
	/** One-way, no reply: a reply per row would halve throughput. */
	PrintBitmapRow: 0x85,
	/** One-way. Sent instead of PrintBitmapRow when a row has ≤ 6 black dots. */
	PrintBitmapRowIndexed: 0x83,
	/** One-way. A run of blank rows, as a position and a repeat count. */
	PrintEmptyRow: 0x84,
	PageEnd: 0xe3,
	PrintEnd: 0xf3,
	PrintStatus: 0xa3,
	CancelPrint: 0xda
} as const;

/** Commands the printer sends back. */
export const Resp = {
	NotSupported: 0x00,
	Connect: 0xc2,
	PrinterInfoModelId: 0x48,
	PrinterInfoSerial: 0x4b,
	PrinterInfoCharge: 0x4a,
	PrinterInfoSoftwareVersion: 0x49,
	PrinterInfoHardwareVersion: 0x4c,
	PrinterInfoLabelType: 0x43,
	PrinterInfoDensity: 0x41,
	PrinterStatusData: 0xb5,
	HeartbeatAdvanced1: 0xdd,
	HeartbeatBasic: 0xde,
	HeartbeatUnknown: 0xdf,
	HeartbeatAdvanced2: 0xd9,
	SetDensity: 0x31,
	SetLabelType: 0x33,
	PrintStart: 0x02,
	PageStart: 0x04,
	SetPageSize: 0x14,
	PageEnd: 0xe4,
	PrintEnd: 0xf4,
	PrintStatus: 0xb3,
	PrinterPageIndex: 0xe0,
	PrinterCheckLine: 0xd3,
	ResetTimeout: 0xc6,
	CancelPrint: 0xd0,
	/** Data byte is a PRINT_ERRORS code. Can arrive in reply to anything. */
	PrintError: 0xdb
} as const;

/**
 * Which reply each request expects. A command mapped to `null` is one-way:
 * nothing comes back, and waiting for it would stall the job forever.
 */
export const REPLIES: Record<number, number[] | null> = {
	[Cmd.Connect]: [Resp.Connect],
	[Cmd.PrinterInfo]: [
		Resp.PrinterInfoModelId,
		Resp.PrinterInfoSerial,
		Resp.PrinterInfoCharge,
		Resp.PrinterInfoSoftwareVersion,
		Resp.PrinterInfoHardwareVersion,
		Resp.PrinterInfoLabelType,
		Resp.PrinterInfoDensity
	],
	[Cmd.PrinterStatusData]: [Resp.PrinterStatusData],
	[Cmd.Heartbeat]: [
		Resp.HeartbeatBasic,
		Resp.HeartbeatUnknown,
		Resp.HeartbeatAdvanced1,
		Resp.HeartbeatAdvanced2
	],
	[Cmd.SetDensity]: [Resp.SetDensity],
	[Cmd.SetLabelType]: [Resp.SetLabelType],
	[Cmd.PrintStart]: [Resp.PrintStart],
	[Cmd.PageStart]: [Resp.PageStart],
	[Cmd.SetPageSize]: [Resp.SetPageSize],
	[Cmd.PageEnd]: [Resp.PageEnd],
	[Cmd.PrintEnd]: [Resp.PrintEnd],
	[Cmd.PrintStatus]: [Resp.PrintStatus],
	[Cmd.CancelPrint]: [Resp.CancelPrint],
	[Cmd.PrintBitmapRow]: null,
	[Cmd.PrintBitmapRowIndexed]: null,
	[Cmd.PrintEmptyRow]: null
};

/** Stock the printer can be told to expect. The B1 takes three of these. */
export const LabelType = {
	WithGaps: 1,
	Black: 2,
	Continuous: 3,
	Perforated: 4,
	Transparent: 5,
	PvcTag: 6,
	BlackMarkGap: 10,
	HeatShrinkTube: 11
} as const;
export type LabelTypeValue = (typeof LabelType)[keyof typeof LabelType];

/** Reply byte of a Connect exchange. */
export const ConnectResult = {
	Disconnect: 0,
	Connected: 1,
	ConnectedNew: 2,
	ConnectedV3: 3,
	FirmwareErrors: 90
} as const;

/**
 * `In_PrintError` codes. Only a handful can realistically reach a B1 job, but
 * a wrong-but-named code beats a bare number when a print fails on a desk
 * three rooms away.
 */
export const PRINT_ERRORS: Record<number, string> = {
	1: 'cover open',
	2: 'out of paper',
	3: 'low battery',
	4: 'battery fault',
	5: 'cancelled at the printer',
	6: 'data error',
	7: 'overheated',
	8: 'paper feed fault',
	9: 'printer busy',
	10: 'no print head',
	11: 'too cold',
	12: 'print head loose',
	13: 'no ribbon',
	14: 'wrong ribbon',
	15: 'used ribbon',
	16: 'wrong paper',
	17: 'could not set paper type',
	18: 'could not set print mode',
	19: 'could not set density',
	21: 'could not set margin',
	22: 'communication fault',
	23: 'disconnected',
	24: 'bad canvas parameters',
	25: 'bad rotation parameter',
	50: 'illegal page',
	52: 'receive timeout'
};

export function describePrintError(code: number): string {
	return PRINT_ERRORS[code] ?? `unknown error 0x${code.toString(16).padStart(2, '0')}`;
}

/** Thrown when the printer answers with In_PrintError or In_NotSupported. */
export class PrintError extends Error {
	readonly code: number;
	constructor(message: string, code: number) {
		super(message);
		this.name = 'PrintError';
		this.code = code;
	}
}

export interface Packet {
	cmd: number;
	data: Uint8Array;
}

export const toHex = (b: Uint8Array | number[]): string =>
	[...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** Big-endian u16, the only integer width the protocol uses. */
export const u16 = (n: number): [number, number] => [(n >> 8) & 0xff, n & 0xff];

export const readU16 = (b: Uint8Array, i = 0): number => (b[i] << 8) | b[i + 1];

export function checksum(cmd: number, data: ArrayLike<number>): number {
	let x = cmd ^ data.length;
	for (let i = 0; i < data.length; i++) x ^= data[i];
	return x & 0xff;
}

/**
 * Frame one command. Data is capped at 255 bytes by the single length byte —
 * exceeding it would silently truncate and desync the printer's parser, so it
 * throws instead.
 *
 * Connect is the one exception in the whole protocol: it carries a leading
 * 0x03 ahead of the header. Omit it and the printer never answers.
 */
export function encodePacket(cmd: number, data: ArrayLike<number> = [1]): Uint8Array {
	if (data.length > 255) throw new Error(`packet data is ${data.length} bytes, max 255`);
	const prefix = cmd === Cmd.Connect ? 1 : 0;
	const out = new Uint8Array(prefix + 7 + data.length);
	let o = 0;
	if (prefix) out[o++] = 0x03;
	out[o++] = HEAD;
	out[o++] = HEAD;
	out[o++] = cmd;
	out[o++] = data.length;
	out.set(data, o);
	o += data.length;
	out[o++] = checksum(cmd, data);
	out[o++] = TAIL;
	out[o] = TAIL;
	return out;
}

/**
 * Pull whole packets out of a byte stream, returning whatever trailing bytes
 * did not form one yet.
 *
 * BLE notifications arrive in 20-byte chunks that respect no packet boundary,
 * so a reply can straddle two of them and two replies can share one. The
 * caller keeps `rest` and prepends it to the next chunk.
 *
 * Bytes that do not begin a valid packet are skipped one at a time rather than
 * dropped wholesale: resyncing on the next 55 55 recovers the stream after a
 * garbled notification instead of discarding everything behind it.
 */
export function parsePackets(buf: Uint8Array): { packets: Packet[]; rest: Uint8Array } {
	const packets: Packet[] = [];
	let i = 0;
	while (i + 7 <= buf.length) {
		if (buf[i] !== HEAD || buf[i + 1] !== HEAD) {
			i++;
			continue;
		}
		const cmd = buf[i + 2];
		const len = buf[i + 3];
		const end = i + 4 + len + 3; // data, checksum, two tail bytes
		if (end > buf.length) break; // incomplete — wait for more bytes
		const data = buf.slice(i + 4, i + 4 + len);
		const okSum = buf[i + 4 + len] === checksum(cmd, data);
		const okTail = buf[i + 5 + len] === TAIL && buf[i + 6 + len] === TAIL;
		if (!okSum || !okTail) {
			i++;
			continue;
		}
		packets.push({ cmd, data });
		i = end;
	}
	return { packets, rest: buf.slice(i) };
}

export interface PrintStatus {
	/** Pages completed so far, counting from 1. */
	page: number;
	/** 0–100. */
	pagePrintProgress: number;
	/** 0–100. */
	pageFeedProgress: number;
}

/**
 * Decode an In_PrintStatus reply. Length varies by model and firmware — the B1
 * sends 4, others 8 or 10 — so only the leading four bytes are read, plus the
 * error flag the 10-byte form carries.
 */
export function parsePrintStatus(data: Uint8Array): PrintStatus {
	if (data.length < 4) throw new Error(`print status is ${data.length} bytes, expected 4 or more`);
	if (data.length === 10 && data[6] !== 0) {
		throw new PrintError(`print failed: ${describePrintError(data[6])}`, data[6]);
	}
	return { page: readU16(data), pagePrintProgress: data[2], pageFeedProgress: data[3] };
}

export interface Heartbeat {
	lidClosed?: boolean;
	/** 0–4 on the B1. */
	chargeLevel?: number;
	paperInserted?: boolean;
	paperRfidSuccess?: boolean;
}

/**
 * Decode a heartbeat. The payload has no version field: its LENGTH is what
 * says which layout it is, and the fields sit at the END, so they are read
 * back from the tail rather than forward from a fixed offset. The B1 sends the
 * 13-byte form.
 *
 * Both booleans are inverted on the wire — 0 means closed, and 0 means paper
 * present — which is why they read as `=== 0` rather than as truthiness.
 */
export function parseHeartbeat(data: Uint8Array): Heartbeat {
	const n = data.length;
	if (n === 10) {
		// d110 and friends: lid and charge only
		return { lidClosed: data[8] === 0, chargeLevel: data[9] };
	}
	if (n === 13 || n === 19) {
		return {
			lidClosed: data[n - 4] === 0,
			chargeLevel: data[n - 3],
			paperInserted: data[n - 2] === 0,
			paperRfidSuccess: data[n - 1] !== 0
		};
	}
	if (n === 20) {
		return { paperInserted: data[n - 2] === 0, paperRfidSuccess: data[n - 1] !== 0 };
	}
	throw new Error(`unrecognised heartbeat length ${n}`);
}

/**
 * What a heartbeat means for a print job, in the vocabulary the UI uses.
 * Anything that would stop a label mid-run reads as not-ready.
 */
export function describeHeartbeat(hb: Heartbeat): string {
	const faults: string[] = [];
	if (hb.lidClosed === false) faults.push('cover open');
	if (hb.paperInserted === false) faults.push('out of paper');
	return faults.join(', ') || 'ready';
}
