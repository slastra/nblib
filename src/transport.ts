import {
	Cmd,
	ConnectResult,
	LabelType,
	PrintError,
	Resp,
	describePrintError,
	encodePacket,
	REPLIES,
	parseHeartbeat,
	parsePrintStatus,
	parseRfidInfo,
	u16,
	type Heartbeat,
	type Packet,
	type PrintStatus,
	type RfidInfo
} from './protocol.js';
import type { Page } from './encode.js';

/**
 * The minimum a transport must provide.
 *
 * Unlike a one-way raster protocol, NIIMBOT is a request/response conversation:
 * almost every command has a specific reply that must land before the next one
 * is sent. So a link has to do more than push bytes — it has to hand back the
 * packets that come the other way, and it must BUFFER them, because a reply
 * can arrive before the caller gets round to asking for it.
 */
export interface Link {
	/** Write bytes, chunking and pacing as the link requires. */
	send(bytes: Uint8Array): Promise<void>;
	/**
	 * Resolve with the first inbound packet whose command is in `cmds`, or null
	 * if none arrives within the timeout. Packets that match nothing are
	 * discarded — the printer emits unsolicited heartbeats and page-index
	 * events that no caller is waiting for.
	 */
	receive(cmds: number[], timeoutMs: number): Promise<Packet | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_PACKET_TIMEOUT_MS = 1000;

/**
 * Send one command and wait for its reply.
 *
 * `In_PrintError` and `In_NotSupported` are watched for alongside the expected
 * reply, because the printer answers a refused command with one of those and
 * nothing else — waiting only for the happy-path id would turn every refusal
 * into a timeout, and lose the reason with it.
 */
export async function exchange(
	link: Link,
	cmd: number,
	data: ArrayLike<number> = [1],
	timeoutMs = DEFAULT_PACKET_TIMEOUT_MS
): Promise<Packet> {
	const expected = REPLIES[cmd];
	// A null entry is a one-way command: nothing ever replies, so waiting for
	// one would hang the job rather than fail it.
	if (!expected) throw new Error(`command 0x${cmd.toString(16)} expects no reply`);
	await link.send(encodePacket(cmd, data));
	const reply = await link.receive([...expected, Resp.PrintError, Resp.NotSupported], timeoutMs);
	if (!reply) throw new Error(`printer did not answer command 0x${cmd.toString(16)}`);
	if (reply.cmd === Resp.PrintError) {
		const code = reply.data[0] ?? 0;
		throw new PrintError(`printer refused: ${describePrintError(code)}`, code);
	}
	if (reply.cmd === Resp.NotSupported) {
		throw new PrintError(`printer does not support command 0x${cmd.toString(16)}`, 0);
	}
	return reply;
}

/**
 * The opening exchange. Nothing else is answered until this lands, so a
 * transport should run it as the last step of connecting.
 *
 * The reply byte distinguishes firmware generations; the B1 answers
 * `ConnectedV3`. It is returned rather than asserted because a printer that
 * connects but reports an unexpected generation is still worth talking to.
 */
export async function handshake(
	link: Link,
	timeoutMs = DEFAULT_PACKET_TIMEOUT_MS
): Promise<number> {
	const reply = await exchange(link, Cmd.Connect, [1], timeoutMs);
	const result = reply.data[0] ?? ConnectResult.Disconnect;
	if (result === ConnectResult.FirmwareErrors) {
		throw new Error('printer reports a firmware error and will not accept a job');
	}
	return result;
}

/** Ask the printer how it is: lid, paper, charge. */
export async function readHeartbeat(
	link: Link,
	timeoutMs = DEFAULT_PACKET_TIMEOUT_MS
): Promise<Heartbeat> {
	// Type 1 is the form every generation answers; the richer type 4 exists but
	// needs the protocol version, which costs another round trip to learn.
	const reply = await exchange(link, Cmd.Heartbeat, [1], timeoutMs);
	return parseHeartbeat(reply.data);
}

export async function readPrintStatus(
	link: Link,
	timeoutMs = DEFAULT_PACKET_TIMEOUT_MS
): Promise<PrintStatus> {
	return parsePrintStatus((await exchange(link, Cmd.PrintStatus, [1], timeoutMs)).data);
}

/** Model id, per niimbluelib's model library. The B1 answers 4096. */
export async function readModelId(
	link: Link,
	timeoutMs = DEFAULT_PACKET_TIMEOUT_MS
): Promise<number> {
	// PrinterInfoType.PrinterModelId = 8
	const reply = await exchange(link, Cmd.PrinterInfo, [8], timeoutMs);
	if (reply.data.length === 1) return reply.data[0] << 8;
	return (reply.data[0] << 8) | reply.data[1];
}

/**
 * Read the RFID tag in the loaded roll, or null when there is none to read.
 *
 * Returns null for both "no tag" answers: the short reply a printer gives for
 * untagged stock, and the explicit not-supported reply from a model with no
 * reader at all. Neither is a fault worth throwing over — the caller asked
 * what is on the roll, and the honest answer is "nothing".
 */
export async function readRfidInfo(
	link: Link,
	timeoutMs = DEFAULT_PACKET_TIMEOUT_MS
): Promise<RfidInfo | null> {
	try {
		return parseRfidInfo((await exchange(link, Cmd.RfidInfo, [1], timeoutMs)).data);
	} catch (err) {
		if (err instanceof PrintError && err.code === 0) return null;
		throw err;
	}
}

export interface PrintJobOptions {
	/** Burn density, 1–5 on the B1. Higher is darker and slower. */
	density?: number;
	/** What the printer should expect between labels. */
	labelType?: number;
	/** Copies of each page. */
	quantity?: number;
	/** Called after each page lands, for progress reporting. */
	onProgress?: (done: number, total: number) => void;
	/** Abort between pages. A job stops cleanly, it does not tear mid-label. */
	signal?: AbortSignal;
	packetTimeoutMs?: number;
	/** A page's rows can take a while to clear; its PageEnd waits longer. */
	pageTimeoutMs?: number;
	statusPollMs?: number;
	/** How long a page may sit at the same progress before the job gives up. */
	statusTimeoutMs?: number;
}

/**
 * Wait until the printer reports `pages` pages finished.
 *
 * The timeout is measured from the last CHANGE in reported progress, not from
 * the start: a fifty-label batch is legitimately slow, but a printer that has
 * stopped moving is stuck, and only the second one should fail.
 */
async function waitForPages(
	link: Link,
	pages: number,
	pollMs: number,
	timeoutMs: number,
	packetTimeoutMs: number
): Promise<void> {
	let lastSeen = '';
	let lastChange = Date.now();
	for (;;) {
		const status = await readPrintStatus(link, packetTimeoutMs);
		if (status.page >= pages) return;
		const seen = `${status.page}/${status.pagePrintProgress}/${status.pageFeedProgress}`;
		if (seen !== lastSeen) {
			lastSeen = seen;
			lastChange = Date.now();
		} else if (Date.now() - lastChange > timeoutMs) {
			throw new Error(`printer stalled at page ${status.page} of ${pages}`);
		}
		await sleep(pollMs);
	}
}

/**
 * Run a print job. Each entry builds one page, lazily, so a thousand-row batch
 * does not rasterize a thousand labels up front.
 *
 * Page i+1 is built while page i is still printing, which hides almost all of
 * the render cost behind the wire time. Returns the number of pages printed,
 * which is less than `builds.length` if the signal aborted.
 *
 * Unlike the reference implementation, this polls for completion after EVERY
 * page rather than once at the end. That costs a few status packets per label
 * and buys two things a batch needs: flow control, so a five-hundred-label run
 * cannot outrun the printer's buffer, and honest progress, so the bar moves as
 * labels appear instead of jumping at the end.
 */
export async function printJob(
	link: Link,
	builds: (() => Promise<Page>)[],
	options: PrintJobOptions = {}
): Promise<number> {
	const {
		density = 3,
		labelType = LabelType.WithGaps,
		quantity = 1,
		onProgress,
		signal,
		packetTimeoutMs = DEFAULT_PACKET_TIMEOUT_MS,
		pageTimeoutMs = 5000,
		statusPollMs = 300,
		statusTimeoutMs = 15000
	} = options;
	if (!builds.length) return 0;

	const total = builds.length * quantity;
	await exchange(link, Cmd.SetDensity, [density], packetTimeoutMs);
	await exchange(link, Cmd.SetLabelType, [labelType], packetTimeoutMs);
	// PrintStart carries the whole job's page count up front; the four zero
	// bytes are reserved, and the last byte selects the ribbon colour.
	await exchange(link, Cmd.PrintStart, [...u16(total), 0, 0, 0, 0, 0], packetTimeoutMs);

	let printed = 0;
	try {
		let next: Promise<Page> | undefined = builds[0]?.();
		for (let i = 0; i < builds.length; i++) {
			if (signal?.aborted) break;
			const page = await next!;
			await exchange(link, Cmd.PageStart, [1], packetTimeoutMs);
			// rows before cols: the page is described down the feed first
			await exchange(
				link,
				Cmd.SetPageSize,
				[...u16(page.rows), ...u16(page.cols), ...u16(quantity)],
				packetTimeoutMs
			);
			// render the next page while this one is on the wire
			next = builds[i + 1]?.();
			// the row packets are one-way; nothing replies, so they go as one burst
			await link.send(page.data);
			await exchange(link, Cmd.PageEnd, [1], pageTimeoutMs);
			printed += quantity;
			await waitForPages(link, printed, statusPollMs, statusTimeoutMs, packetTimeoutMs);
			onProgress?.(printed, total);
		}
	} finally {
		// PrintEnd releases the head whether the job finished, failed or was
		// abandoned. Its own failure must not mask the error that got us here.
		await exchange(link, Cmd.PrintEnd, [1], packetTimeoutMs).catch(() => undefined);
	}
	return printed;
}

/** Stop a job that is already running. Safe to call when none is. */
export async function cancelPrint(
	link: Link,
	timeoutMs = DEFAULT_PACKET_TIMEOUT_MS
): Promise<void> {
	await exchange(link, Cmd.CancelPrint, [1], timeoutMs).catch(() => undefined);
}
