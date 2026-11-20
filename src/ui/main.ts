import {
  CHANNELS,
  type Channel,
  type ChannelMap,
  DEFAULT_CHANNEL_MAP,
  THREE_DETECTOR_EXTRA,
  TWO_DETECTOR,
  isCoincidence,
  mapCounts,
} from '../de2/channels.ts';
import {
  COUNTERS_PER_PACKET,
  DEFAULT_PACKET_PERIOD_S,
} from '../de2/protocol.ts';
import {
  type Block,
  BlockIntegrator,
  accidentalRate,
  calibrateWindowNs,
  heraldedG2,
  rate,
} from '../de2/stats.ts';
import { type Series, StripChart, formatNumber } from './chart.ts';

// --- settings (persisted per browser) ---------------------------------------

interface Settings {
  packetsPerBlock: number;
  windowNs: number;
  three: boolean;
  map: ChannelMap;
}

const STORAGE_KEY = 'de2-optics.settings';
const DEFAULTS: Settings = {
  packetsPerBlock: 10,
  windowNs: 1.3,
  three: false,
  map: { ...DEFAULT_CHANNEL_MAP },
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      return { ...DEFAULTS, ...s, map: { ...DEFAULTS.map, ...s.map } };
    }
  } catch {
    /* storage unavailable */
  }
  return structuredClone(DEFAULTS);
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

const settings = loadSettings();

// --- DOM helpers ---------------------------------------------------------------

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const color = (ch: Channel) => `var(--c-${ch})`;
const cssColor = (ch: Channel) =>
  getComputedStyle(document.documentElement)
    .getPropertyValue(`--c-${ch}`)
    .trim();

// --- cards --------------------------------------------------------------------

interface Card {
  root: HTMLElement;
  value: HTMLElement;
  sigma: HTMLElement;
  detail: HTMLElement;
}

const cards = new Map<string, Card>();

function makeCard(title: string, swatch: string): Card {
  const root = el('article', 'card');
  const head = el('header');
  const dot = el('span', 'dot');
  dot.style.background = swatch;
  head.append(dot, el('h3', '', title));
  const value = el('div', 'value', '—');
  const sigma = el('div', 'sigma', '');
  const detail = el('div', 'detail', '');
  root.append(head, value, sigma, detail);
  return { root, value, sigma, detail };
}

function buildCards(): void {
  const singles = $('singles');
  const coinc = $('coinc');
  for (const ch of CHANNELS) {
    if (ch === 'D') continue;
    const card = makeCard(ch, color(ch));
    cards.set(ch, card);
    (isCoincidence(ch) ? coinc : singles).append(card.root);
  }
  const g2 = makeCard('g⁽²⁾(0), heralded by A', 'var(--muted)');
  g2.root.classList.add('wide');
  cards.set('g2', g2);
  coinc.append(g2.root);
  applyVisibility();
}

function visibleChannels(): Channel[] {
  return settings.three
    ? [...TWO_DETECTOR, ...THREE_DETECTOR_EXTRA]
    : [...TWO_DETECTOR];
}

function applyVisibility(): void {
  const vis = new Set<string>(visibleChannels());
  if (settings.three) vis.add('g2');
  for (const [key, card] of cards) card.root.hidden = !vis.has(key);
  singlesChart.series = seriesFor(
    ['A', 'B', 'C'].filter((c) => vis.has(c)) as Channel[],
    false
  );
  coincChart.series = [
    ...seriesFor(
      ['AB', 'AC', 'BC', 'ABC'].filter((c) => vis.has(c)) as Channel[],
      false
    ),
    ...seriesFor(['AB', 'AC'].filter((c) => vis.has(c)) as Channel[], true),
  ];
  renderLegend($('legend-singles'), singlesChart.series);
  renderLegend($('legend-coinc'), coincChart.series);
  singlesChart.draw();
  coincChart.draw();
}

function seriesFor(chs: Channel[], acc: boolean): Series[] {
  return chs.map((ch) => {
    const s: Series = {
      key: acc ? `${ch}_acc` : ch,
      label: acc ? `${ch} accidentals` : ch,
      color: cssColor(ch),
    };
    if (acc) s.dashed = true;
    return s;
  });
}

function renderLegend(host: HTMLElement, series: Series[]): void {
  host.replaceChildren(
    ...series.map((s) => {
      const item = el('span', 'item');
      const sw = el('span', s.dashed ? 'swatch dashed' : 'swatch');
      sw.style.borderColor = s.color;
      item.append(sw, document.createTextNode(s.label));
      return item;
    })
  );
}

// --- analysis of one block ----------------------------------------------------

interface Analysis {
  T: number;
  n: Record<Channel, number>;
  r: Record<Channel, number>;
  acc: Partial<Record<Channel, number>>;
}

function analyse(block: Block): Analysis {
  const T = block.packets * DEFAULT_PACKET_PERIOD_S;
  const n = mapCounts(block.sums, settings.map);
  const r = {} as Record<Channel, number>;
  for (const ch of CHANNELS) r[ch] = rate(n[ch], T).value;
  const dt = settings.windowNs;
  const acc: Partial<Record<Channel, number>> = {
    AB: accidentalRate(r.A, r.B, dt),
    AC: accidentalRate(r.A, r.C, dt),
    BC: accidentalRate(r.B, r.C, dt),
    // dominant accidental triples: a true double plus a random third
    ABC: (r.AB * r.C + r.AC * r.B + r.BC * r.A) * dt * 1e-9,
  };
  return { T, n, r, acc };
}

let last: Analysis | null = null;

function renderCards(a: Analysis): void {
  for (const ch of CHANNELS) {
    const card = cards.get(ch);
    if (!card) continue;
    const { value, sigma } = rate(a.n[ch], a.T);
    card.value.textContent = `${formatNumber(value)} /s`;
    card.sigma.textContent = `± ${formatNumber(sigma)} /s · N = ${a.n[ch].toLocaleString()} in ${a.T.toFixed(1)} s`;
    const acc = a.acc[ch];
    if (acc !== undefined) {
      const net = value - acc;
      const car = acc > 0 ? value / acc : Number.NaN;
      card.detail.textContent = `accidentals ${formatNumber(acc)} /s · net ${formatNumber(net)} /s · CAR ${formatNumber(car)}`;
    }
  }
  const g2 = cards.get('g2');
  if (g2) {
    const g = heraldedG2(a.n.A, a.n.AB, a.n.AC, a.n.ABC);
    g2.value.textContent = Number.isFinite(g.value) ? g.value.toFixed(3) : '—';
    g2.sigma.textContent = Number.isFinite(g.sigma)
      ? `± ${g.sigma.toFixed(3)}  (N_A·N_ABC / N_AB·N_AC)`
      : 'needs AB and AC coincidences';
    g2.detail.textContent =
      'Classical light ≥ 1; a single photon gives < 1. Integrate longer for a small error.';
  }
}

// --- raw table ----------------------------------------------------------------

const rawCells: {
  value: HTMLElement;
  rate: HTMLElement;
  select: HTMLSelectElement;
}[] = [];

function buildRawTable(): void {
  const body = $('raw-rows');
  for (let i = 0; i < COUNTERS_PER_PACKET; i++) {
    const tr = document.createElement('tr');
    const value = el('td', 'num', '—');
    const rateCell = el('td', 'num', '—');
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Channel for counter ${i}`);
    select.append(new Option('(unused)', ''));
    for (const ch of CHANNELS) select.append(new Option(ch, ch));
    select.addEventListener('change', () => {
      const ch = select.value as Channel | '';
      // one channel per counter: unmap whatever was here, then move ch here
      for (const c of CHANNELS) {
        if (settings.map[c] === i && c !== ch) settings.map[c] = -1;
      }
      if (ch) settings.map[ch] = i;
      saveSettings();
      syncRawSelects();
    });
    const sel = document.createElement('td');
    sel.append(select);
    tr.append(el('td', 'num', String(i)), value, rateCell, sel);
    body.append(tr);
    rawCells.push({ value, rate: rateCell, select });
  }
  syncRawSelects();
}

function syncRawSelects(): void {
  rawCells.forEach((cell, i) => {
    const ch = CHANNELS.find((c) => settings.map[c] === i);
    cell.select.value = ch ?? '';
  });
}

// --- recording ----------------------------------------------------------------

interface Row {
  iso: string;
  elapsed: number;
  T: number;
  windowNs: number;
  mapped: Record<Channel, number>;
  raw: number[];
}

let recording = false;
let rows: Row[] = [];
let recordStart = 0;

function toCsv(data: Row[]): string {
  const head = [
    'time_iso',
    'elapsed_s',
    'integration_s',
    'window_ns',
    ...CHANNELS.map((c) => `N_${c}`),
    ...Array.from({ length: COUNTERS_PER_PACKET }, (_, i) => `raw${i}`),
  ];
  const lines = data.map((r) =>
    [
      r.iso,
      r.elapsed.toFixed(2),
      r.T.toFixed(2),
      r.windowNs,
      ...CHANNELS.map((c) => r.mapped[c]),
      ...r.raw,
    ].join(',')
  );
  return `${[head.join(','), ...lines].join('\n')}\n`;
}

function download(): void {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `de2-coincidences-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- wiring -------------------------------------------------------------------

const singlesChart = new StripChart($<HTMLCanvasElement>('chart-singles'), []);
const coincChart = new StripChart($<HTMLCanvasElement>('chart-coinc'), []);
const integrator = new BlockIntegrator(settings.packetsPerBlock);
const t0 = Date.now();
let paused = false;

buildCards();
buildRawTable();

const integration = $<HTMLSelectElement>('integration');
integration.value = String(settings.packetsPerBlock);
integration.addEventListener('change', () => {
  settings.packetsPerBlock = Number(integration.value);
  integrator.packetsPerBlock = settings.packetsPerBlock;
  integrator.reset();
  saveSettings();
});

const windowInput = $<HTMLInputElement>('window');
windowInput.value = String(settings.windowNs);
windowInput.addEventListener('change', () => {
  const v = Number(windowInput.value);
  if (Number.isFinite(v) && v >= 0) {
    settings.windowNs = v;
    saveSettings();
    if (last) renderCards(analyseAgain(last));
  }
});

function analyseAgain(a: Analysis): Analysis {
  // recompute accidentals with the new window from the last block's counts
  const raw = new Array<number>(COUNTERS_PER_PACKET).fill(0);
  for (const ch of CHANNELS) {
    const idx = settings.map[ch];
    if (idx >= 0) raw[idx] = a.n[ch];
  }
  return analyse({
    packets: Math.round(a.T / DEFAULT_PACKET_PERIOD_S),
    sums: raw,
    endedAt: Date.now(),
  });
}

$('calibrate').addEventListener('click', () => {
  if (!last) return;
  const dt = calibrateWindowNs(last.r.A, last.r.B, last.r.AB);
  if (!Number.isFinite(dt)) return;
  settings.windowNs = Number(dt.toFixed(3));
  windowInput.value = String(settings.windowNs);
  saveSettings();
  renderCards(analyseAgain(last));
});

const three = $<HTMLInputElement>('three');
three.checked = settings.three;
three.addEventListener('change', () => {
  settings.three = three.checked;
  saveSettings();
  applyVisibility();
});

const pauseBtn = $<HTMLButtonElement>('pause');
pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  pauseBtn.classList.toggle('active', paused);
  integrator.reset();
});

const recordBtn = $<HTMLButtonElement>('record');
const downloadBtn = $<HTMLButtonElement>('download');
const recInfo = $('rec-info');
recordBtn.addEventListener('click', () => {
  recording = !recording;
  if (recording) {
    rows = [];
    recordStart = Date.now();
  }
  recordBtn.textContent = recording ? 'Stop' : 'Record';
  recordBtn.classList.toggle('rec', recording);
  downloadBtn.disabled = recording || rows.length === 0;
  updateRecInfo();
});
downloadBtn.addEventListener('click', download);

function updateRecInfo(): void {
  recInfo.textContent =
    recording || rows.length
      ? `${recording ? 'Recording' : 'Recorded'}: ${rows.length} rows`
      : '';
}

$('clear').addEventListener('click', () => {
  singlesChart.clear();
  coincChart.clear();
});

$('reset-map').addEventListener('click', () => {
  settings.map = { ...DEFAULT_CHANNEL_MAP };
  saveSettings();
  syncRawSelects();
});

const progress = $('progress');
const hex = $('hex');
const status = $('status');

function onBlock(block: Block): void {
  const a = analyse(block);
  last = a;
  renderCards(a);
  block.sums.forEach((s, i) => {
    const cell = rawCells[i];
    if (cell) cell.rate.textContent = formatNumber(s / a.T);
  });
  const t = (block.endedAt - t0) / 1000;
  const values: Record<string, number> = { ...a.r };
  for (const [ch, v] of Object.entries(a.acc)) values[`${ch}_acc`] = v;
  singlesChart.push({ t, values });
  coincChart.push({ t, values });
  if (recording) {
    rows.push({
      iso: new Date(block.endedAt).toISOString(),
      elapsed: (block.endedAt - recordStart) / 1000,
      T: a.T,
      windowNs: settings.windowNs,
      mapped: a.n,
      raw: block.sums,
    });
    updateRecInfo();
  }
}

interface PacketMsg {
  t: number;
  c: number[];
  hex: string;
}

interface StatusMsg {
  source: string;
  device: string;
  baud: number;
  open: boolean;
  receiving: boolean;
  packets: number;
  dropped: number;
  error: string | null;
}

function setStatus(kind: 'ok' | 'warn' | 'err', text: string): void {
  status.className = `pill ${kind}`;
  status.textContent = text;
}

const es = new EventSource('/stream');
es.addEventListener('packet', (ev) => {
  const p = JSON.parse((ev as MessageEvent<string>).data) as PacketMsg;
  p.c.forEach((v, i) => {
    const cell = rawCells[i];
    if (cell) cell.value.textContent = v.toLocaleString();
  });
  hex.textContent = p.hex;
  if (paused) return;
  const block = integrator.add(p.c, p.t);
  progress.style.width = `${(block ? 1 : integrator.progress) * 100}%`;
  if (block) onBlock(block);
});
es.addEventListener('status', (ev) => {
  const s = JSON.parse((ev as MessageEvent<string>).data) as StatusMsg;
  const where = `${s.device} @ ${s.baud}`;
  const sim = s.source === 'simulator' ? ' (SIMULATED)' : '';
  if (s.error) setStatus('err', s.error);
  else if (!s.open) setStatus('warn', `Opening ${where}…`);
  else if (!s.receiving)
    setStatus('warn', `${where}: port open, no data${sim}`);
  else
    setStatus(
      s.source === 'simulator' ? 'warn' : 'ok',
      `Receiving · ${where}${sim} · ${s.packets} packets${s.dropped ? `, ${s.dropped} bad` : ''}`
    );
});
es.addEventListener('error', () =>
  setStatus('err', 'Bridge offline — is `npm run dev` running?')
);
