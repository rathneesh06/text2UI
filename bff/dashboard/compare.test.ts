// bff/dashboard/compare.test.ts — run with: npm run test:compare
// A4 period comparison: EXECUTED goldens (real DuckDB, hand-computed numbers),
// validation repairs, and sanitizer parity. Windows are anchored at max(dateCol)
// in the data — "latest bucket vs the one before" — never model-written.
import assert from "node:assert/strict";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Dataset } from "../../shared/types";
import type { DashboardSpec, KpiWidget, Metric } from "../../shared/dashboard-spec";
import { buildKpiSql } from "./sql";
import { validateSpec } from "./validate";
import { sanitizeWidget } from "./filters";

const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const q = async (sql: string) => {
  const reader = await conn.runAndReadUntil(sql, 100_000);
  return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((row) => {
    for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
    return row;
  });
};

// Hand-computed fixture: June 2026 → 10 tickets (4 met), July 2026 → 15 tickets
// (12 met). May 2026 → 3 tickets (noise proving only ADJACENT windows count).
await conn.run(`CREATE TABLE tickets AS
  SELECT * FROM (
    SELECT (DATE '2026-05-10' + INTERVAL (i) DAY)::DATE AS created_at, 'met' AS sla FROM range(0, 3) t(i)
    UNION ALL
    SELECT (DATE '2026-06-05' + INTERVAL (i % 20) DAY)::DATE, CASE WHEN i < 4 THEN 'met' ELSE 'missed' END FROM range(0, 10) t(i)
    UNION ALL
    SELECT (DATE '2026-07-02' + INTERVAL (i % 25) DAY)::DATE, CASE WHEN i < 12 THEN 'met' ELSE 'missed' END FROM range(0, 15) t(i)
  )`);

const kpi = (metric: Metric): KpiWidget =>
  ({ id: "k1", kind: "kpi", title: "T", table: "tickets", metric });

// ---- 1. plain count, month grain: value=15 (July), prev=10 (June) ------------------
{
  const w = kpi({ col: "", agg: "count", compare: { grain: "month", dateCol: "created_at" } });
  const sql = buildKpiSql(w);
  assert.ok(sql.includes("prev_value"), "two-column comparison SQL: " + sql);
  assert.ok(sql.includes("INTERVAL 1 MONTH"), "adjacent-window step in SQL");
  const rows = await q(sql);
  assert.equal(rows[0].value, 15, "latest month (July) = 15");
  assert.equal(rows[0].prev_value, 10, "previous month (June) = 10 — May noise excluded");
}
console.log("compare: executed golden — plain count, month windows ✅");

// ---- 2. derived rate compared across windows: 80% vs 40% ---------------------------
{
  const w = kpi({ col: "", agg: "count", compare: { grain: "month", dateCol: "created_at" },
    expr: { op: "pct",
      num: { col: "", agg: "count", where: [{ col: "sla", op: "=", value: "met" }] },
      den: { col: "", agg: "count" } } });
  const rows = await q(buildKpiSql(w));
  assert.equal(Number(rows[0].value), 80, "July rate = 12/15 = 80%");
  assert.equal(Number(rows[0].prev_value), 40, "June rate = 4/10 = 40% — each window computes its OWN rate");
}
console.log("compare: executed golden — windowed derived rate ✅");

// ---- 3. widget filters still apply to BOTH windows ---------------------------------
{
  const w = kpi({ col: "", agg: "count", compare: { grain: "month", dateCol: "created_at" } });
  (w as any).filters = [{ col: "sla", op: "=", value: "met" }];
  const rows = await q(buildKpiSql(w));
  assert.equal(rows[0].value, 12, "July met = 12 under the widget filter");
  assert.equal(rows[0].prev_value, 4, "June met = 4 under the SAME filter");
}
console.log("compare: executed golden — filters scope both windows ✅");

// ---- 4. validation repairs: bad dateCol autofilled; no temporal → stripped ---------
{
  const col = (name: string, type: string): any => ({ name, type, uniqueCount: 5, nullCount: 0, sampleValues: [] });
  const DATA: Dataset = { tableName: "tickets", profile: { source: { filename: "t", format: "csv" }, rowCount: 28,
    columns: [col("sla", "string"), col("created_at", "date")], sampleRows: [] } } as any;
  const mk = (metric: Metric): DashboardSpec => ({ version: 1, meta: { title: "T" },
    sections: [{ id: "s", widgets: [kpi(metric)] }] });

  let r = validateSpec(mk({ col: "", agg: "count", compare: { grain: "month", dateCol: "sla" } }), [DATA]);
  let m = (r.spec.sections[0].widgets[0] as KpiWidget).metric;
  assert.equal(m.compare?.dateCol, "created_at", "non-temporal dateCol repaired to the table's temporal column");
  assert.ok(r.warnings.some((w) => w.includes("repaired to")), "repair is disclosed");

  const NODATE: Dataset = { tableName: "tickets", profile: { ...DATA.profile, columns: [col("sla", "string")] } } as any;
  r = validateSpec(mk({ col: "", agg: "count", compare: { grain: "month", dateCol: "created_at" } }), [NODATE]);
  m = (r.spec.sections[0].widgets[0] as KpiWidget).metric;
  assert.equal(m.compare, undefined, "no temporal column → compare stripped");
  assert.equal(r.spec.sections.length, 1, "…and the KPI itself SURVIVES");
  assert.ok(r.warnings.some((w) => w.includes("comparison removed")), "strip is disclosed");
}
console.log("compare: validation repairs (autofill / strip, KPI survives) ✅");

// ---- 5. sanitizer parity: compare survives the runtime rebuild ----------------------
{
  const sw: any = sanitizeWidget({ id: "k1", kind: "kpi", title: "T", table: "tickets",
    metric: { col: "", agg: "count", compare: { grain: "month", dateCol: "created_at" } } });
  assert.deepEqual(sw.metric.compare, { grain: "month", dateCol: "created_at" },
    "the delta chip survives a filter-change re-query");
  assert.throws(() => sanitizeWidget({ id: "k1", kind: "kpi", title: "T", table: "tickets",
    metric: { col: "", agg: "count", compare: { grain: "fortnight", dateCol: "created_at" } } }),
    /compare\.grain/, "unknown grain 400s");
  const rows = await q(buildKpiSql(sw));
  assert.equal(rows[0].value, 15, "sanitized widget compiles and executes identically");
}
console.log("compare: sanitizer parity (build ↔ runtime) ✅");

console.log("compare.test.ts: all assertions passed ✅");
conn.disconnectSync();
inst.closeSync();
