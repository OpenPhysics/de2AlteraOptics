/**
 * Where the page gets packets from:
 *  - BridgeSource:    Server-Sent Events from server/bridge.ts (same origin
 *                     in dev, or http://localhost:8787 from GitHub Pages)
 *  - WebSerialSource: Chrome/Edge talk to the USB-serial adapter directly
 *  - SimulatorSource: in-browser simulated heralded single-photon source
 */
import {
  DEFAULT_BAUD,
  DEFAULT_PACKET_PERIOD_S,
  Packetizer,
  decodePacket,
  encodePacket,
  toHex,
} from './protocol.ts';
import { Simulator } from './simulator.ts';

export interface PacketMsg {
  t: number;
  c: number[];
  hex: string;
}

export interface StatusMsg {
  source: string;
  device: string;
  baud: number;
  open: boolean;
  receiving: boolean;
  packets: number;
  dropped: number;
  error: string | null;
}

export interface SourceHandlers {
  packet(p: PacketMsg): void;
  status(s: StatusMsg): void;
  /** Unrecoverable/connection-level problem, shown to the user. */
  fail(message: string): void;
}

export interface Source {
  start(h: SourceHandlers): Promise<void>;
  stop(): Promise<void>;
}

const SILENT_AFTER_MS = 1500;

/** Shared packet bookkeeping for sources that decode in the browser. */
class LocalDecoder {
  readonly packetizer = new Packetizer();
  lastPacketAt: number | null = null;
  private readonly h: SourceHandlers;

  constructor(h: SourceHandlers) {
    this.h = h;
  }

  push(bytes: Uint8Array): void {
    for (const pkt of this.packetizer.push(bytes)) {
      this.lastPacketAt = Date.now();
      this.h.packet({
        t: this.lastPacketAt,
        c: decodePacket(pkt),
        hex: toHex(pkt),
      });
    }
  }

  status(
    base: Omit<StatusMsg, 'receiving' | 'packets' | 'dropped'>
  ): StatusMsg {
    return {
      ...base,
      receiving:
        this.lastPacketAt !== null &&
        Date.now() - this.lastPacketAt < SILENT_AFTER_MS,
      packets: this.packetizer.accepted,
      dropped: this.packetizer.dropped,
    };
  }
}

// --- bridge -----------------------------------------------------------------

export class BridgeSource implements Source {
  private es: EventSource | null = null;
  private readonly base: string;

  /** `base` is '' for same origin, or e.g. 'http://localhost:8787'. */
  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
  }

  async start(h: SourceHandlers): Promise<void> {
    const es = new EventSource(`${this.base}/stream`);
    this.es = es;
    es.addEventListener('packet', (ev) =>
      h.packet(JSON.parse((ev as MessageEvent<string>).data) as PacketMsg)
    );
    es.addEventListener('status', (ev) =>
      h.status(JSON.parse((ev as MessageEvent<string>).data) as StatusMsg)
    );
    es.addEventListener('error', () =>
      h.fail(
        `Bridge not reachable at ${this.base || location.origin}. Start it with \`npm run bridge\` (or \`npm run dev\`).`
      )
    );
  }

  async stop(): Promise<void> {
    this.es?.close();
    this.es = null;
  }
}

// --- Web Serial ---------------------------------------------------------------

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export class WebSerialSource implements Source {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private readonly baud: number;

  constructor(baud = DEFAULT_BAUD) {
    this.baud = baud;
  }

  /** Must be called from a user gesture (click): it opens the port picker. */
  async start(h: SourceHandlers): Promise<void> {
    if (!webSerialSupported()) {
      h.fail('Web Serial needs Chrome or Edge on a desktop computer.');
      return;
    }
    const dec = new LocalDecoder(h);
    let open = false;
    let error: string | null = null;
    const report = () =>
      h.status(
        dec.status({
          source: 'webserial',
          device: describe(this.port),
          baud: this.baud,
          open,
          error,
        })
      );
    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({
        baudRate: this.baud,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      h.fail(
        e instanceof DOMException && e.name === 'NotFoundError'
          ? 'No port selected.'
          : `Could not open the serial port: ${msg}. On Windows 11 a PL2303TA adapter is blocked by the Prolific driver; use the local bridge or an FTDI adapter.`
      );
      this.port = null;
      return;
    }
    open = true;
    this.timer = setInterval(report, 1000);
    report();
    void this.readLoop(dec, (msg) => {
      open = false;
      error = msg;
      report();
    });
  }

  private async readLoop(dec: LocalDecoder, onError: (m: string) => void) {
    const port = this.port;
    while (port?.readable && !this.stopping) {
      this.reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) dec.push(value);
        }
      } catch (e) {
        // framing/parity/buffer-overrun errors are recoverable: loop again
        if (
          !this.stopping &&
          !(
            e instanceof DOMException &&
            /Framing|Parity|Overrun|Break/.test(e.name)
          )
        ) {
          onError(
            `Serial read failed: ${e instanceof Error ? e.message : String(e)}`
          );
          break;
        }
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    try {
      await this.reader?.cancel();
      await this.port?.close();
    } catch {
      /* already closed */
    }
    this.port = null;
  }
}

function describe(port: SerialPort | null): string {
  const info = port?.getInfo();
  if (!info?.usbVendorId) return 'USB serial';
  const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(4, '0');
  return `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId)}`;
}

// --- simulator ------------------------------------------------------------------

export class SimulatorSource implements Source {
  private timers: ReturnType<typeof setInterval>[] = [];

  async start(h: SourceHandlers): Promise<void> {
    const dec = new LocalDecoder(h);
    const sim = new Simulator();
    dec.push(Uint8Array.of(0xff)); // sync
    this.timers.push(
      setInterval(
        () => dec.push(encodePacket(sim.next(DEFAULT_PACKET_PERIOD_S))),
        DEFAULT_PACKET_PERIOD_S * 1000
      ),
      setInterval(
        () =>
          h.status(
            dec.status({
              source: 'simulator',
              device: 'simulated DE2',
              baud: DEFAULT_BAUD,
              open: true,
              error: null,
            })
          ),
        1000
      )
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
