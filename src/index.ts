/**
 * nblib — the NIIMBOT printer protocol, as spoken by the B1.
 *
 * This entry point is pure: no DOM, no Node APIs, no dependencies. It runs
 * anywhere JavaScript does. The Web Bluetooth transport lives behind
 * `nblib/web-bluetooth` so importing the protocol never drags browser types in.
 */

export {
	HEAD,
	TAIL,
	Cmd,
	Resp,
	REPLIES,
	LabelType,
	ConnectResult,
	PRINT_ERRORS,
	PrintError,
	describePrintError,
	describeHeartbeat,
	checksum,
	encodePacket,
	parsePackets,
	parsePrintStatus,
	parseHeartbeat,
	parseRfidInfo,
	hexToBytes,
	toHex,
	u16,
	readU16,
	type Packet,
	type PrintStatus,
	type Heartbeat,
	type RfidInfo,
	type LabelTypeValue
} from './protocol.js';

export {
	buildPage,
	countPixels,
	indexPixels,
	B1_PRINTHEAD_PIXELS,
	B1_DPMM,
	type Page,
	type PageAlign,
	type PageOptions,
	type PrintDirection,
	type RasterRow
} from './encode.js';

export { THRESHOLD, lumaOverWhite, imageDataToRows, type PixelSource } from './raster.js';

export {
	exchange,
	handshake,
	printJob,
	cancelPrint,
	readHeartbeat,
	readPrintStatus,
	readModelId,
	readRfidInfo,
	DEFAULT_PACKET_TIMEOUT_MS,
	type Link,
	type PrintJobOptions
} from './transport.js';
