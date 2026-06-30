// bff/design-rag/synth/distributions.ts — distribution layer (numeric shape).
// Thin wrappers over d3-random, all driven by the shared seeded source so output
// is reproducible. Match a metric to the distribution that makes its shape real:
//   money -> lognormal, counts -> poisson, rates -> beta, durations -> exponential.
import {
  randomNormal, randomLogNormal, randomPoisson, randomExponential,
  randomPareto, randomBernoulli, randomBinomial, randomBeta,
} from "d3-random";
import type { Rng } from "./prng";

export type DistKind =
  | "normal" | "lognormal" | "poisson" | "exponential"
  | "pareto" | "bernoulli" | "binomial" | "beta";

export interface DistSpec { kind: DistKind; params: number[] }

/** Build a sampler function for a distribution, bound to the seeded source. */
export function sampler(rng: Rng, spec: DistSpec): () => number {
  const s = rng.source;
  const [a = 0, b = 1] = spec.params;
  switch (spec.kind) {
    case "normal": return randomNormal.source(s)(a, b);
    case "lognormal": return randomLogNormal.source(s)(a, b);
    case "poisson": return randomPoisson.source(s)(a);
    case "exponential": return randomExponential.source(s)(a);
    case "pareto": return randomPareto.source(s)(a);
    case "bernoulli": return randomBernoulli.source(s)(a);
    case "binomial": return (randomBinomial.source(s) as unknown as (n: number, p: number) => () => number)(a, b);
    case "beta": return randomBeta.source(s)(a, b);
  }
}

/** One-shot draw. */
export function draw(rng: Rng, spec: DistSpec): number { return sampler(rng, spec)(); }

/** Beta parameters from a target mean and concentration (handy for rates). */
export function betaFromMean(mean: number, concentration = 40): DistSpec {
  const a = Math.max(0.1, mean * concentration);
  const b = Math.max(0.1, (1 - mean) * concentration);
  return { kind: "beta", params: [a, b] };
}
