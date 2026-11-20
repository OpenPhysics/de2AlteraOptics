import { COUNTERS_PER_PACKET } from './protocol.ts';

/** Sum of raw counters over a block of consecutive packets. */
export interface Block {
  packets: number;
  sums: number[];
  /** Wall-clock time (ms since epoch) when the block completed. */
  endedAt: number;
}

/**
 * Integrates packets into fixed-size blocks (integration time =
 * packetsPerBlock x packet period). `add` returns the finished block, if any.
 */
export class BlockIntegrator {
  private sums = new Array<number>(COUNTERS_PER_PACKET).fill(0);
  private n = 0;
  packetsPerBlock: number;

  constructor(packetsPerBlock: number) {
    this.packetsPerBlock = Math.max(1, Math.round(packetsPerBlock));
  }

  add(counts: readonly number[], now = Date.now()): Block | null {
    for (let i = 0; i < COUNTERS_PER_PACKET; i++) {
      this.sums[i] = (this.sums[i] ?? 0) + (counts[i] ?? 0);
    }
    this.n++;
    if (this.n < this.packetsPerBlock) return null;
    const block = { packets: this.n, sums: this.sums, endedAt: now };
    this.reset();
    return block;
  }

  /** Fraction of the current block collected so far (0..1). */
  get progress(): number {
    return this.n / this.packetsPerBlock;
  }

  reset(): void {
    this.sums = new Array<number>(COUNTERS_PER_PACKET).fill(0);
    this.n = 0;
  }
}

export interface Rate {
  /** counts per second */
  value: number;
  /** Poisson standard error, counts per second */
  sigma: number;
}

export function rate(counts: number, seconds: number): Rate {
  if (seconds <= 0) return { value: 0, sigma: 0 };
  return { value: counts / seconds, sigma: Math.sqrt(counts) / seconds };
}

/**
 * Accidental coincidence rate for two uncorrelated streams with a
 * coincidence resolving window `windowNs` (the full width, i.e. 2τ).
 */
export function accidentalRate(r1: number, r2: number, windowNs: number) {
  return r1 * r2 * windowNs * 1e-9;
}

/**
 * Estimate the effective coincidence window from data with no true pairs
 * (e.g. a delay inserted in one arm): Δt = R_AB / (R_A R_B).
 */
export function calibrateWindowNs(rA: number, rB: number, rAB: number) {
  if (rA <= 0 || rB <= 0) return Number.NaN;
  return (rAB / (rA * rB)) * 1e9;
}

/**
 * Heralded second-order correlation with A as the herald and B, C the two
 * outputs of a beamsplitter (Grangier / Galvez):
 *   g2(0) = N_A N_ABC / (N_AB N_AC).
 * Returns value and propagated Poisson uncertainty (N_A error neglected).
 */
export function heraldedG2(nA: number, nAB: number, nAC: number, nABC: number) {
  if (nAB <= 0 || nAC <= 0) return { value: Number.NaN, sigma: Number.NaN };
  const value = (nA * nABC) / (nAB * nAC);
  const rel = Math.sqrt((nABC > 0 ? 1 / nABC : 0) + 1 / nAB + 1 / nAC);
  return { value, sigma: nABC > 0 ? value * rel : nA / (nAB * nAC) };
}
