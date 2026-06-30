// bff/design-rag/synth/timeseries.ts — temporal structure.
// value(t) = trend(t) [+/*] seasonality(t) [+] noise(t), the canonical synthetic
// time-series decomposition. Each piece is a knob; together they make charts that
// look real (and, varied across knobs, look different from each other).
import { randomNormal } from "d3-random";
import type { Rng } from "./prng";

export type TrendShape = "flat" | "linear-up" | "linear-down" | "exponential" | "inverted-v" | "piecewise";
export type Seasonality = "none" | "weekly" | "monthly" | "yearly" | "multi";
export type NoiseLevel = "low" | "medium" | "high";
export type Amplitude = "low" | "medium" | "high";

export interface TsOptions {
  points: number;
  base: number;                 // starting magnitude
  trendShape: TrendShape;
  seasonality: Seasonality;
  amplitude?: Amplitude;        // seasonal strength
  noiseLevel: NoiseLevel;
  outliers?: "none" | "few";
  mode?: "additive" | "multiplicative";
  nonNegative?: boolean;        // clamp at 0 (money/counts)
}

const NOISE_SD: Record<NoiseLevel, number> = { low: 0.03, medium: 0.08, high: 0.18 };
const AMP: Record<Amplitude, number> = { low: 0.05, medium: 0.15, high: 0.30 };
const PERIOD: Record<Exclude<Seasonality, "none" | "multi">, number> = { weekly: 7, monthly: 30, yearly: 365 };

function trendAt(shape: TrendShape, x: number, regime: number): number {
  // x in [0,1]; returns a multiplier on base.
  switch (shape) {
    case "flat": return 1;
    case "linear-up": return 1 + 0.9 * x;
    case "linear-down": return 1 - 0.5 * x;
    case "exponential": return 1 + 1.6 * (Math.exp(2 * x) - 1) / (Math.exp(2) - 1);
    case "inverted-v": return 1 + 1.1 * (1 - Math.abs(2 * x - 1));
    case "piecewise": return x < regime ? 1 + 0.3 * x : 1.2 + 1.1 * (x - regime);
  }
}

function seasonalAt(kind: Seasonality, i: number, points: number, amp: number): number {
  if (kind === "none") return 0;
  const yearly = Math.sin((2 * Math.PI * i) / Math.max(2, points));
  if (kind === "multi") return amp * (Math.sin((2 * Math.PI * i) / 7) + 0.6 * yearly);
  const p = kind === "yearly" ? Math.max(2, points) : PERIOD[kind];
  return amp * Math.sin((2 * Math.PI * i) / p);
}

export function timeSeries(rng: Rng, o: TsOptions): number[] {
  const mode = o.mode ?? "multiplicative";
  const amp = AMP[o.amplitude ?? "medium"];
  const noise = randomNormal.source(rng.source)(0, NOISE_SD[o.noiseLevel]);
  const regime = rng.float(0.35, 0.65);
  const out: number[] = [];
  for (let i = 0; i < o.points; i++) {
    const x = o.points <= 1 ? 0 : i / (o.points - 1);
    const trend = o.base * trendAt(o.trendShape, x, regime);
    const season = seasonalAt(o.seasonality, i, o.points, amp); // fraction of base
    const n = noise();                                          // fraction
    let v = mode === "additive"
      ? trend + season * o.base + n * o.base
      : trend * (1 + season) * (1 + n);
    if (o.outliers === "few" && rng.float() < 1.5 / o.points) v *= rng.float(1.4, 2.0);
    if (o.nonNegative !== false) v = Math.max(0, v);
    out.push(v);
  }
  return out;
}
