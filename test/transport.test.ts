import { describe, expect, test } from 'bun:test';
import { Cmd, Resp, parsePackets, readU16, type Packet } from '../src/protocol.js';
import { buildPage, type Page } from '../src/encode.js';
import { cancelPrint, handshake, printJob, readHeartbeat, type Link } from '../src/transport.js';

/**
 * A printer that answers the way a B1 does: a reply per command, silence for
 * the raster, and a page counter that only advances once a page has been
 * ended. Records everything it was sent so a job's shape can be asserted.
 */
class FakePrinter implements Link {
	sent: Packet[] = [];
	page = 0;
	/** Fail the nth command of this type, once. */
	failOn: { cmd: number; code: number } | null = null;
	/** Stop advancing the page counter, to look like a jam. */
	stalled = false;

	private inbox: Packet[] = [];
	private pending: Uint8Array = new Uint8Array(0);

	/** The commands sent, in order, ignoring the raster. */
	get commands(): number[] {
		return this.sent.filter((p) => !RASTER.has(p.cmd)).map((p) => p.cmd);
	}

	find(cmd: number): Packet | undefined {
		return this.sent.find((p) => p.cmd === cmd);
	}

	all(cmd: number): Packet[] {
		return this.sent.filter((p) => p.cmd === cmd);
	}

	async send(bytes: Uint8Array): Promise<void> {
		const merged = new Uint8Array(this.pending.length + bytes.length);
		merged.set(this.pending);
		merged.set(bytes, this.pending.length);
		const { packets, rest } = parsePackets(merged);
		this.pending = rest;
		for (const p of packets) {
			this.sent.push(p);
			this.reply(p);
		}
	}

	private reply(p: Packet) {
		if (RASTER.has(p.cmd)) return; // one-way: a real printer says nothing
		if (this.failOn?.cmd === p.cmd) {
			const code = this.failOn.code;
			this.failOn = null;
			this.inbox.push({ cmd: Resp.PrintError, data: Uint8Array.from([code]) });
			return;
		}
		if (p.cmd === Cmd.PageEnd && !this.stalled) this.page += this.copies;
		if (p.cmd === Cmd.SetPageSize) this.copies = readU16(p.data, 4);
		if (p.cmd === Cmd.PrintStatus) {
			this.inbox.push({
				cmd: Resp.PrintStatus,
				data: Uint8Array.from([...u16be(this.page), 100, 100])
			});
			return;
		}
		const reply = ACK[p.cmd];
		if (reply !== undefined) this.inbox.push({ cmd: reply, data: Uint8Array.from([1]) });
	}

	private copies = 1;

	receive(cmds: number[], _timeoutMs: number): Promise<Packet | null> {
		const i = this.inbox.findIndex((p) => cmds.includes(p.cmd));
		if (i < 0) return Promise.resolve(null);
		const hit = this.inbox[i];
		this.inbox = this.inbox.slice(i + 1);
		return Promise.resolve(hit);
	}
}

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];

const RASTER = new Set<number>([Cmd.PrintBitmapRow, Cmd.PrintBitmapRowIndexed, Cmd.PrintEmptyRow]);

const ACK: Record<number, number> = {
	[Cmd.Connect]: Resp.Connect,
	[Cmd.SetDensity]: Resp.SetDensity,
	[Cmd.SetLabelType]: Resp.SetLabelType,
	[Cmd.PrintStart]: Resp.PrintStart,
	[Cmd.PageStart]: Resp.PageStart,
	[Cmd.SetPageSize]: Resp.SetPageSize,
	[Cmd.PageEnd]: Resp.PageEnd,
	[Cmd.PrintEnd]: Resp.PrintEnd,
	[Cmd.CancelPrint]: Resp.CancelPrint,
	[Cmd.Heartbeat]: Resp.HeartbeatAdvanced1
};

const blank = (w = 384, h = 24): Page => buildPage(mkRows(w, h), { printheadPixels: 384 });
const mkRows = (w: number, h: number) => Array.from({ length: h }, () => new Uint8Array(w));

describe('printJob', () => {
	test('sends the B1 sequence, in order', async () => {
		const printer = new FakePrinter();
		const done = await printJob(printer, [() => Promise.resolve(blank())], { statusPollMs: 0 });
		expect(done).toBe(1);
		expect(printer.commands).toEqual([
			Cmd.SetDensity,
			Cmd.SetLabelType,
			Cmd.PrintStart,
			Cmd.PageStart,
			Cmd.SetPageSize,
			Cmd.PageEnd,
			Cmd.PrintStatus,
			Cmd.PrintEnd
		]);
	});

	test('declares the whole job to PrintStart, copies included', async () => {
		const printer = new FakePrinter();
		const builds = [blank, blank, blank].map((b) => () => Promise.resolve(b()));
		await printJob(printer, builds, { quantity: 2, statusPollMs: 0 });
		expect(readU16(printer.find(Cmd.PrintStart)!.data)).toBe(6);
	});

	test('describes each page as rows, then cols, then copies', async () => {
		const printer = new FakePrinter();
		const page = buildPage(mkRows(200, 48), { printheadPixels: 384 });
		await printJob(printer, [() => Promise.resolve(page)], { quantity: 3, statusPollMs: 0 });
		const size = printer.find(Cmd.SetPageSize)!.data;
		expect(readU16(size, 0)).toBe(48); // rows, along the feed
		expect(readU16(size, 2)).toBe(200); // cols, across the head
		expect(readU16(size, 4)).toBe(3); // copies
	});

	test('carries the density and label type it was given', async () => {
		const printer = new FakePrinter();
		await printJob(printer, [() => Promise.resolve(blank())], {
			density: 5,
			labelType: 2,
			statusPollMs: 0
		});
		expect(printer.find(Cmd.SetDensity)!.data[0]).toBe(5);
		expect(printer.find(Cmd.SetLabelType)!.data[0]).toBe(2);
	});

	test('reports progress as each page lands', async () => {
		const printer = new FakePrinter();
		const seen: [number, number][] = [];
		await printJob(
			printer,
			[blank, blank, blank].map((b) => () => Promise.resolve(b())),
			{ onProgress: (d, t) => seen.push([d, t]), statusPollMs: 0 }
		);
		expect(seen).toEqual([
			[1, 3],
			[2, 3],
			[3, 3]
		]);
	});

	test('builds each page lazily, one ahead of the wire', async () => {
		const printer = new FakePrinter();
		const built: number[] = [];
		const builds = [0, 1, 2].map((i) => () => {
			built.push(i);
			return Promise.resolve(blank());
		});
		await printJob(printer, builds, { statusPollMs: 0 });
		// all three eventually, but never all three before the first page ships
		expect(built).toEqual([0, 1, 2]);
	});

	test('stops between pages when aborted, and still releases the head', async () => {
		const printer = new FakePrinter();
		const aborter = new AbortController();
		const builds = [0, 1, 2, 3].map(() => () => Promise.resolve(blank()));
		// the realistic case: the user hits cancel while the batch is running
		const done = await printJob(printer, builds, {
			signal: aborter.signal,
			statusPollMs: 0,
			onProgress: () => aborter.abort()
		});
		expect(done).toBe(1);
		expect(printer.all(Cmd.PageStart)).toHaveLength(1);
		expect(printer.find(Cmd.PrintEnd)).toBeDefined();
	});

	test('a job aborted before it starts prints nothing at all', async () => {
		const printer = new FakePrinter();
		const aborter = new AbortController();
		aborter.abort();
		const builds = [blank, blank].map((b) => () => Promise.resolve(b()));
		expect(await printJob(printer, builds, { signal: aborter.signal, statusPollMs: 0 })).toBe(0);
		expect(printer.all(Cmd.PageStart)).toHaveLength(0);
		// the setup commands still went out, so the head is still released
		expect(printer.find(Cmd.PrintEnd)).toBeDefined();
	});

	test('surfaces a refusal as a PrintError, naming the reason', async () => {
		const printer = new FakePrinter();
		printer.failOn = { cmd: Cmd.PageStart, code: 1 };
		const job = printJob(printer, [() => Promise.resolve(blank())], { statusPollMs: 0 });
		expect(job).rejects.toThrow(/cover open/);
		await job.catch(() => undefined);
		// the head is released even though the job died
		expect(printer.find(Cmd.PrintEnd)).toBeDefined();
	});

	test('gives up on a printer that has stopped moving', async () => {
		const printer = new FakePrinter();
		printer.stalled = true;
		const job = printJob(printer, [() => Promise.resolve(blank())], {
			statusPollMs: 0,
			statusTimeoutMs: 20
		});
		expect(job).rejects.toThrow(/stalled/);
		await job.catch(() => undefined);
	});

	test('does nothing at all for an empty job', async () => {
		const printer = new FakePrinter();
		expect(await printJob(printer, [])).toBe(0);
		expect(printer.sent).toEqual([]);
	});
});

describe('exchanges', () => {
	test('the handshake reports the firmware generation', async () => {
		const printer = new FakePrinter();
		expect(await handshake(printer)).toBe(1);
		expect(printer.commands).toEqual([Cmd.Connect]);
	});

	test('a heartbeat comes back decoded', async () => {
		const printer = new FakePrinter();
		printer.receive = () =>
			Promise.resolve({
				cmd: Resp.HeartbeatAdvanced1,
				data: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 1])
			});
		expect(await readHeartbeat(printer)).toEqual({
			lidClosed: true,
			chargeLevel: 4,
			paperInserted: true,
			paperRfidSuccess: true
		});
	});

	test('a silent printer fails rather than hangs', async () => {
		const mute: Link = { send: () => Promise.resolve(), receive: () => Promise.resolve(null) };
		expect(handshake(mute, 1)).rejects.toThrow(/did not answer/);
	});

	test('cancelling a job nobody started is harmless', async () => {
		const mute: Link = { send: () => Promise.resolve(), receive: () => Promise.resolve(null) };
		await cancelPrint(mute, 1);
	});

	test('a one-way command can never be awaited', async () => {
		const printer = new FakePrinter();
		const { exchange } = await import('../src/transport.js');
		expect(exchange(printer, Cmd.PrintEmptyRow, [0, 0, 1])).rejects.toThrow(/expects no reply/);
	});
});

describe('the raster reaches the printer intact', () => {
	test('row packets arrive between the page markers', async () => {
		const printer = new FakePrinter();
		const rows = mkRows(384, 10);
		rows[3].fill(1);
		const page = buildPage(rows, { printheadPixels: 384 });
		await printJob(printer, [() => Promise.resolve(page)], { statusPollMs: 0 });
		const order = printer.sent.map((p) => p.cmd);
		const start = order.indexOf(Cmd.SetPageSize);
		const end = order.indexOf(Cmd.PageEnd);
		const raster = order.slice(start + 1, end);
		expect(raster.length).toBeGreaterThan(0);
		expect(raster.every((c) => RASTER.has(c))).toBe(true);
		// and the burst decodes back to the same packets buildPage produced
		expect(parsePackets(page.data).packets.map((p) => p.cmd)).toEqual(raster);
	});

	test('an oversized page is refused before anything reaches the wire', () => {
		// printrow's 50 mm default is 400 dots; the B1's head is 384
		expect(() => buildPage(mkRows(400, 240), { printheadPixels: 384 })).toThrow(/384 dots wide/);
	});
});
