// bff/design-rag/synth/generate.ts — the assembler. (seed [+ overrides]) -> a
// reproducible long-format dataset: a primary metric as a per-category time
// series, derived/base metrics per row, optional secondary dimensions. This is
// the unit a generation campaign will feed to the dashboard generator.
import { faker } from "@faker-js/faker";
import { Rng, zipfWeights } from "./prng";
import { sampler } from "./distributions";
import { timeSeries } from "./timeseries";
import { ARCHETYPES, type BreakdownDef, type MetricDef, type ScaleHint } from "./archetypes";
import { sampleKnobs, cardinalityCount, type Knobs, type Grain, type Scale } from "./knobs";

export interface SynthColumn { name: string; type: "date" | "string" | "number" }
export interface SynthDataset {
  tableName: string;
  domain: string;
  columns: SynthColumn[];
  rows: Record<string, string | number | null>[];
  meta: { archetype: string; seed: number; knobs: Knobs };
}

const MAG: Record<"money" | "count", Record<Scale, number>> = {
  money: { small: 800, medium: 30000, large: 1500000 },
  count: { small: 300, medium: 12000, large: 600000 },
};


function fmt(d: Date, grain: Grain): string {
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (grain === "monthly") return `${y}-${String(m + 1).padStart(2, "0")}`;
  if (grain === "quarterly") return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function buildDates(grain: Grain, points: number): string[] {
  if (grain === "snapshot") return [];
  const out: string[] = [];
  const endY = 2025, endM = 11, endD = 31;
  for (let i = points - 1; i >= 0; i--) {
    if (grain === "monthly" || grain === "quarterly") {
      const step = grain === "quarterly" ? 3 : 1;
      const total = endY * 12 + endM - i * step; // anchor day=1 to avoid month rollover
      out.push(fmt(new Date(Date.UTC(Math.floor(total / 12), total % 12, 1)), grain));
    } else {
      const d = new Date(Date.UTC(endY, endM, endD));
      d.setUTCDate(d.getUTCDate() - i * (grain === "weekly" ? 7 : 1));
      out.push(fmt(d, grain));
    }
  }
  return out;
}

function resolveCategories(bd: BreakdownDef, count: number, rng: Rng): string[] {
  if (bd.values) return rng.sample(bd.values, Math.min(count, bd.values.length));
  if (bd.faker) {
    const set = new Set<string>();
    for (let guard = 0; set.size < count && guard < count * 6; guard++) set.add(bd.faker());
    return [...set];
  }
  return ["All"];
}

function roundMetric(v: number, m: MetricDef): number {
  const d = m.decimals ?? (m.scaleHint === "rate" ? 3 : m.scaleHint === "ratio" ? 2 : 0);
  const f = Math.pow(10, d);
  let x = Math.round((Number.isFinite(v) ? v : 0) * f) / f;
  if (m.scaleHint === "rate") x = Math.min(1, Math.max(0, x));
  return x;
}

export function generateDataset(seed: number, knobsOverride?: Partial<Knobs>): SynthDataset {
  const knobs: Knobs = { ...sampleKnobs(seed, knobsOverride?.archetype), ...knobsOverride };
  const arch = ARCHETYPES[knobs.archetype];
  if (!arch) throw new Error(`unknown archetype: ${knobs.archetype}`);

  faker.seed(seed);
  const rng = new Rng((seed ^ 0x9e3779b9) >>> 0); // data stream, separate from knob sampler

  const primaryMetric = arch.metrics.find((m) => m.primary)!;
  const primaryBd = arch.breakdowns.find((b) => b.primary)!;
  const cats = resolveCategories(primaryBd, cardinalityCount(knobs.breakdownCardinality, rng), rng);

  const rawW = knobs.categoryFrequency === "zipf" ? zipfWeights(cats.length) : cats.map(() => 1);
  const wsum = rawW.reduce((a, b) => a + b, 0);
  const wNorm = rawW.map((w) => (w / wsum) * cats.length); // mean ~1 so scale knob stays meaningful

  const temporal = knobs.grain !== "snapshot";
  const timeName = knobs.grain === "monthly" ? "month" : knobs.grain === "quarterly" ? "quarter" : "date";
  const dates = buildDates(knobs.grain, knobs.points);
  const span = temporal ? dates.length : 1;

  const secBds = arch.breakdowns.filter((b) => !b.primary);
  const secondaries = rng.sample(secBds, knobs.secondaryDimensions)
    .map((bd) => ({ name: bd.name, values: resolveCategories(bd, 4, rng) }));

  const baseMag = MAG[primaryMetric.scaleHint as "money" | "count"][knobs.scale];
  const rows: Record<string, string | number | null>[] = [];

  cats.forEach((cat, ci) => {
    const catBase = baseMag * wNorm[ci] * rng.float(0.85, 1.15);
    const series = temporal
      ? timeSeries(rng, {
          points: span, base: catBase, trendShape: knobs.trendShape, seasonality: knobs.seasonality,
          amplitude: knobs.amplitude, noiseLevel: knobs.noiseLevel, outliers: knobs.outliers,
        })
      : [catBase * rng.float(0.7, 1.3)];

    for (let di = 0; di < span; di++) {
      const row: Record<string, string | number | null> = {};
      if (temporal) row[timeName] = dates[di];
      row[primaryBd.name] = cat;
      for (const s of secondaries) row[s.name] = rng.pick(s.values);

      for (const m of arch.metrics) {
        const v = m.primary ? series[di]
          : m.derive ? m.derive(row as Record<string, number>, rng)
          : m.base ? sampler(rng, m.base)()
          : 0;
        row[m.name] = roundMetric(v, m);
      }

      if (knobs.missingness === "sparse" && rng.float() < 0.05) {
        const nonKey = arch.metrics.filter((m) => !m.primary);
        if (nonKey.length) row[rng.pick(nonKey).name] = null;
      }
      rows.push(row);
    }
  });

  const columns: SynthColumn[] = [
    ...(temporal ? [{ name: timeName, type: "date" as const }] : []),
    { name: primaryBd.name, type: "string" as const },
    ...secondaries.map((s) => ({ name: s.name, type: "string" as const })),
    ...arch.metrics.map((m) => ({ name: m.name, type: "number" as const })),
  ];

  return { tableName: `${arch.id}_synth`, domain: arch.domain, columns, rows, meta: { archetype: arch.id, seed, knobs } };
}
