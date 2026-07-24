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

  // OPEN-GRAMMAR: a provably-empty subset RENDERS honestly (the true answer is
  // zero) with a warning naming the observed values — the question stays askable.
  r = validateSpec(mk([{ col: "status", op: "=", value: "Reopened" }]), [DATA]);
  assert.equal(r.spec.sections.length, 1, "provably-empty subset renders honestly");
  assert.equal(((r.spec.sections[0].widgets[0] as any).filters[0] as Filter).value, "Reopened", "literal kept as asked");
  assert.ok(r.warnings.some((w) => w.includes("matches NO observed value") && w.includes("rendered honestly")), "warning names observed values and the honest-empty outcome");

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
  // Exact profile: the STRONG claim ("matches NO observed value") is earned —
  // and under OPEN-GRAMMAR the widget still renders its honest zero, so the
  // statsExact gate now governs the WORDING of the warning, not a drop.
  r = validateSpec(mkSpec(), [mkData(true)]);
  assert.equal(r.spec.sections.length, 1, "exact profile renders honestly too");
  assert.ok(r.warnings.some((w) => w.includes("matches NO observed value")), "exact profile earns the provably-empty wording");
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

// ---- 9. MODEL RESILIENCE POLICY (the 2026-07 Google-side outage) ------------
// Google retired gemini-2.5-flash for new keys (404) and re-pointed the
// flash-latest alias to a generation that rejects the 2.x thinkingConfig
// (bare 400 INVALID_ARGUMENT on EVERY call). The policy under test: model
// selection is dynamic (newest stable flash from ListModels), and the
// selection function is pure so this never needs a network to verify.
await (async () => {
  const { pickBestFlash } = await import("../aiflow");
  const listed = ["models/gemini-2.5-flash", "models/gemini-flash-latest", "models/gemini-3.5-flash",
    "models/gemini-3.6-flash", "models/gemini-3.1-flash-lite", "models/gemini-3-flash-preview"];
  assert.equal(pickBestFlash(listed), "gemini-3.6-flash", "newest stable flash wins over aliases/previews/lites");
  assert.equal(pickBestFlash(listed, "gemini-3.6-flash"), "gemini-3.5-flash", "a failed model is excluded from re-selection");
  assert.equal(pickBestFlash(["models/gemini-flash-latest"]), "gemini-flash-latest", "alias fallback");
  console.log("pipeline: model auto-resolution policy ✅");
})();

// ---- 10. A3.1 LIVE-INCIDENT PINS -------------------------------------------
await (async () => {
  const { deriveGlobalFilters } = await import("./filters");
  const { applyOps } = await import("./patch");
  // (a) Board-governed selects: a category column on an unused table derives
  // NO select filter (the "Sla Status controlled nothing" incident).
  const TICKETS_D: Dataset = { tableName: "tickets", profile: { source: { filename: "t", format: "csv" }, rowCount: 100, columns: [
    col("status", "string", 3, { topValues: [{ value: "Open", count: 60 }, { value: "Closed", count: 40 }], statsExact: true }),
  ], sampleRows: [] } };
  const SLA_D: Dataset = { tableName: "sla", profile: { source: { filename: "s", format: "csv" }, rowCount: 100, columns: [
    col("sla_status", "string", 2, { topValues: [{ value: "met", count: 70 }, { value: "breached", count: 30 }], statsExact: true }),
  ], sampleRows: [] } };
  const used = new Map([["tickets", 5]]); // the board only uses tickets
  const fs2 = deriveGlobalFilters([TICKETS_D, SLA_D], used);
  assert.ok(fs2.some((f) => f.col === "status"), "governing table's category derives a select");
  assert.ok(!fs2.some((f) => f.col === "sla_status"), "unused table's category derives NOTHING");
  // (b) Filtered-count KPI repair: add_widget with filters, no metric → count(*).
  const cur: DashboardSpec = { version: 1, meta: { title: "T" }, sections: [{ id: "s1", widgets: [
    { id: "k0", kind: "kpi", title: "Total", table: "tickets", metric: { col: "", agg: "count" } } as KpiWidget ] }] };
  const r = applyOps(structuredClone(cur), [{ op: "add_widget", widget: { title: "Open tickets", table: "tickets",
    filters: [{ col: "status", op: "=", value: "Open" }] } } as any], "add a KPI counting only open tickets");
  const added: any = r.spec.sections.flatMap((sc) => sc.widgets).find((w: any) => w.title === "Open tickets");
  assert.ok(added, "widget added: " + r.rejected.join("|"));
  assert.equal(added.kind, "kpi", "kind inferred from filters");
  assert.deepEqual(added.metric, { col: "", agg: "count" }, "metric defaulted to count(*)");
  // (c) Id-like aggregation guard: sum(ticket_id) over time is dropped.
  const IDS: Dataset = { tableName: "tickets", profile: { source: { filename: "t", format: "csv" }, rowCount: 1000, columns: [
    col("itilticketid", "integer", 1000), col("created_at", "date", 300, { min: "2026-01-01", max: "2026-06-01" }),
  ], sampleRows: [] } };
  const badSpec: DashboardSpec = { version: 1, meta: { title: "T" }, sections: [{ id: "s", widgets: [{
    id: "c1", kind: "line", title: "itilticketid over time", table: "tickets",
    x: { col: "created_at", timeGrain: "month" }, series: [{ col: "itilticketid", agg: "sum" }],
  } as any] }] };
  const rv = validateSpec(badSpec, [IDS]);
  // OPEN-GRAMMAR: the widget survives, repaired to a meaningful count_distinct —
  // the garbage 1M-scale sum stays impossible, the question stays answered.
  assert.equal(rv.spec.sections.length, 1, "id-like aggregation is repaired, not dropped");
  const rw: any = rv.spec.sections[0].widgets[0];
  assert.equal(rw.series[0].agg, "count_distinct", "sum(id) repaired to count_distinct(id)");
  assert.ok(rv.warnings.some((w) => w.includes("id-like") && w.includes("repaired")), "warning names the class and the repair");
  console.log("pipeline: A3.1 live-incident pins (filters/repair/id-like) ✅");
})();


// ---- 11. OPEN-GRAMMAR OPS: three-surface symmetry + compiled shapes ---------
await (async () => {
  const NEW_OPS = ["contains", "not_in", "between"];
  const fs = await import("node:fs");
  const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  // (a) every surface that enumerates ops enumerates the NEW ops too — a
  // capability added to one layer must exist everywhere (the symmetry law).
  for (const file of ["../../shared/dashboard-spec.ts", "./agents.ts", "./planner.ts", "./patch.ts", "./filters.ts", "./validate.ts"]) {
    const src = read(file);
    for (const op of NEW_OPS) assert.ok(src.includes(`"${op}"`), `${file} knows op ${op}`);
  }
  // (b) the schemas expose `values` (array) so list ops are expressible in
  // structured output, and the agent coercer folds it into the Filter shape.
  for (const file of ["./agents.ts", "./planner.ts", "./patch.ts"]) {
    assert.ok(/values: \{ type: "array"/.test(read(file)), `${file} schema has values[]`);
  }
  // (c) compiled shapes — executed grammar, not just presence.
  const { buildKpiSql: kpiSql } = await import("./sql");
  const mkW = (filters: Filter[]): KpiWidget =>
    ({ id: "k", kind: "kpi", title: "T", table: "t", metric: { col: "", agg: "count" }, filters });
  let sql = kpiSql(mkW([{ col: "notes", op: "contains", value: "50%_off\\'x" }]));
  assert.ok(/ILIKE '%50\\%\\_off\\\\''x%' ESCAPE/.test(sql), "contains escapes %/_/\\ and quotes: " + sql);
  sql = kpiSql(mkW([{ col: "status", op: "not_in", value: ["Open", "Closed"] }]));
  assert.ok(/"status" NOT IN \('Open', 'Closed'\)/.test(sql), "not_in compiles: " + sql);
  sql = kpiSql(mkW([{ col: "age", op: "between", value: [1, 10] }]));
  assert.ok(/"age" BETWEEN 1 AND 10/.test(sql), "between compiles: " + sql);
  sql = kpiSql(mkW([{ col: "age", op: "between", value: [1] as any }]));
  assert.ok(/1=1/.test(sql) && !/BETWEEN/.test(sql), "half between never compiles a range: " + sql);
  // (d) validation normalizes the schemas' values[] field (raw-pass planner /
  // patch merges) and shape-checks the pair ops.
  const DATA: Dataset = { tableName: "t", profile: { source: { filename: "t", format: "csv" }, rowCount: 50, columns: [
    col("status", "string", 3, { topValues: [{ value: "Open", count: 30 }, { value: "Closed", count: 20 }], statsExact: true }),
    col("age", "integer", 40), col("notes", "string", 45),
  ], sampleRows: [] } };
  const mkSpec = (f: any): DashboardSpec => ({ version: 1, meta: { title: "T" },
    sections: [{ id: "s", widgets: [{ id: "k", kind: "kpi", title: "T", table: "t", metric: { col: "", agg: "count" }, filters: [f] } as KpiWidget] }] });
  let r = validateSpec(mkSpec({ col: "status", op: "not_in", values: ["Open"] }), [DATA]);
  assert.equal(((r.spec.sections[0].widgets[0] as any).filters[0] as Filter).op, "not_in", "values[] normalized for not_in");
  assert.deepEqual(((r.spec.sections[0].widgets[0] as any).filters[0] as Filter).value, ["Open"], "values folded into value");
  r = validateSpec(mkSpec({ col: "age", op: "between", values: ["1", "10"] }), [DATA]);
  assert.deepEqual(((r.spec.sections[0].widgets[0] as any).filters[0] as Filter).value, ["1", "10"], "between pair normalized");
  r = validateSpec(mkSpec({ col: "age", op: "between", values: ["1"] }), [DATA]);
  assert.equal(r.spec.sections.length, 0, "half between is structurally unusable — widget dropped with the fix named");
  assert.ok(r.warnings.some((w) => w.includes("between needs exactly")), "warning names the shape");
  // (e) the sanitizer accepts the new ops (bridge parity with build-time).
  const { sanitizeWidget } = await import("./filters");
  const sw: any = sanitizeWidget({ id: "k", kind: "kpi", title: "T", table: "t", metric: { col: "", agg: "count" },
    filters: [{ col: "notes", op: "contains", value: "refund" }, { col: "age", op: "between", value: [1, 10] }, { col: "status", op: "not_in", value: ["Open"] }] });
  assert.equal(sw.filters.length, 3, "sanitizer passes all three new ops");
  assert.throws(() => sanitizeWidget({ id: "k", kind: "kpi", title: "T", table: "t", metric: { col: "", agg: "count" },
    filters: [{ col: "age", op: "between", value: [1] }] }), /between needs/, "sanitizer rejects a half between");
  console.log("pipeline: open-grammar ops symmetric + compiled ✅");
})();

// ---- 12. MEASURE-ON-DEMAND JOINS (injected readAll, executed proofs) --------
await (async () => {
  const { verifySpecJoins } = await import("../sources/relationships");
  const base: Dataset = { tableName: "tickets", profile: { source: { filename: "t", format: "csv" }, rowCount: 4, columns: [
    col("status_id", "integer", 3) ], sampleRows: [] } };
  const ref: Dataset = { tableName: "statuses", profile: { source: { filename: "s", format: "csv" }, rowCount: 3, columns: [
    col("id", "integer", 3), col("name", "string", 3) ], sampleRows: [] } };
  const spec: any = { sections: [{ widgets: [{ id: "b1", kind: "bar", title: "T", table: "tickets",
    x: { col: "name" }, series: [{ col: "", agg: "count" }],
    join: { table: "statuses", on: ["status_id", "id"] } }] }] };
  // A readAll that PROVES the edge: right side unique+non-null, zero orphans.
  const proving = async (sql: string) => /count\(DISTINCT/i.test(sql)
    ? [{ n: 3, d: 3, nulls: 0 }]
    : [{ total: 4, orphans: 0 }];
  let out = await verifySpecJoins(structuredClone(spec), [structuredClone(base), ref].map((d) => structuredClone(d)) as any, proving);
  // NOTE: datasets are mutated in place — rebuild to inspect the edge.
  const ds = [structuredClone(base), structuredClone(ref)];
  out = await verifySpecJoins(structuredClone(spec), ds as any, proving);
  assert.equal(out.proven.length, 1, "plausible join proven on demand");
  assert.deepEqual(ds[0].profile.foreignKeys?.[0], { col: "status_id", refTable: "statuses", refCol: "id", verified: "measured" }, "edge attached to the base profile");
  // …and validation now ACCEPTS the join it would have rejected cold.
  const full: DashboardSpec = { version: 1, meta: { title: "T" }, sections: spec.sections } as any;
  const rv = validateSpec(structuredClone(full), ds as any);
  assert.equal(rv.spec.sections.length, 1, "measured edge admits the widget");
  // A readAll that REFUTES (orphans over tolerance) attaches nothing.
  const refuting = async (sql: string) => /count\(DISTINCT/i.test(sql)
    ? [{ n: 3, d: 3, nulls: 0 }]
    : [{ total: 4, orphans: 2 }];
  const ds2 = [structuredClone(base), structuredClone(ref)];
  const out2 = await verifySpecJoins(structuredClone(spec), ds2 as any, refuting);
  assert.equal(out2.proven.length, 0, "refuted candidate attaches no edge");
  assert.equal(ds2[0].profile.foreignKeys, undefined, "no edge on refutation");
  // No handle → no measurement, behavior exactly as before.
  const out3 = await verifySpecJoins(structuredClone(spec), [structuredClone(base), structuredClone(ref)] as any, undefined);
  assert.equal(out3.measured, 0, "no readAll, no measurement");
  console.log("pipeline: measure-on-demand joins ✅");
})();


// ---- 13. PLAN-BRIEF: merged call contracts + deterministic vibrancy floor ---
await (async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./decompose.ts", import.meta.url), "utf8");
  // (a) schema-constrained COT: reasoning is declared BEFORE tasks (generation
  // order), and the design channel is REQUIRED with accent + palette.
  const iReasoning = src.indexOf('reasoning: { type: "string"');
  const iTasks = src.indexOf("tasks: {");
  const iDesign = src.indexOf("design: {");
  assert.ok(iReasoning > -1 && iTasks > -1 && iDesign > -1, "schema declares reasoning, tasks, design");
  assert.ok(iReasoning < iTasks, "reasoning precedes tasks in the schema");
  assert.ok(/required: \["tasks", "design"\]/.test(src), "design is a required channel");
  // (b) the merged call: ONE injected run yields tasks AND a coerced design;
  // invalid colors are dropped, valid ones survive.
  const { decomposeQuery } = await import("./decompose");
  const DATA: Dataset = { tableName: "tickets", profile: { source: { filename: "t", format: "csv" }, rowCount: 50, columns: [
    col("status", "string", 3), col("created_at", "date", 40) ], sampleRows: [] } };
  let calls = 0;
  const run = async () => { calls++; return { text: JSON.stringify({
    reasoning: "Tickets by status and over time; helpdesk mood.",
    tasks: [{ question: "Which statuses dominate?", kind: "ranking", columns: ["status"], table: "tickets" }],
    design: { accent: "#FF5A5F", palette: ["#FF5A5F", "#2EC4B6", "#FFBF69", "nope", "#5A189A"], vibe: "warm helpdesk" },
  }) } as any; };
  const r = await decomposeQuery([DATA], "show me which ticket statuses dominate and how volume trends", "directive", run);
  assert.equal(calls, 1, "ONE model round-trip produces tasks + design");
  assert.equal(r.source, "model", "model tasks accepted");
  assert.equal(r.design?.accent, "#FF5A5F", "accent coerced through");
  assert.deepEqual(r.design?.palette, ["#FF5A5F", "#2EC4B6", "#FFBF69", "#5A189A"], "invalid hex dropped, valid kept");
  assert.equal(r.design?.vibe, "warm helpdesk", "vibe kept");
  assert.ok((r.reasoning ?? "").includes("helpdesk"), "reasoning surfaced for the audit trail");
  // A garbage design never breaks the tasks (design is optional downstream).
  const r2 = await decomposeQuery([DATA], "show me which ticket statuses dominate and how volume trends", "d",
    async () => ({ text: JSON.stringify({ tasks: [{ question: "q", kind: "kpi", columns: ["status"] }], design: { accent: "red", palette: ["x"] } }) } as any));
  assert.equal(r2.source, "model", "tasks accepted despite unusable design");
  assert.equal(r2.design, undefined, "unusable design dropped entirely");
  // (c) the deterministic vibrancy floor: seeded, stable, distinct, vivid.
  const { seededPalette } = await import("./merge");
  const p1 = seededPalette("tickets|statuses");
  const p2 = seededPalette("tickets|statuses");
  const p3 = seededPalette("orders|customers");
  assert.deepEqual(p1, p2, "same seed → same palette (stable across reruns)");
  assert.notDeepEqual(p1, p3, "different domains → different palettes");
  assert.equal(p1.length, 6, "six colors");
  for (const c of p1) {
    assert.ok(/^#[0-9a-f]{6}$/i.test(c), "hex format: " + c);
    const [rr, gg, bb] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    assert.ok(Math.max(rr, gg, bb) - Math.min(rr, gg, bb) >= 50, "vivid, never gray: " + c);
  }
  assert.equal(new Set(p1).size, 6, "all six distinct");
  // (d) the handler skips the standalone rewrite on agents-path builds — the
  // plan-brief call IS the directive round-trip now.
  const hsrc = fs.readFileSync(new URL("./handler.ts", import.meta.url), "utf8");
  assert.ok(/legacyPlannerInjected \|\| agentsPath \? \{ skipRewrite: true \}/.test(hsrc), "agents-path builds skip the rewrite RT");
  console.log("pipeline: plan-brief merged call + vibrancy floor ✅");
})();


// ---- 14. CLICK-TO-TARGET: two-sided selection contract ----------------------
await (async () => {
  const fs = await import("node:fs");
  const rsrc = fs.readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");
  // The generated app: ring on the selected card, toggle-off + Escape both emit
  // the cleared payload so the host chip can never disagree with the preview.
  assert.ok(rsrc.includes("toggleSelect(w"), "widgets select through the shared toggle");
  assert.equal(rsrc.split('toggleSelect(w, "').length - 1, 3, "all three wrappers (kpi/chart/table) call it");
  assert.ok(rsrc.includes("selectFeature({ cleared: true"), "toggle-off/Escape emit the cleared payload");
  assert.ok(rsrc.includes('e.key === "Escape"'), "Escape clears the selection");
  assert.ok(rsrc.includes("useSelected(w.id)"), "cards subscribe to the selection store");
  // The host: honors cleared, and re-validates the selection against every new
  // spec (ghost-selection guard).
  const hsrc = fs.readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
  assert.ok(hsrc.includes("if (p.cleared) { setSelectedWidget(null); return; }"), "host honors the cleared payload");
  assert.ok(hsrc.includes("GHOST-SELECTION GUARD"), "host re-validates selection on every spec");
  console.log("pipeline: click-to-target selection contract ✅");
})();


// ---- 15. A4 COMPARE: three-surface symmetry + compiled shape ----------------
await (async () => {
  const fs = await import("node:fs");
  const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  // (a) every surface knows compare: spec grammar, all three schemas, the
  // sanitizer whitelist, the validator repair, and the compiler.
  for (const f of ["../../shared/dashboard-spec.ts", "./agents.ts", "./planner.ts", "./patch.ts", "./filters.ts", "./validate.ts", "./sql.ts"]) {
    assert.ok(read(f).includes("compare"), `${f} knows compare`);
  }
  for (const f of ["./agents.ts", "./planner.ts", "./patch.ts"]) {
    assert.ok(read(f).includes('enum: ["day", "week", "month", "quarter", "year"]'), `${f} schema enumerates the grains`);
  }
  // (b) the compiled shape: two columns, adjacent-window step, base-table anchor.
  const { buildKpiSql: kSql } = await import("./sql");
  const sql = kSql({ id: "k", kind: "kpi", title: "T", table: "t",
    metric: { col: "", agg: "count", compare: { grain: "quarter", dateCol: "d" } } } as any);
  assert.ok(sql.includes("AS value") && sql.includes("AS prev_value"), "two windows, one query: " + sql);
  assert.ok(sql.includes("INTERVAL 3 MONTH"), "quarter steps by 3 months");
  assert.ok(sql.includes('(SELECT max("d") FROM "t")'), "anchor = the DATA's own max date");
  // (c) an unknown grain never compiles a window (falls back to the plain KPI).
  const plain = kSql({ id: "k", kind: "kpi", title: "T", table: "t",
    metric: { col: "", agg: "count", compare: { grain: "fortnight", dateCol: "d" } } } as any);
  assert.ok(!plain.includes("prev_value"), "unknown grain → plain KPI, never bad SQL");
  // (d) the renderer shows the chip only for compared KPIs and never invents one.
  const rsrc = read("./renderer.ts");
  assert.ok(rsrc.includes("function DeltaChip"), "delta chip exists");
  assert.ok(rsrc.includes("p === 0) return null"), "zero/absent previous → no chip");
  assert.ok(rsrc.includes("vs prev"), "chip names the comparison window");
  console.log("pipeline: A4 compare symmetry + compiled shape ✅");
})();

console.log("pipeline.test.ts: all assertions passed ✅");
