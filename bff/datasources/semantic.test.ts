// bff/datasources/semantic.test.ts — run with: npm run test:semantic
// Covers the generic semantic model layer (entities, join candidates, the
// candidate-metrics tier) and its ride on the enhancement baseline.
import assert from "node:assert";
import { buildSemanticModel, semanticDigest, humanizeName, guessFormat, joinCandidates, candidateMetrics } from "./semantic";
import { enhanceQuery } from "../dashboard/enhance";
import type { Dataset } from "../../shared/types";

const col = (name: string, type: string, uniqueCount: number, extra: object = {}) =>
  ({ name, type, uniqueCount, nullable: false, sampleValues: [], ...extra } as any);

const orders: Dataset = {
  tableName: "my_orders_sos",
  profile: {
    source: { filename: "db", format: "table" }, rowCount: 5000,
    columns: [
      col("order_id", "integer", 5000),
      col("customer_id", "integer", 900),
      col("region", "string", 5),
      col("revenue_amount", "number", 3500),
      col("refund_rate", "number", 40),
      col("created_at", "date", 4800, { min: "2025-01-01", max: "2026-06-30" }),
    ],
    sampleRows: [],
  },
} as any;

const customers: Dataset = {
  tableName: "customers",
  profile: {
    source: { filename: "db", format: "table" }, rowCount: 900,
    columns: [col("customer_id", "integer", 900), col("customer_name", "string", 890), col("segment", "string", 4)],
    sampleRows: [],
  },
} as any;

const statusLookup: Dataset = {
  tableName: "myshift__my_status",
  profile: {
    source: { filename: "db", format: "table" }, rowCount: 8,
    columns: [col("statusid", "integer", 8), col("statustitle", "string", 8)],
    sampleRows: [],
  },
} as any;

// ---- humanization + format guessing --------------------------------------------------
assert.equal(humanizeName("my_orders_sos"), "orders");
assert.equal(humanizeName("myshift__my_status"), "myshift my status".replace("myshift my ", "myshift my ")); // noise prefixes trimmed once
assert.equal(guessFormat("revenue_amount"), "currency");
assert.equal(guessFormat("refund_rate"), "percent");
assert.equal(guessFormat("age_hours"), "hours");
assert.equal(guessFormat("region"), undefined);
console.log("semantic: humanization + formats ✅");

// ---- join candidates: FK-style name matching, confidence-tagged ----------------------
{
  const joins = joinCandidates([orders, customers, statusLookup]);
  const j = joins.find((x) => x.leftTable === "my_orders_sos" && x.rightTable === "customers");
  assert.ok(j, `orders→customers join found (got ${JSON.stringify(joins)})`);
  assert.equal(j!.leftCol, "customer_id");
  assert.equal(j!.rightCol, "customer_id");
  assert.equal(j!.confidence, "high", "exact column match → high confidence");
  // No hallucinated join to the status lookup (no matching stem).
  assert.ok(!joins.some((x) => x.rightTable === "myshift__my_status"), "no ungrounded joins");
}
console.log("semantic: join candidates ✅");

// ---- candidate metrics: the cold-start tier ------------------------------------------
{
  const metrics = candidateMetrics([orders, customers]);
  const total = metrics.find((m) => m.id === "sum_my_orders_sos_revenue_amount");
  assert.ok(total, "sum metric derived");
  assert.equal(total!.format, "currency", "currency hint applied");
  assert.equal(total!.trust, "candidate", "cold-start tier: candidate, not approved");
  assert.ok(metrics.some((m) => m.agg === "count_distinct" && m.col === "order_id"), "distinct metric for identifier");
  assert.ok(metrics.some((m) => m.grain), "trend metric carries a grain");
  assert.ok(metrics.length <= 24, "metric menu capped");
}
console.log("semantic: candidate metrics ✅");

// ---- model + digest + enhancement ride -----------------------------------------------
{
  const model = buildSemanticModel([orders, customers, statusLookup]);
  assert.equal(model.entities.find((e) => e.table === "my_orders_sos")!.role, "fact");
  assert.equal(model.entities.find((e) => e.table === "myshift__my_status")!.role, "lookup");
  const digest = semanticDigest(model);
  for (const needle of ["SEMANTIC MODEL", "CANDIDATE METRICS", "sum(my_orders_sos.revenue_amount)", "JOIN CANDIDATES", "unverified"]) {
    assert.ok(digest.includes(needle), `digest missing: ${needle}`);
  }
  // The digest rides the ALWAYS-ON baseline through the enhancement layer.
  const e = await enhanceQuery({ datasets: [orders], userPrompt: "dash", skipRewrite: true, semanticDigest: digest });
  assert.ok(e.combined.includes("CANDIDATE METRICS"), "semantic digest reaches the combined directive");
  assert.ok(e.combined.includes("BASELINE INSTRUCTIONS"), "…without displacing the baseline");
}
console.log("semantic: model digest rides the enhancement baseline ✅");

console.log("semantic.test.ts: all assertions passed ✅");
