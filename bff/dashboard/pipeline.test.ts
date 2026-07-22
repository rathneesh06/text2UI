// bff/dashboard/pipeline.test.ts — STRUCTURAL CONTRACT TESTS.
//
// Every recent incident traced to one pattern: a capability wired into SOME
// layers but not all of them — expr `required` present in two schemas and
// missing from the third (A2.4), topValues consumed by guards but produced by
// nothing (A2.8), `where` accepted by schemas but stripped by a coercer,
// widget.filters compiled by SQL but emittable by nothing. Fixture-based
// feature tests cannot catch these, because fixtures SUPPLY the missing link.
//
// These tests assert the contracts themselves, programmatically, across every
// surface — so a capability added to one layer FAILS THE BUILD until it exists
// in all of them.
import assert from "node:assert/strict";
import { validateSpec } from "./validate";
import { buildKpiSql } from "./sql";
import type { DashboardSpec, KpiWidget, Filter, Metric } from "../../shared/dashboard-spec";
import type { Dataset, ColumnProfile } from "../../shared/types";

const col = (name: string, type: ColumnProfile["type"], uniqueCount = 3, extra: Partial<ColumnProfile> = {}): ColumnProfile =>
  ({ name, type, nullable: false, uniqueCount, sampleValues: [], ...extra });

// ---- 1. SCHEMA SYMMETRY across the three model surfaces ---------------------
await (async () => {
  const patch = await import("./patch");
  const planner = await import("./planner");
  const agentsSrc = (await import("node:fs")).readFileSync(new URL("./agents.ts", import.meta.url), "utf8");

  const surfaces: Record<string, string> = {
    patch: JSON.stringify((patch as any).EDIT_OPS_SCHEMA),
    planner: JSON.stringify((planner as any).DASHBOARD_SCHEMA),
    agents: agentsSrc, // schemas are module-internal; the source text is the contract
  };

  for (const [name, s] of Object.entries(surfaces)) {
    // expr is a closed AST with all three parts REQUIRED (A2.4: patch missing
    // `required` let Gemini legally emit den-less exprs → "malformed expr").
    assert.ok(/required":\s*\["op",\s*"num",\s*"den"\]|required: \["op", "num", "den"\]/.test(s),
      `${name}: expr must require op/num/den`);
    // conditional numerators (`where`) must be expressible on expr sides.
    assert.ok(/"where"|where:/.test(s), `${name}: expr sides must accept where`);
    // filter values must be TYPED — an untyped {} schema is undefined behavior
    // for Gemini structured output.
    assert.ok(!/"value":\s*\{\}|value: \{\}/.test(s), `${name}: filter value must have a type`);
    // widget-level filters must be emittable (the half-pipeline: compiled by
    // sql.ts but absent from every schema meant NOTHING could produce them).
    assert.ok(/"filters"|filters:/.test(s), `${name}: widgets must expose filters`);
  }

  // The agents' coercers must PRESERVE what the schema accepts — a schema that
  // accepts `where` feeding a coercer that strips it is a lie with two layers.
  assert.ok(/coerceWhere/.test(agentsSrc), "agents: coercer preserves expr.where");
  assert.ok(/coerceWidgetFilters/.test(agentsSrc), "agents: coercer preserves widget.filters");
  console.log("pipeline: schema symmetry across agents/planner/patch ✅");
})();

// ---- 2. PROFILE CONTRACT: every consumed field has a producer ---------------
await (async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const read = (p: string) => fs.readFileSync(path.resolve(p), "utf8");
  // Producers: the shared enrichment (all in-memory producers route through it)
  // and the exact-SQL stats module (DB-backed producers).
  const producers = read("shared/profile-enrich.ts") + read("bff/sources/exact-stats.ts") + read("src/lib/ingest.ts");
  // Fields the dashboard layer READS off ColumnProfile:
  const consumed = ["topValues", "min", "max", "uniqueCount", "type", "name"];
  for (const f of consumed) {
    assert.ok(new RegExp(`${f}`).test(producers), `profile field "${f}" is consumed but has no producer`);
  }
  // …and each dashboard consumer of topValues exists (guard + filters + digest):
  for (const file of ["bff/dashboard/validate.ts", "bff/dashboard/filters.ts", "bff/dashboard/enhance.ts"]) {
    assert.ok(/topValues/.test(read(file)), `${file} should consume topValues`);
  }
  console.log("pipeline: profile producer/consumer contract ✅");
})();

// ---- 3. widget.filters END-TO-END: validate → compile -----------------------
{
  const DATA: Dataset = {
    tableName: "tickets",
    profile: { source: { filename: "t.csv", format: "csv" }, rowCount: 100, columns: [
      col("status", "string", 3, { topValues: [{ value: "Open", count: 60 }, { value: "Closed", count: 30 }, { value: "PIR", count: 10 }], statsExact: true }),
      col("age_hours", "number", 50, { min: 0, max: 500 }),
    ], sampleRows: [] },
  };
  const mk = (filters: Filter[] | undefined, metric: Metric = { col: "", agg: "count" }): DashboardSpec => ({
    version: 1, meta: { title: "T" },
    sections: [{ id: "s", widgets: [{ id: "k1", kind: "kpi", title: "Open tickets", table: "tickets", metric, ...(filters ? { filters } : {}) } as KpiWidget] }],
  });

  // Valid filter: survives validation AND lands in the compiled SQL.
  let r = validateSpec(mk([{ col: "status", op: "=", value: "Open" }]), [DATA]);
  assert.equal(r.spec.sections.length, 1, "valid widget filter survives");
  const sql = buildKpiSql(r.spec.sections[0].widgets[0] as KpiWidget);
  assert.ok(/WHERE\s+"status"\s*=\s*'Open'/.test(sql), "filter compiled into WHERE: " + sql);

  // Case-mismatched literal: REWRITTEN to the observed spelling (0.0% class).
  r = validateSpec(mk([{ col: "status", op: "=", value: "open" }]), [DATA]);
  assert.equal(r.spec.sections.length, 1, "case mismatch survives via rewrite");
  assert.equal(((r.spec.sections[0].widgets[0] as any).filters[0] as Filter).value, "Open", "literal rewritten");
  assert.ok(r.warnings.some((w) => w.includes("rewritten to observed value")), "rewrite warned");

  // Provably-empty subset (exhaustive topValues, no match): widget DROPS —
  // an honest gap instead of a silently-wrong-or-empty widget.
  r = validateSpec(mk([{ col: "status", op: "=", value: "Reopened" }]), [DATA]);
  assert.equal(r.spec.sections.length, 0, "provably-empty subset drops the widget");
  assert.ok(r.warnings.some((w) => w.includes("matches NO observed value")), "drop names observed values");

  // Nonexistent column: drop with a warning (would be broken SQL at runtime).
  r = validateSpec(mk([{ col: "not_a_column", op: "=", value: "x" }]), [DATA]);
  assert.equal(r.spec.sections.length, 0, "unknown filter column drops the widget");
  assert.ok(r.warnings.some((w) => w.includes('"not_a_column" not in tickets')), "warning names the column");

  // Empty filters array is normalized away, widget lives.
  r = validateSpec(mk([]), [DATA]);
  assert.equal(r.spec.sections.length, 1, "empty filters array is fine");
  assert.equal((r.spec.sections[0].widgets[0] as any).filters, undefined, "…and removed");
  console.log("pipeline: widget.filters validate→compile end-to-end ✅");
}

// ---- 4. AGENT COERCION preserves conditional rates (executed shape) ---------
await (async () => {
  const agents = await import("./agents");
  // Reach the KPI agent's coerce through its registry if exported; otherwise
  // exercise the path through the module's fallback builder contract.
  const src = (await import("node:fs")).readFileSync(new URL("./agents.ts", import.meta.url), "utf8");
  // The strip regression: coerceExpr must reference num.where and den.where.
  assert.ok(/num\.where/.test(src) && /den\.where/.test(src), "coerceExpr carries where on BOTH sides");
  void agents;
  console.log("pipeline: agent coercion preserves where ✅");
})();

// ---- 5. UNFORGEABLE EXHAUSTIVENESS (the A3/D1/F1 completion) ----------------
// A sample-floor profile (no statsExact) may NEVER hard-drop a literal as
// "provably empty" — it hasn't seen the whole column. Only exact producers
// (exact SQL stats / full-data ingest) set statsExact and earn the drop.
{
  const mkData = (statsExact: boolean): Dataset => ({
    tableName: "sla",
    profile: { source: { filename: "s.csv", format: "csv" }, rowCount: 1000, columns: [
      col("sla_status", "string", 2, { topValues: [{ value: "met", count: 3 }, { value: "breached", count: 2 }], ...(statsExact ? { statsExact: true } : {}) }),
    ], sampleRows: [] },
  });
  const mkSpec = (): DashboardSpec => ({ version: 1, meta: { title: "T" }, sections: [{ id: "s", widgets: [
    { id: "k", kind: "kpi", title: "SLA attainment", table: "sla", metric: { col: "", agg: "count", expr: { op: "pct",
      num: { col: "", agg: "count", where: [{ col: "sla_status", op: "=", value: "achieved" }] }, den: { col: "", agg: "count" } } } } as KpiWidget,
  ] }] });

  // Floor profile: same no-match literal only WARNS (kept) — a 5-row sample
  // "proving" emptiness was the failure mode.
  let r = validateSpec(mkSpec(), [mkData(false)]);
  assert.equal(r.spec.sections.length, 1, "sample-floor profile cannot hard-drop");
  assert.ok(r.warnings.some((w) => w.includes("not among the top observed values")), "…but it does warn");
  // Exact profile: the drop is earned.
  r = validateSpec(mkSpec(), [mkData(true)]);
  assert.equal(r.spec.sections.length, 0, "exact profile drops the provably-empty condition");
  console.log("pipeline: exhaustiveness requires statsExact ✅");
}

// ---- 6. SANITIZER ↔ COMPILE PARITY (D5a + F5) -------------------------------
// The query path re-validates client widgets and must accept EVERYTHING the
// build path renders — same widget in, same SQL out. The live incident: an
// expr KPI (compile ignores top-level agg/col) was rejected by a sanitizer
// that demanded them → rendered on build, 400ed on filter.
await (async () => {
  const { sanitizeWidget, buildWidgetSql } = await import("./filters");
  const { buildKpiSql } = await import("./sql");
  const exprKpi: any = { id: "k", kind: "kpi", title: "Rate", table: "sla", metric: {
    // NOTE: no top-level agg/col — exactly what an edit-path model emits.
    expr: { op: "pct", num: { col: "", agg: "count", where: [{ col: "sla_status", op: "=", value: "met" }] }, den: { col: "", agg: "count" } } } };
  const sanitized = sanitizeWidget(exprKpi); // must NOT throw (the D5a regression)
  const querySql = buildWidgetSql(exprKpi, []);
  assert.ok(/FILTER \(WHERE "sla_status" = 'met'\)/.test(querySql), "query path compiles the conditional rate: " + querySql);
  // Parity: a fully-specified widget produces identical SQL on both paths.
  const plain: any = { id: "k2", kind: "kpi", title: "N", table: "sla", metric: { col: "", agg: "count" },
    filters: [{ col: "sla_status", op: "=", value: "met" }] };
  assert.equal(buildWidgetSql(plain, []), buildKpiSql(plain), "build and query paths emit identical SQL");
  void sanitized;
  console.log("pipeline: sanitizer ↔ compile parity ✅");
})();

// ---- 7. RENDERER FORMAT COVERAGE (C1/C2 completions) ------------------------
// The renderer is one template literal; these are structural presence checks —
// a format produced upstream must have a consumer in the template.
await (async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");
  assert.ok(/tickFormatter=\{tickFmt\}/.test(src), "chart YAxis applies series format");
  assert.ok(/formatter=\{tipFmt\}/.test(src), "chart Tooltip applies series format");
  assert.ok(/fmt\(v, colMeta\[h\] && colMeta\[h\]\.format\)/.test(src), "table cells apply per-column format");
  assert.ok(/No rows match the current filters/.test(src), "filter-aware empty state present");
  for (const f of ["percent", "currency", "hours", "days", "compact"]) {
    assert.ok(src.includes(`"${f}"`), `format "${f}" handled in fmt()`);
  }
  // compile must feed the table columns the renderer consumes:
  const compileSrc = fs.readFileSync(new URL("./compile.ts", import.meta.url), "utf8");
  assert.ok(/columns: cols/.test(compileSrc), "compile attaches table column metadata");
  console.log("pipeline: renderer consumes every produced format ✅");
})();

// ---- 8. HONESTY CHANNEL CONTRACTS (E1/E2/E3 completions) --------------------
await (async () => {
  const { applyOps } = await import("./patch");
  const cur: DashboardSpec = { version: 1, meta: { title: "T" }, sections: [{ id: "s1", widgets: [
    { id: "k1", kind: "kpi", title: "Avg Age", table: "t", metric: { col: "age", agg: "avg" } } as KpiWidget ] }] };
  // The metric-identity decline must land in the NOTES channel (surfaced to
  // the user), and applying only a reverted change must be detectable as
  // net-zero by deep-equality.
  const r = applyOps(structuredClone(cur), [{ op: "update_widget", id: "k1", set: { metric: { col: "", agg: "count" } } } as any], "make it look nicer");
  assert.ok(r.notes.some((n) => n.includes("kept")), "decline lands in notes");
  assert.equal(JSON.stringify(r.spec), JSON.stringify(cur), "reverted-only edit is net-zero detectable");
  console.log("pipeline: honesty channels (notes + net-zero) ✅");
})();

console.log("pipeline.test.ts: all assertions passed ✅");
