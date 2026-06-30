// bff/design-rag/synth/knobs.ts — the diversity engine. A dataset is one sampled
// point in this space; sampling is seeded so a (seed) reproduces a dataset.
import { Rng } from "./prng";
import { ARCHETYPE_IDS } from "./archetypes";
import type { TrendShape, Seasonality, NoiseLevel, Amplitude } from "./timeseries";

export type Density = "narrow" | "medium" | "wide";
export type Cardinality = "small" | "medium" | "large";
export type Grain = "daily" | "weekly" | "monthly" | "quarterly" | "snapshot";
export type Scale = "small" | "medium" | "large";
export type CategoryFrequency = "uniform" | "zipf";
export type DeltaDirection = "up" | "down" | "mixed";
export type Missingness = "none" | "sparse";

export interface Knobs {
  archetype: string;
  density: Density;
  breakdownCardinality: Cardinality;
  secondaryDimensions: number;        // 0..2
  grain: Grain;
  points: number;
  trendShape: TrendShape;
  seasonality: Seasonality;
  amplitude: Amplitude;
  noiseLevel: NoiseLevel;
  outliers: "none" | "few";
  scale: Scale;
  categoryFrequency: CategoryFrequency;
  deltaDirection: DeltaDirection;
  missingness: Missingness;
}

// deltaDirection is the high-level intent; it constrains which trend shapes realize it.
const TREND_BY_DELTA: Record<DeltaDirection, TrendShape[]> = {
  up: ["linear-up", "exponential"],
  down: ["linear-down"],
  mixed: ["flat", "inverted-v", "piecewise"],
};

// Valid point counts per grain (so a chart's x-axis is sensible).
const POINTS_BY_GRAIN: Record<Grain, number[]> = {
  daily: [7, 14, 30, 90],
  weekly: [8, 12, 26],
  monthly: [12, 24],
  quarterly: [4, 8],
  snapshot: [1],
};

const CARD_RANGE: Record<Cardinality, [number, number]> = { small: [3, 5], medium: [6, 10], large: [15, 30] };

export function cardinalityCount(c: Cardinality, rng: Rng): number {
  const [lo, hi] = CARD_RANGE[c];
  return rng.int(lo, hi);
}

/** Sample a full knob configuration from a seed. */
export function sampleKnobs(seed: number, archetype?: string): Knobs {
  const rng = new Rng(seed);
  const grain = rng.pick<Grain>(["daily", "weekly", "monthly", "quarterly", "snapshot"]);
  const delta = rng.pick<DeltaDirection>(["up", "down", "mixed"]);
  return {
    archetype: archetype ?? rng.pick(ARCHETYPE_IDS),
    density: rng.pick<Density>(["narrow", "medium", "wide"]),
    breakdownCardinality: rng.pick<Cardinality>(["small", "medium", "large"]),
    secondaryDimensions: rng.int(0, 2),
    grain,
    points: rng.pick(POINTS_BY_GRAIN[grain]),
    trendShape: rng.pick(TREND_BY_DELTA[delta]),
    seasonality: grain === "snapshot" ? "none" : rng.pick<Seasonality>(["none", "weekly", "monthly", "yearly", "multi"]),
    amplitude: rng.pick<Amplitude>(["low", "medium", "high"]),
    noiseLevel: rng.pick<NoiseLevel>(["low", "medium", "high"]),
    outliers: rng.pick(["none", "few"]),
    scale: rng.pick<Scale>(["small", "medium", "large"]),
    categoryFrequency: rng.pick<CategoryFrequency>(["uniform", "zipf"]),
    deltaDirection: delta,
    missingness: rng.pick<Missingness>(["none", "sparse"]),
  };
}
