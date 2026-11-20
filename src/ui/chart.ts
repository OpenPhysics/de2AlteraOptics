/** Minimal multi-series strip chart on a canvas (no dependencies). */

export interface Series {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
}

export interface Point {
  t: number; // seconds since start
  values: Record<string, number>;
}

const MAX_POINTS = 600;

export class StripChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private points: Point[] = [];
  series: Series[];

  constructor(canvas: HTMLCanvasElement, series: Series[]) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.series = series;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  push(p: Point): void {
    this.points.push(p);
    if (this.points.length > MAX_POINTS) this.points.shift();
    this.draw();
  }

  clear(): void {
    this.points = [];
    this.draw();
  }

  draw(): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--grid').trim();
    const text = css.getPropertyValue('--muted').trim();
    const pad = { l: 64, r: 12, t: 10, b: 24 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;

    const pts = this.points;
    let yMax = 0;
    for (const p of pts) {
      for (const s of this.series) {
        yMax = Math.max(yMax, p.values[s.key] ?? 0);
      }
    }
    yMax = niceCeil(yMax || 1);
    const t0 = pts[0]?.t ?? 0;
    const t1 = Math.max(pts.at(-1)?.t ?? 1, t0 + 1);
    const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * pw;
    const y = (v: number) => pad.t + ph - (v / yMax) * ph;

    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = text;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = (yMax * i) / 4;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      ctx.fillText(formatNumber(v), pad.l - 6, yy);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(
      `${(t1 - t0).toFixed(0)} s window`,
      pad.l + pw / 2,
      h - pad.b + 6
    );

    if (pts.length < 2) return;
    ctx.lineWidth = 2;
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const v = p.values[s.key];
        if (v === undefined) return;
        if (i === 0) ctx.moveTo(x(p.t), y(v));
        else ctx.lineTo(x(p.t), y(v));
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

function niceCeil(v: number): number {
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= m * exp) return m * exp;
  }
  return 10 * exp;
}

export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)} k`;
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
