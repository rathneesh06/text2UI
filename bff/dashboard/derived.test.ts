// bff/dashboard/derived.test.ts — Phase A2: derived metrics (safe expressions).
// Offline. Covers: (1) the exact SQL shapes the closed AST compiles to,
// (2) validation — both expr sides checked against the profile, pct
// auto-format, and the fake-percent guard that makes the "5559.0%" class
// structurally impossible, (3) the runtime sanitizer accepting/rejecting expr,
// (4) EXECUTED golden numbers on DuckDB: SLA attainment %, tickets-per-agent,
// zero-denominator → NULL, and a per-group pct series in a chart.
import assert from "node:assert";
import type { Dataset, ColumnProfile, ColumnType } from "../../shared/types";
import type { DashboardSpec, KpiWidget, Metric } from "../../shared/dashboard-spec";
import { metricExpr, buildKpiSql, buildChartSql } from "./sql";
import { validateSpec } from "./validate";
import { sanitizeWidget, buildWidgetSql } from "./filters";

function col(name: string, type: ColumnType, uniqueCount: number, extra: Partial<ColumnProfile> = {}): ColumnProfile {
  return { name, type, nullable: false, uniqueCount, sampleValues: [], ...extra };
}
const TICKETS: Dataset = {
  tableName: "tickets",
  profile: {
    source: { filename: "tickets.csv", format: "csv" },
    rowCount: 5,
    columns: [
      col("agent", "string", 2, { topValues: [{ value: "Ada", count: 3 }, { value: "Bo", count: 2 }] }),
      col("status", "string", 2, { topValues: [{ value: "open", count: 2 }, { value: "closed", count: 3 }] }),
      col("sla_met", "integer", 2),
      col("hours", "number", 5),
    ],
    sampleRows: [],
  },
};

// ---- 1. SQL shapes ---------------------------------------------------------
{
  const pct: Metric = { col: "sla_met", agg: "sum", expr: { op: "pct", num: { col: "sla_met", agg: "sum" }, den: { col: "", agg: "count" } } };
  assert.equal(metricExpr(pct), `(sum("sla_met") * 100.0 / nullif(count(*), 0))`, "pct: *100 over nullif");
  const ratio: Metric = { col: "", agg: "count", expr: { op: "ratio", num: { col: "", agg: "count" }, den: { col: "agent", agg: "count_distinct" } } };
  assert.equal(metricExpr(ratio), `(count(*) * 1.0 / nullif(count(DISTINCT "agent"), 0))`, "ratio: *1.0 over nullif");
  const diff: Metric = { col: "", agg: "count", expr: { op: "diff", num: { col: "hours", agg: "max" }, den: { col: "hours", agg: "min" } } };
  assert.equal(metricExpr(diff), `(max("hours") - min("hours"))`, "diff: subtraction, no division");
  assert.equal(metricExpr({ col: "hours", agg: "avg" }), `avg("hours")`, "plain metrics unchanged");

  const kpi: KpiWidget = { id: "k", kind: "kpi", title: "SLA", table: "tickets", metric: pct };
  assert.ok(buildKpiSql(kpi).includes("nullif(count(*), 0)"), "KPI builder routes through metricExpr");
  const chart = buildChartSql({ id: "c", kind: "bar", title: "SLA by agent", table: "tickets", x: { col: "agent" }, series: [pct] });
  assert.ok(chart.sql.includes("* 100.0 / nullif"), "chart series route through metricExpr");
  console.log("derived: SQL shapes ✅");
}

// ---- 2. validation ---------------------------------------------------------
{
  const mkSpec = (metric: Metric): DashboardSpec => ({
    version: 1, meta: { title: "T" },
    sections: [{ id: "s", widgets: [{ id: "k1", kind: "kpi", title: "K", table: "tickets", metric }] }],
  });
  const one = (spec: DashboardSpec) => validateSpec(spec, [TICKETS]);

  // pct auto-applies the percent display format.
  let r = one(mkSpec({ col: "sla_met", agg: "sum", expr: { op: "pct", num: { col: "sla_met", agg: "sum" }, den: { col: "", agg: "count" } } }));
  let m = (r.spec.sections[0].widgets[0] as KpiWidget).metric;
  assert.equal(m.format, "percent", "pct expr auto-formats as percent");

  // A bad side drops the metric — honest gap over a silently-wrong ratio.
  r = one(mkSpec({ col: "x", agg: "sum", expr: { op: "pct", num: { col: "ghost", agg: "sum" }, den: { col: "", agg: "count" } } }));
  assert.equal(r.spec.sections.length, 0, "expr with a missing column is dropped");
  assert.ok(r.warnings.some((w) => w.includes("ghost")), "warned about the ghost column");

  // Numeric agg on a string side coerces to count (same rule as plain metrics).
  r = one(mkSpec({ col: "status", agg: "sum", expr: { op: "ratio", num: { col: "status", agg: "sum" }, den: { col: "", agg: "count" } } }));
  m = (r.spec.sections[0].widgets[0] as KpiWidget).metric;
  assert.equal(m.expr!.num.agg, "count", "sum(string) side coerced to count");

  // THE 5559% KILLER: percent display on an additive aggregate without a real
  // division is rewritten to number — the fake-ratio class cannot render.
  r = one(mkSpec({ col: "hours", agg: "sum", format: "percent" }));
  m = (r.spec.sections[0].widgets[0] as KpiWidget).metric;
  assert.equal(m.format, "number", "sum + percent → number");
  assert.ok(r.warnings.some((w) => w.includes("percent")), "warned about the fake percent");
  r = one(mkSpec({ col: "hours", agg: "avg", format: "percent" }));
  m = (r.spec.sections[0].widgets[0] as KpiWidget).metric;
  assert.equal(m.format, "percent", "avg + percent stays (avg of a 0-100 column is a legit rate)");
  console.log("derived: validation + fake-percent guard ✅");
}

// ---- 3. runtime sanitizer --------------------------------------------------
{
  const w = sanitizeWidget({
    id: "k1", kind: "kpi", title: "SLA", table: "tickets",
    metric: { col: "sla_met", agg: "sum", expr: { op: "pct", num: { col: "sla_met", agg: "sum" }, den: { col: "", agg: "count" } } },
  }) as KpiWidget;
  assert.equal(w.metric.expr!.op, "pct", "well-formed expr passes the sanitizer");

  const throws = (raw: unknown, label: string) => {
    try { sanitizeWidget(raw); assert.fail(label + " should throw"); }
    catch (e: any) { assert.equal(e.status, 400, label); }
  };
  throws({ id: "k", kind: "kpi", title: "", table: "t", metric: { col: "c", agg: "sum", expr: { op: "divide; DROP", num: { col: "c", agg: "sum" }, den: { col: "", agg: "count" } } } }, "op injection rejected");
  throws({ id: "k", kind: "kpi", title: "", table: "t", metric: { col: "c", agg: "sum", expr: { op: "pct", num: { col: "c", agg: "exec()" }, den: { col: "", agg: "count" } } } }, "side agg outside the whitelist rejected");
  console.log("derived: runtime sanitizer ✅");
}

// ---- 4. EXECUTED golden numbers -------------------------------------------
await (async () => {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  // Golden fixture: 5 tickets, 3 met SLA → attainment 60.0%; 2 distinct
  // agents → 2.5 tickets/agent; closed group: 2 of 3 met → 66.666…%.
  await conn.run(`CREATE TABLE tickets (agent VARCHAR, status VARCHAR, sla_met INT, hours DOUBLE)`);
  await conn.run(`INSERT INTO tickets VALUES
    ('Ada','closed',1, 2.0), ('Ada','closed',1, 4.0), ('Ada','open',  0, 8.0),
    ('Bo', 'closed',0, 1.0), ('Bo', 'open',  1, 5.0)`);
  const run = async (sql: string) => {
    const r = await conn.run(sql);
    return (await r.getRowObjects()).map((row: any) => { const o: any = {}; for (const k of Object.keys(row)) o[k] = typeof row[k] === "bigint" ? Number(row[k]) : row[k]; return o; });
  };

  const sla = { id: "k1", kind: "kpi", title: "SLA attainment", table: "tickets",
    metric: { col: "sla_met", agg: "sum", expr: { op: "pct", num: { col: "sla_met", agg: "sum" }, den: { col: "", agg: "count" } } } };
  let rows = await run(buildWidgetSql(sla, []));
  assert.equal(Number(rows[0].value), 60, "SLA attainment % = 60.0 (hand-computed)");

  const perAgent = { id: "k2", kind: "kpi", title: "Tickets per agent", table: "tickets",
    metric: { col: "", agg: "count", expr: { op: "ratio", num: { col: "", agg: "count" }, den: { col: "agent", agg: "count_distinct" } } } };
  rows = await run(buildWidgetSql(perAgent, []));
  assert.equal(Number(rows[0].value), 2.5, "tickets per agent = 2.5");

  // Global filters compose with expr: SLA over closed tickets only = 2/3.
  rows = await run(buildWidgetSql(sla, [{ col: "status", kind: "select", value: "closed" }]));
  assert.ok(Math.abs(Number(rows[0].value) - 200 / 3) < 1e-9, "filtered SLA = 66.67%");

  // Zero denominator → NULL, never Infinity/garbage. (Filter to zero rows.)
  rows = await run(buildWidgetSql(sla, [{ col: "status", kind: "select", value: "nonexistent" }]));
  assert.equal(rows[0].value, null, "0/0 → NULL (renders as em dash)");

  // A pct SERIES inside a grouped chart: per-agent attainment.
  const chart = { id: "c1", kind: "bar", title: "SLA by agent", table: "tickets",
    x: { col: "agent" },
    series: [{ col: "sla_met", agg: "sum", label: "attainment", expr: { op: "pct", num: { col: "sla_met", agg: "sum" }, den: { col: "", agg: "count" } } }] };
  rows = await run(buildWidgetSql(chart, []));
  const byAgent: Record<string, number> = {};
  for (const r of rows) byAgent[r.x] = Number(r[Object.keys(r).find((k) => k !== "x")!]);
  assert.ok(Math.abs(byAgent["Ada"] - 200 / 3) < 1e-9, "Ada attainment 66.67%");
  assert.equal(byAgent["Bo"], 50, "Bo attainment 50%");
  console.log("derived: executed golden numbers ✅");
})();

// ---- 5. degraded-mode visibility: the deterministic fallback emits a real
// ratio KPI (indicator → pct; else rows-per-dimension → ratio), validates
// cleanly, and EXECUTES. This is what renders when the model key is dead. ----
await (async () => {
  const { fallbackRatioKpi } = await import("./agents");
  const { classifySchema } = await import("./enhance");

  // Indicator column present → "<col> rate" pct KPI.
  const withInd = fallbackRatioKpi([{
    tableName: "tickets",
    profile: { source: { filename: "t.csv", format: "csv" }, rowCount: 5, columns: [
      col("agent", "string", 2, { topValues: [{ value: "Ada", count: 3 }, { value: "Bo", count: 2 }] }),
      col("sla_met", "integer", 2, { min: 0, max: 1 }),
    ], sampleRows: [] },
  }], classifySchema([TICKETS]));
  assert.ok(withInd, "indicator fixture yields a ratio KPI");
  assert.equal(withInd!.metric.expr!.op, "pct");
  assert.equal(withInd!.metric.expr!.num.col, "sla_met");
  assert.equal(withInd!.metric.expr!.den.agg, "count");

  // Survives validation and the compiled SQL carries the nullif guard.
  const spec: DashboardSpec = { version: 1, meta: { title: "T" }, sections: [{ id: "s", widgets: [withInd!] }] };
  const v = validateSpec(spec, [TICKETS]);
  assert.equal(v.spec.sections.length, 1, "fallback ratio KPI survives validation");
  const kept = (v.spec.sections[0].widgets[0] as KpiWidget).metric;
  assert.equal(kept.format, "percent");
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const inst2 = await DuckDBInstance.create(":memory:");
  const c2 = await inst2.connect();
  await c2.run(`CREATE TABLE tickets (agent VARCHAR, sla_met INT)`);
  await c2.run(`INSERT INTO tickets VALUES ('Ada',1),('Ada',1),('Ada',0),('Bo',0),('Bo',1)`);
  const r2 = await c2.run(buildWidgetSql({ ...withInd!, table: "tickets" }, []));
  const rows2 = await r2.getRowObjects();
  assert.equal(Number((rows2[0] as any).value), 60, "degraded-mode ratio KPI executes: 60%");

  // No indicator → rows-per-dimension ratio.
  const noInd: Dataset = { tableName: "orders", profile: { source: { filename: "o.csv", format: "csv" }, rowCount: 100, columns: [
    col("region", "string", 4, { topValues: [{ value: "EU", count: 60 }, { value: "US", count: 40 }] }),
    col("amount", "number", 90),
  ], sampleRows: [] } };
  const perDim = fallbackRatioKpi([noInd], classifySchema([noInd]));
  assert.ok(perDim && perDim.metric.expr!.op === "ratio", "dimension fixture yields a per-X ratio");
  assert.equal(perDim!.metric.expr!.den.agg, "count_distinct");
  console.log("derived: degraded-mode fallback ratio KPI ✅");
})();

console.log("derived.test.ts: all assertions passed ✅");
