/** Simulated DE2 counter output for demos and tests (no hardware). */

/**
 * Heralded single-photon source: SPDC pairs, idler → detector A (herald),
 * signal → 50/50 beamsplitter → detectors B and C. Accidentals use a 1.3 ns
 * window (the value measured on the real board's A/B/AB data).
 */
export class Simulator {
  private readonly pairs = 60_000; // pairs/s at the crystal
  private readonly etaA = 0.2;
  private readonly etaB = 0.08;
  private readonly etaC = 0.08;
  private readonly dark = 300; // /s per detector
  private readonly dt = 1.3e-9;
  private t = 0;

  next(T: number): number[] {
    this.t += T;
    // slow drift so the strip chart is not flat
    const p = this.pairs * (1 + 0.05 * Math.sin(this.t / 8));
    const rA = p * this.etaA + this.dark;
    const rB = p * 0.5 * this.etaB + this.dark;
    const rC = p * 0.5 * this.etaC + this.dark;
    const rAB = p * this.etaA * 0.5 * this.etaB + rA * rB * this.dt;
    const rAC = p * this.etaA * 0.5 * this.etaC + rA * rC * this.dt;
    const rBC = rB * rC * this.dt; // single photons: no true B·C
    const rABC = (rAB * rC + rAC * rB) * this.dt;
    return [rA, rB, rC, 0, rAB, rAC, rBC, rABC].map((r) => poisson(r * T));
  }
}

function poisson(mean: number): number {
  if (mean <= 0) return 0;
  if (mean > 50) {
    // normal approximation
    const u = 1 - Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(0, Math.round(mean + Math.sqrt(mean) * z));
  }
  const L = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}
