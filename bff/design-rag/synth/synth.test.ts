// bff/design-rag/synth/synth.test.ts — offline, deterministic (seeded).
import assert from "node:assert";
import { generateDataset } from "./generate";
import { sampleKnobs } from "./knobs";
import { timeSeries } from "./timeseries";
import { Rng, zipfWeights } from "./prng";
import { ARCHETYPE_IDS } from "./archetypes";

// ---- determinism: a seed fully determines a dataset ------------------------
{
  const a = generateDataset(12345);
  const b = generateDataset(12345);
  assert.equal(JSON.stringify(a), JSON.stringify(b), "same seed -> identical dataset");
  const c = generateDataset(99999);
  assert.notEqual(JSON.stringify(a.rows), JSON.stringify(c.rows), "different seed -> different data");
  // knob sampling is also deterministic
  assert.deepEqual(sampleKnobs(7), sampleKnobs(7), "knobs deterministic per seed");
}

// ---- every archetype builds; rows = categories x timepoints ----------------
{
  for (const id of ARCHETYPE_IDS) {
    const d = generateDataset(2024, { archetype: id, grain: "monthly", points: 12, breakdownCardinality: "small" });
    assert.equal(d.domain && d.meta.archetype, id, `${id}: archetype tagged`);
    assert.ok(d.rows.length > 0 && d.columns.length > 0, `${id}: non-empty`);
    const cats = new Set(d.rows.map((r) => r[d.columns.find((c) => c.type === "string")!.name]));
    assert.equal(d.rows.length, cats.size * 12, `${id}: rows = categories x 12 months`);
    assert.ok(d.columns.some((c) => c.type === "date"), `${id}: has a time column`);
  }
}

// ---- numeric sanity: rates in [0,1], counts/money non-negative -------------
{
  for (const id of ARCHETYPE_IDS) {
    const d = generateDataset(555, { archetype: id });
    for (const row of d.rows) {
      for (const [k, v] of Object.entries(row)) {
        if (typeof v !== "number") continue;
        assert.ok(v >= 0, `${id}.${k} non-negative (got ${v})`);
        if (k.includes("rate") || k === "margin") assert.ok(v <= 1.001, `${id}.${k} <= 1 (got ${v})`);
      }
    }
  }
}

// ---- relationships hold (derived columns are consistent) -------------------
{
  const fin = generateDataset(7, { archetype: "finance", missingness: "none" });
  for (const r of fin.rows) {
    assert.equal(r.net_income, (r.revenue as number) - (r.expenses as number), "net_income = revenue - expenses");
  }
  const mkt = generateDataset(8, { archetype: "marketing", missingness: "none" });
  for (const r of mkt.rows) {
    assert.ok((r.clicks as number) <= (r.impressions as number), "funnel: clicks <= impressions");
    assert.ok((r.conversions as number) <= (r.clicks as number) + 1, "funnel: conversions <= clicks");
  }
  const crm = generateDataset(9, { archetype: "users_crm", missingness: "none" });
  for (const r of crm.rows) {
    assert.ok((r.qualified as number) <= (r.leads as number) + 1, "funnel: qualified <= leads");
    assert.ok((r.won as number) <= (r.proposals as number) + 1, "funnel: won <= proposals");
  }
}

// ---- snapshot grain: no time column, one row per category ------------------
{
  const d = generateDataset(101, { archetype: "sales", grain: "snapshot", breakdownCardinality: "small" });
  assert.ok(!d.columns.some((c) => c.type === "date"), "snapshot has no time column");
  const cats = new Set(d.rows.map((r) => r.region));
  assert.equal(d.rows.length, cats.size, "snapshot: one row per category");
}

// ---- time series: shape responds to knobs ----------------------------------
{
  const rng = new Rng(3);
  const up = timeSeries(rng, { points: 24, base: 1000, trendShape: "linear-up", seasonality: "none", noiseLevel: "low", outliers: "none" });
  assert.equal(up.length, 24, "length = points");
  const firstAvg = (up[0] + up[1] + up[2]) / 3, lastAvg = (up[21] + up[22] + up[23]) / 3;
  assert.ok(lastAvg > firstAvg, "linear-up trends upward");
  const down = timeSeries(new Rng(3), { points: 24, base: 1000, trendShape: "linear-down", seasonality: "none", noiseLevel: "low", outliers: "none" });
  assert.ok((down[22] + down[23]) / 2 < (down[0] + down[1]) / 2, "linear-down trends downward");
  assert.ok(up.every((v) => v >= 0), "non-negative by default");
}

// ---- zipf weights are decreasing; zipf categories skew totals --------------
{
  const w = zipfWeights(5);
  for (let i = 1; i < w.length; i++) assert.ok(w[i] < w[i - 1], "zipf weights strictly decreasing");
}

// ---- knob invariants: snapshot => no seasonality; points valid for grain ---
{
  for (let s = 0; s < 50; s++) {
    const k = sampleKnobs(s);
    if (k.grain === "snapshot") assert.equal(k.seasonality, "none", "snapshot has no seasonality");
    assert.ok(k.secondaryDimensions >= 0 && k.secondaryDimensions <= 2, "secondaryDimensions in range");
  }
}

console.log("ok design-rag/synth");
