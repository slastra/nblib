import { afterEach, describe, expect, test } from 'bun:test';
import { connect, hasBluetooth, isSecureContext, isSupported } from '../src/web-bluetooth.js';
import { Cmd, Resp, encodePacket, parsePackets, toHex } from '../src/protocol.js';

/**
 * A fake GATT stack. The transport is the one part of this library that cannot
 * be checked against the reference encoder, so it gets exercised against a
 * stand-in that records exactly what reached the wire.
 */
function fakeStack({
	name = 'B1-2F4A',
	silent = false,
	notifyChunk = 20,
	knownDevices
}: {
	name?: string;
	silent?: boolean;
	notifyChunk?: number;
	knownDevices?: { name: string }[];
} = {}) {
	const writes: Uint8Array[] = [];
	let notify: ((e: unknown) => void) | null = null;
	let inflow: Uint8Array = new Uint8Array(0);

	/** Deliver bytes the way BLE does: in fixed-size notifications. */
	const emit = (bytes: Uint8Array) => {
		for (let o = 0; o < bytes.length; o += notifyChunk) {
			const part = bytes.slice(o, o + notifyChunk);
			notify?.({ target: { value: new DataView(part.buffer.slice(0)) } });
		}
	};

	const channel = {
		uuid: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
		properties: { notify: true, writeWithoutResponse: true },
		async startNotifications() {},
		addEventListener(_: string, fn: (e: unknown) => void) {
			notify = fn;
		},
		async writeValueWithoutResponse(chunk: Uint8Array) {
			writes.push(new Uint8Array(chunk));
			if (silent) return;
			// reassemble across chunk boundaries, then answer each command
			const merged = new Uint8Array(inflow.length + chunk.length);
			merged.set(inflow);
			merged.set(chunk, inflow.length);
			const { packets, rest } = parsePackets(merged);
			inflow = rest;
			for (const p of packets) {
				if (p.cmd === Cmd.Connect) {
					setTimeout(() => emit(encodePacket(Resp.Connect, [3])), 0);
				}
			}
		}
	};

	const device = {
		name,
		addEventListener() {},
		gatt: {
			connect: async () => ({
				getPrimaryService: async (uuid: string) => {
					if (uuid !== 'e7810a71-73ae-499d-8c15-faa9aef0c3f2') throw new Error('no such service');
					return { getCharacteristics: async () => [channel] };
				},
				disconnect() {}
			}),
			disconnect() {}
		}
	};

	const requested: Record<string, unknown>[] = [];
	(globalThis as Record<string, unknown>).navigator = {
		bluetooth: {
			requestDevice: async (opts: Record<string, unknown>) => {
				requested.push(opts);
				return device;
			},
			...(knownDevices ? { getDevices: async () => knownDevices } : {})
		}
	};
	return { writes, requested, emit, channel };
}

afterEach(() => {
	delete (globalThis as Record<string, unknown>).navigator;
	delete (globalThis as Record<string, unknown>).window;
});

describe('capability checks', () => {
	test('report the two failure modes separately', () => {
		expect(hasBluetooth()).toBe(false);
		(globalThis as Record<string, unknown>).navigator = { bluetooth: {} };
		(globalThis as Record<string, unknown>).window = { isSecureContext: false };
		expect(hasBluetooth()).toBe(true);
		expect(isSecureContext()).toBe(false);
		expect(isSupported()).toBe(false);
		(globalThis as Record<string, unknown>).window = { isSecureContext: true };
		expect(isSupported()).toBe(true);
	});
});

describe('discovery', () => {
	test('NEVER filters on a service uuid', async () => {
		// A service filter makes Chrome push a SetDiscoveryFilter uuid list to
		// BlueZ, which segfaults bluetoothd 5.87 and takes the whole Bluetooth
		// stack down with it. This test is the guard on that, not a style
		// preference — if it ever fails, someone's desktop stops working.
		const stack = fakeStack();
		await connect();
		const opts = stack.requested[0];
		const filters = opts.filters as Record<string, unknown>[];
		expect(filters.every((f) => f.services === undefined)).toBe(true);
		expect(filters).toEqual([{ namePrefix: 'B1' }]);
	});

	test('still declares the service as optional, or the characteristics stay locked', async () => {
		const stack = fakeStack();
		await connect();
		expect(stack.requested[0].optionalServices).toEqual(['e7810a71-73ae-499d-8c15-faa9aef0c3f2']);
	});

	test('reuses an already-permitted printer instead of prompting', async () => {
		const stack = fakeStack({ knownDevices: [{ name: 'B1-2F4A' }] });
		// the known device has no gatt, so connecting fails — but the point is
		// that the chooser was never opened
		await connect().catch(() => undefined);
		expect(stack.requested).toHaveLength(0);
	});

	test('falls back to the chooser when nothing is remembered', async () => {
		const stack = fakeStack({ knownDevices: [{ name: 'D110-9999' }] });
		await connect();
		expect(stack.requested).toHaveLength(1);
	});

	test('honours a different name prefix', async () => {
		const stack = fakeStack({ name: 'D110-1234' });
		await connect({ namePrefix: 'D110' });
		expect(stack.requested[0].filters).toEqual([{ namePrefix: 'D110' }]);
	});
});

describe('the link', () => {
	test('handshakes before returning, so the caller can print immediately', async () => {
		const stack = fakeStack();
		const link = await connect();
		expect(link.deviceName).toBe('B1-2F4A');
		const sent = new Uint8Array(stack.writes.flatMap((w) => [...w]));
		expect(toHex(sent)).toBe(toHex(encodePacket(Cmd.Connect, [1])));
	});

	test('chunks writes to the default ATT MTU', async () => {
		const stack = fakeStack();
		const link = await connect({ paceMs: 0 });
		stack.writes.length = 0;
		await link.send(new Uint8Array(55));
		expect(stack.writes.map((w) => w.length)).toEqual([20, 20, 15]);
	});

	test('reassembles a reply split across notifications', async () => {
		// three bytes per notification: every packet straddles several
		const stack = fakeStack({ notifyChunk: 3 });
		const link = await connect();
		const wait = link.receive([Resp.PrintStatus], 50);
		stack.emit(encodePacket(Resp.PrintStatus, [0, 2, 100, 100]));
		const reply = await wait;
		expect(reply?.cmd).toBe(Resp.PrintStatus);
		expect([...reply!.data]).toEqual([0, 2, 100, 100]);
	});

	test('buffers a reply that arrives before anyone asks for it', async () => {
		const stack = fakeStack();
		const link = await connect();
		stack.emit(encodePacket(Resp.PageEnd, [1]));
		// nothing was waiting at the time, and it is still there now
		expect((await link.receive([Resp.PageEnd], 50))?.cmd).toBe(Resp.PageEnd);
	});

	test('times out rather than hanging when the printer says nothing', async () => {
		fakeStack({ silent: true });
		const link = await connect().catch(() => null);
		// the handshake itself fails on a mute printer, which is the point
		expect(link).toBeNull();
	});
});
