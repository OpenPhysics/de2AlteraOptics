/**
 * Serial → browser bridge for the DE2 coincidence counter.
 *
 * Reads the raw byte stream from a serial device (default /dev/ttyUSB0),
 * splits it into packets and pushes them to browsers over Server-Sent Events.
 *
 *   GET /stream      text/event-stream: `packet` and `status` events
 *   GET /api/status  JSON status snapshot
 *
 * Used two ways:
 *   - inside `vite` (dev) via the plugin in vite.config.ts
 *   - standalone: `node server/bridge.ts [--simulate] [--device X]
 *                 [--baud 19200] [--port 8787] [--capture file.bin]`
 *     which also serves the built page from dist/.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BAUD,
  DEFAULT_PACKET_PERIOD_S,
  Packetizer,
  decodePacket,
  encodePacket,
  toHex,
} from '../src/de2/protocol.ts';
import { Simulator } from '../src/de2/simulator.ts';

export interface BridgeOptions {
  device: string;
  baud: number;
  simulate: boolean;
  capture?: string | undefined;
}

export interface BridgeStatus {
  source: 'serial' | 'simulator';
  device: string;
  baud: number;
  open: boolean;
  receiving: boolean;
  packets: number;
  dropped: number;
  lastPacketAt: number | null;
  error: string | null;
}

type Next = () => void;

export interface Bridge {
  handle(req: http.IncomingMessage, res: http.ServerResponse, next: Next): void;
  status(): BridgeStatus;
  close(): void;
}

const RETRY_MS = 2000;
const SILENT_AFTER_MS = 1500;

export function createBridge(opts: BridgeOptions): Bridge {
  const clients = new Set<http.ServerResponse>();
  const packetizer = new Packetizer();
  const capture = opts.capture ? fs.createWriteStream(opts.capture) : null;
  let open = false;
  let error: string | null = null;
  let lastPacketAt: number | null = null;
  let stream: fs.ReadStream | null = null;
  let retry: NodeJS.Timeout | null = null;
  let closed = false;

  const status = (): BridgeStatus => ({
    source: opts.simulate ? 'simulator' : 'serial',
    device: opts.simulate ? 'simulated DE2' : opts.device,
    baud: opts.baud,
    open,
    receiving:
      lastPacketAt !== null && Date.now() - lastPacketAt < SILENT_AFTER_MS,
    packets: packetizer.accepted,
    dropped: packetizer.dropped,
    lastPacketAt,
    error,
  });

  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };

  const onBytes = (chunk: Uint8Array) => {
    capture?.write(chunk);
    for (const pkt of packetizer.push(chunk)) {
      lastPacketAt = Date.now();
      send('packet', {
        t: lastPacketAt,
        c: decodePacket(pkt),
        hex: toHex(pkt),
      });
    }
  };

  // --- serial source -------------------------------------------------------
  const scheduleRetry = () => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = null;
      openSerial();
    }, RETRY_MS);
  };

  const openSerial = () => {
    try {
      execFileSync('stty', [
        '-F',
        opts.device,
        String(opts.baud),
        'raw',
        '-echo',
        'cs8',
        '-cstopb',
        '-parenb',
        '-crtscts',
        '-ixon',
        '-ixoff',
        'clocal',
      ]);
    } catch (e) {
      open = false;
      error = `Cannot configure ${opts.device}: ${firstLine(e)}`;
      scheduleRetry();
      return;
    }
    packetizer.reset();
    stream = fs.createReadStream(opts.device, { highWaterMark: 256 });
    stream.on('open', () => {
      open = true;
      error = null;
      send('status', status());
    });
    stream.on('data', (chunk) => onBytes(chunk as Buffer));
    stream.on('error', (e) => {
      open = false;
      error = `${opts.device}: ${e.message}`;
      send('status', status());
      stream?.destroy();
      stream = null;
      scheduleRetry();
    });
    stream.on('close', () => {
      open = false;
      scheduleRetry();
    });
  };

  // --- simulator -----------------------------------------------------------
  let simTimer: NodeJS.Timeout | null = null;
  const startSimulator = () => {
    open = true;
    const sim = new Simulator();
    simTimer = setInterval(
      () => onBytes(encodePacket(sim.next(DEFAULT_PACKET_PERIOD_S))),
      DEFAULT_PACKET_PERIOD_S * 1000
    );
    // Start mid-packet to exercise resynchronisation, like real hardware.
    onBytes(Uint8Array.of(0x12, 0x34, 0xff));
  };

  if (opts.simulate) startSimulator();
  else openSerial();

  const heartbeat = setInterval(() => send('status', status()), 1000);

  return {
    status,
    handle(req, res, next) {
      const url = (req.url ?? '').split('?')[0];
      if (url === '/stream' || url === '/api/status') {
        if (!allowCors(req, res)) {
          res.writeHead(403).end('Origin not allowed');
          return;
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204).end();
          return;
        }
      }
      if (url === '/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(
          `retry: 2000\nevent: status\ndata: ${JSON.stringify(status())}\n\n`
        );
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status()));
        return;
      }
      next();
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      if (simTimer) clearInterval(simTimer);
      if (retry) clearTimeout(retry);
      stream?.destroy();
      capture?.end();
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

/**
 * Pages hosted elsewhere (GitHub Pages) may read the stream from
 * http://localhost. Only listed origins are allowed; same-origin requests
 * carry no Origin header (or a localhost one) and always pass.
 * Extra origins: DE2_ALLOW_ORIGIN="https://a.example,https://b.example".
 */
const ALLOWED_ORIGINS = new Set([
  'https://openphysics.github.io',
  ...(process.env['DE2_ALLOW_ORIGIN'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
]);

function allowCors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(
    origin
  );
  if (!local && !ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Chrome Private/Local Network Access preflight
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  return true;
}

function firstLine(e: unknown): string {
  const msg =
    e instanceof Error
      ? (e as { stderr?: Buffer }).stderr?.toString() || e.message
      : String(e);
  return msg.trim().split('\n')[0] ?? msg;
}

// --- standalone server -------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export function optionsFromArgs(
  argv: string[]
): BridgeOptions & { port: number } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    device: get('--device') ?? process.env['DE2_DEVICE'] ?? '/dev/ttyUSB0',
    baud: Number(get('--baud') ?? process.env['DE2_BAUD'] ?? DEFAULT_BAUD),
    simulate:
      argv.includes('--simulate') || process.env['DE2_SIMULATE'] === '1',
    capture: get('--capture') ?? process.env['DE2_CAPTURE'],
    port: Number(get('--port') ?? process.env['PORT'] ?? 8787),
  };
}

function serveStatic(root: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = path.normalize(
      path.join(root, url === '/' ? 'index.html' : url)
    );
    if (
      !file.startsWith(root) ||
      !fs.existsSync(file) ||
      fs.statSync(file).isDirectory()
    ) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    });
    fs.createReadStream(file).pipe(res);
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const opts = optionsFromArgs(process.argv.slice(2));
  const bridge = createBridge(opts);
  const dist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../dist'
  );
  const staticHandler = serveStatic(dist);
  http
    .createServer((req, res) =>
      bridge.handle(req, res, () => staticHandler(req, res))
    )
    .listen(opts.port, 'localhost', () => {
      const s = bridge.status();
      console.log(`DE2 bridge: ${s.source} ${s.device} @ ${s.baud} baud`);
      console.log(`Open http://localhost:${opts.port}/ in Chrome/Edge/Firefox`);
      console.log(
        `Or use https://openphysics.github.io/de2AlteraOptics/ with source "Local bridge"`
      );
    });
  const stop = () => {
    bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
