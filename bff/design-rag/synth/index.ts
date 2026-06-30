// bff/design-rag/synth/index.ts — public surface of the synth core.
export { Rng, zipfWeights } from "./prng";
export { sampler, draw, betaFromMean, type DistKind, type DistSpec } from "./distributions";
export { timeSeries, type TrendShape, type Seasonality, type NoiseLevel, type Amplitude, type TsOptions } from "./timeseries";
export { ARCHETYPES, ARCHETYPE_IDS, type Archetype, type MetricDef, type BreakdownDef, type ScaleHint } from "./archetypes";
export { sampleKnobs, cardinalityCount, type Knobs } from "./knobs";
export { generateDataset, type SynthDataset, type SynthColumn } from "./generate";

import { generateDataset } from "./generate";
/** Convenience: a fully-sampled dataset from a seed (optionally pin the archetype). */
export function synthDataset(seed: number, archetype?: string) {
  return generateDataset(seed, archetype ? { archetype } : undefined);
}
