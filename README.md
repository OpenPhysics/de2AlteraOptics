# de2AlteraOptics

Web interface for a DE2 (Altera Cyclone II) FPGA coincidence counter, as used in
undergraduate quantum-optics labs (Galvez / Beck style): singles **A**, **B**,
coincidences **AB**, and, behind a toggle, a third detector **C** with **AC**,
**BC**, **ABC** and the heralded **g⁽²⁾(0)**.

Packet format: [docs/protocol.md](docs/protocol.md).

## How it works

```
DE2 RS-232 ──► PL2303 USB adapter ──usbipd──► WSL /dev/ttyUSB0
                                              │ server/bridge.ts (Node)
                                              ▼  Server-Sent Events
                                    browser http://localhost:5173
```

The bridge runs inside Node (no native modules) and streams decoded packets to
the page, so any browser works. The adapter is passed to WSL because Prolific's
Windows 11 driver refuses PL2303TA chips; Linux's `pl2303` driver supports them.

## Setup (once per Windows boot / replug)

Admin PowerShell, first time only:

```powershell
usbipd bind --busid 2-4        # 067b:2303 Prolific adapter; check `usbipd list`
```

Each time the adapter is replugged or WSL restarts:

```powershell
usbipd attach --wsl --busid 2-4
```

## Run

```bash
npm install
npm run dev          # real board on /dev/ttyUSB0  → http://localhost:5173
npm run dev:sim      # simulated heralded single-photon source (no hardware)
npm start            # build + standalone server on http://localhost:8787
```

Options (flags for `node server/bridge.ts`, or env vars for `npm run dev`):
`--device` / `DE2_DEVICE`, `--baud` / `DE2_BAUD`, `--simulate` / `DE2_SIMULATE=1`,
`--capture file.bin` / `DE2_CAPTURE` (save the raw byte stream), `--port` / `PORT`.

## The page

- **Integration time** 0.1–60 s (multiples of the 100 ms FPGA gate).
- Rates with Poisson errors, counts N in the window.
- **Accidentals** R₁R₂Δt, net rate and coincidence-to-accidental ratio for each
  coincidence. **Calibrate Δt** sets Δt = R_AB/(R_A R_B) from the last window.
  Use it only with no true pairs, e.g. a long cable delay in one arm.
- **Third detector** toggle: C, AC, BC, ABC and g⁽²⁾(0) = N_A N_ABC / (N_AB N_AC).
- Strip charts, **Record** → **Download CSV** (mapped and raw counters).
- **Raw counters & channel mapping**: live values of all 8 counters and an
  editable counter → channel map (saved in the browser).

## Checks

```bash
npm run lint && npm run check && npm test && npm run build
```
