// bff/design-rag/synth/prng.ts — one seeded source of randomness for the whole
// synth pipeline, so a (seed) fully determines a dataset (reproducible corpus).
import { randomLcg } from "d3-random";

export class Rng {
  /** d3-compatible source in [0,1) — pass to d3-random's `.source()`. */
  readonly source: () => number;

  constructor(seed: number) {
    // Normalize any integer seed into the [0,1) the LCG expects.
    const norm = ((Math.abs(Math.floor(seed)) % 2147483647) + 1) / 2147483648;
    this.source = randomLcg(norm);
  }

  float(min = 0, max = 1): number { return min + (max - min) * this.source(); }
  int(min: number, max: number): number { return Math.floor(this.float(min, max + 1)); } // inclusive
  bool(p = 0.5): boolean { return this.source() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.source() * arr.length)]; }

  weightedPick<T>(arr: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.source() * total;
    for (let i = 0; i < arr.length; i++) { r -= weights[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  }

  shuffle<T>(arr: readonly T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.source() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  sample<T>(arr: readonly T[], n: number): T[] { return this.shuffle(arr).slice(0, Math.min(n, arr.length)); }
}

/** Zipf-ish weights (rank^-s): a few dominant, a long tail. s≈1 is the classic 80/20. */
export function zipfWeights(n: number, s = 1): number[] {
  return Array.from({ length: n }, (_, i) => 1 / Math.pow(i + 1, s));
}
