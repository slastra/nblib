import { parsePackets, type Packet } from './protocol.js';
import { handshake, type Link } from './transport.js';

/**
 * The NIIMBOT GATT service. Discovery does NOT filter on it (see `connect`),
 * but it still has to be declared as an optional service or the browser
 * refuses to hand over the characteristics after a name match.
 */
const SERVICE = 'e7810a71-73ae-499d-8c15-faa9aef0c3f2';

export interface ConnectOptions {
	/** Device name prefix to match. B1 units advertise as `B1-…`. */
	namePrefix?: string;
	/** GATT services to request access to, in preference order. */
	services?: string[];
	/** Bytes per GATT write. 20 fits the 23-byte default ATT MTU. */
	chunkSize?: number;
	/** Delay between writes, in ms. */
	paceMs?: number;
	/** Fires if the printer drops the GATT link. */
	onDisconnect?: () => void;
}

/** A connected printer. Extends {@link Link}, so it drives `printJob` directly. */
export interface BluetoothLink extends Link {
	readonly deviceName: string;
	disconnect(): void;
}

/** Whether this browser exposes Web Bluetooth at all (Chromium only). */
export function hasBluetooth(): boolean {
	return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/** Web Bluetooth is unavailable on insecure origins, localhost excepted. */
export function isSecureContext(): boolean {
	return typeof window !== 'undefined' && window.isSecureContext;
}

/**
 * Both conditions the browser must meet. Check the two separately when you
 * want to tell the user WHICH one failed, since the fixes differ: a missing
 * API means the wrong browser, an insecure context means the wrong origin.
 */
export function isSupported(): boolean {
	return hasBluetooth() && isSecureContext();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pick a printer.
 *
 * Discovery matches on device NAME, never on service UUID. This is not a
 * preference: a service-UUID filter makes Chrome push a `SetDiscoveryFilter`
 * UUID list to BlueZ, which segfaults `bluetoothd` 5.87 on desktop Linux and
 * takes the user's whole Bluetooth stack down with it. The service still has
 * to appear under `optionalServices` so its characteristics can be read once
 * the name match has granted the device.
 *
 * `getDevices()` is tried first so an already-permitted printer reconnects
 * with no chooser at all.
 */
async function pickDevice(namePrefix: string, services: string[]): Promise<BluetoothDevice> {
	if (navigator.bluetooth.getDevices) {
		try {
			const known = await navigator.bluetooth.getDevices();
			const hit = known.find((d) => (d.name ?? '').startsWith(namePrefix));
			if (hit) return hit;
		} catch {
			// permissions backend unavailable — fall through to a chooser
		}
	}
	return navigator.bluetooth.requestDevice({
		filters: [{ namePrefix }],
		optionalServices: services
	});
}

/**
 * The printer's channel is one characteristic that both notifies and takes
 * writes without response. Which one that is varies by firmware, so it is
 * found by capability rather than by a hardcoded UUID.
 */
async function findChannel(
	server: BluetoothRemoteGATTServer,
	services: string[]
): Promise<BluetoothRemoteGATTCharacteristic> {
	for (const uuid of services) {
		let service: BluetoothRemoteGATTService;
		try {
			service = await server.getPrimaryService(uuid);
		} catch {
			continue; // this printer does not expose that service
		}
		for (const c of await service.getCharacteristics()) {
			if (c.properties.notify && c.properties.writeWithoutResponse) return c;
		}
	}
	throw new Error('no notify + write characteristic found on the printer');
}

/**
 * Connect to a NIIMBOT printer over Web Bluetooth.
 *
 * Must be called from a user gesture, per the Web Bluetooth spec. Returns once
 * the opening handshake has been answered, so the link is ready to print.
 */
export async function connect(options: ConnectOptions = {}): Promise<BluetoothLink> {
	const {
		namePrefix = 'B1',
		services = [SERVICE],
		chunkSize = 20,
		paceMs = 8,
		onDisconnect
	} = options;

	const device = await pickDevice(namePrefix, services);
	if (!device.gatt) throw new Error('device has no GATT server');
	device.addEventListener('gattserverdisconnected', () => onDisconnect?.());

	const server = await device.gatt.connect();
	const channel = await findChannel(server, services);

	// Inbound bytes arrive in 20-byte notifications that respect no packet
	// boundary, so they are accumulated and drained through the parser; `rest`
	// carries a straddling packet's head across to the next notification.
	// annotated, not inferred: parsePackets returns a slice over ArrayBufferLike,
	// which the narrower inferred type would refuse
	let pending: Uint8Array = new Uint8Array(0);
	let inbox: Packet[] = [];
	let wake: (() => void) | null = null;

	channel.addEventListener('characteristicvaluechanged', (e) => {
		const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
		if (!value) return;
		// copied byte by byte rather than wrapping value.buffer: a DataView can
		// be a window onto a larger buffer, and wrapping it would read whatever
		// sits either side of the notification
		const merged = new Uint8Array(pending.length + value.byteLength);
		merged.set(pending);
		for (let i = 0; i < value.byteLength; i++) merged[pending.length + i] = value.getUint8(i);
		const { packets, rest } = parsePackets(merged);
		pending = rest;
		if (!packets.length) return;
		inbox.push(...packets);
		// a runaway buffer means nobody is reading; keep only recent traffic
		if (inbox.length > 64) inbox = inbox.slice(-64);
		wake?.();
	});
	await channel.startNotifications();

	const link: BluetoothLink = {
		deviceName: device.name ?? 'printer',

		async send(bytes: Uint8Array) {
			for (let o = 0; o < bytes.length; o += chunkSize) {
				await channel.writeValueWithoutResponse(bytes.slice(o, o + chunkSize));
				if (paceMs) await sleep(paceMs);
			}
		},

		receive(cmds: number[], timeoutMs: number): Promise<Packet | null> {
			// Anything already queued ahead of the match is stale by definition —
			// we are waiting on a reply to a command sent after it arrived — so
			// the match and everything before it leave the queue together.
			const take = (): Packet | null => {
				const i = inbox.findIndex((p) => cmds.includes(p.cmd));
				if (i < 0) return null;
				const hit = inbox[i];
				inbox = inbox.slice(i + 1);
				return hit;
			};
			const ready = take();
			if (ready) return Promise.resolve(ready);
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					wake = null;
					resolve(null);
				}, timeoutMs);
				wake = () => {
					const hit = take();
					if (!hit) return;
					clearTimeout(timer);
					wake = null;
					resolve(hit);
				};
			});
		},

		disconnect() {
			server.disconnect();
		}
	};

	await handshake(link);
	return link;
}
