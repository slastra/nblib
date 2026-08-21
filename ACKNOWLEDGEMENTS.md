# Acknowledgements

## niimbluelib

This library is a **port**, not an independent derivation. The NIIMBOT wire
format was reverse-engineered by [MultiMote](https://github.com/MultiMote) and
contributors, and is published as
[niimbluelib](https://github.com/MultiMote/niimbluelib) (MIT) together with the
[NiimBlue](https://github.com/MultiMote/niimblue) web client and the protocol
notes at [niim-docs.pages.dev](https://niim-docs.pages.dev/).

Everything this library knows about the protocol came from there:

- the packet frame — `55 55 <cmd> <len> <data> <xor> aa aa`, and the leading
  `0x03` that only the Connect packet carries
- the command and response ids, and which requests are one-way
- the B1 print sequence: density, label type, print start, then per page a page
  start, a page size, the raster, a page end, and a status poll
- the row encoding: 8 dots per byte most-significant-bit first, repeat runs,
  blank-row runs, the indexed form for rows of six dots or fewer, and the three
  count bytes that switch between per-chunk and total depending on whether the
  row fits three chunks of the head
- the model metadata that says a B1 is 203 dpi with a 384-dot head

The encoder here was verified **against** niimbluelib rather than merely
informed by it: the eight fixtures in `test/encode.test.ts` and a further 600
randomised rasters were driven through both implementations and compared byte
for byte, across both print directions and four head widths. They match
exactly. A further 120 tall rasters were compared row by row, where the two
deliberately packetise differently (see below).

If you have a NIIMBOT and want a finished application rather than a library,
use NiimBlue. It supports the whole family; this supports one printer.

### Why a port, and not the dependency

nblib exists for reasons that are specific to its consumer, not because
anything is wrong with niimbluelib:

- **Discovery must not filter on a service UUID.** niimbluelib's Web Bluetooth
  client passes `{ services: [...] }` to `requestDevice`. That makes Chrome
  push a `SetDiscoveryFilter` UUID list to BlueZ, which segfaults `bluetoothd`
  5.87 on desktop Linux. This library matches on device name only, and declares
  the service as optional so the characteristics still open.
- **Browser-first packaging.** niimbluelib ships CJS with no ESM build, and its
  barrel pulls `@capacitor/core` and `@capacitor-community/bluetooth-le` into
  any bundle that imports it. This is ESM with no dependencies at all.
- **One printer, verified.** Supporting a single model honestly beats
  advertising seventy-eight that nobody here can test.

### Where the two deliberately differ

- **Long runs are split, not overflowed.** A row packet's repeat count is one
  byte. niimbluelib emits the raw run length, so a blank run longer than 255
  rows wraps. This splits the run across packets instead, which matters for
  continuous stock.
- **No check-line packets.** niimbluelib inserts a check marker every 200 rows
  and, as a side effect, breaks a repeat run at that boundary. The B1 print
  task does not enable check lines, so this library omits them and lets the run
  continue. The rows drawn are identical; only the packet count differs.
- **Status is polled every page, not once per job.** Batch printing needs flow
  control so a five-hundred-label run cannot outrun the printer's buffer, and
  needs progress that moves as labels appear.

## Everything else

The 1-bit threshold and the luma-over-white formula are shared verbatim with
[yplib](https://github.com/slastra/yplib), so a toolchain driving both printers
converts images identically and a design previews once.
