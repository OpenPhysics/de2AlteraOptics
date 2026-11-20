import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL_MAP, mapCounts } from '../src/de2/channels.ts';
import {
  BlockIntegrator,
  accidentalRate,
  calibrateWindowNs,
  heraldedG2,
  rate,
} from '../src/de2/stats.ts';

describe('BlockIntegrator', () => {
  it('sums packets into blocks of the requested size', () => {
    const b = new BlockIntegrator(3);
    expect(b.add([1, 2, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(b.progress).toBeCloseTo(1 / 3);
    expect(b.add([1, 2, 0, 0, 0, 0, 0, 0])).toBeNull();
    const block = b.add([1, 2, 0, 0, 1, 0, 0, 0], 42);
    expect(block).toEqual({
      packets: 3,
      sums: [3, 6, 0, 0, 1, 0, 0, 0],
      endedAt: 42,
    });
    expect(b.progress).toBe(0);
  });
});

describe('rates', () => {
  it('gives Poisson uncertainties', () => {
    expect(rate(400, 2)).toEqual({ value: 200, sigma: 10 });
    expect(rate(5, 0)).toEqual({ value: 0, sigma: 0 });
  });

  it('accidentals and window calibration are inverse', () => {
    // values from the real board: A~15 k/s, B~25.6 k/s, AB~0.5 /s
    const dt = calibrateWindowNs(14_974, 25_595, 0.5);
    expect(dt).toBeCloseTo(1.305, 2);
    expect(accidentalRate(14_974, 25_595, dt)).toBeCloseTo(0.5, 6);
  });

  it('heralded g2 is 1 for uncorrelated splitting', () => {
    // N_A=1e5, N_AB=N_AC=1e3, N_ABC=10 -> g2 = 1e5*10/1e6 = 1
    const g = heraldedG2(1e5, 1e3, 1e3, 10);
    expect(g.value).toBeCloseTo(1);
    expect(g.sigma).toBeGreaterThan(0.3);
  });
});

describe('mapCounts', () => {
  it('maps raw counters to channels and treats -1 as unused', () => {
    const raw = [10, 20, 30, 40, 50, 60, 70, 80];
    const m = mapCounts(raw, { ...DEFAULT_CHANNEL_MAP, D: -1 });
    expect(m.A).toBe(10);
    expect(m.AB).toBe(50);
    expect(m.D).toBe(0);
  });
});
