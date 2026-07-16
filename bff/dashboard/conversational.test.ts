// bff/dashboard/conversational.test.ts — run with: npm run test:conversational
// Covers the v7 conversational-build layers: style sanitization in the spec
// planner, human change summaries, theming reaching the rendered app, and the
// orchestrator's respond intent + follow-up gate (all with fake model runners).
import assert from "node:assert";
import { planSpec } from "./planner";
import { summarizeSpecChange, briefToStyleHints, handleDashboardBuild } from "./handler";
import { renderPlanToApp } from "./renderer";
import { orchestrate, gateTurn } from "../orchestrator";
import type { DashboardSpec } from "../../shared/dashboard-spec";

const fake = (obj: unknown) => async () => ({ text: JSON.stringify(obj), finishReason: "STOP" } as any);

const datasets = [{
  tableName: "orders",
  profile: {
    source: { filename: "x", format: "json" }, rowCount: 10,
    columns: [{ name: "region", type: "string" } as any, { name: "revenue", type: "number" } as any],
    sampleRows: [{ region: "EMEA", revenue: 5 }],
  },
} as any];

// NOTE (al5): these fixtures use the REAL widget shapes from shared/dashboard-spec
// (flat chart kinds: "bar"/"line"/…, Metric.col, Dimension.col). They previously
// used an invented {kind:"chart", chart:"bar"} shape cast through `as any`, which
// let a broken coverage check pass its tests for months while never once firing
// in production. Fixtures must mirror the type, or they test a fantasy.
const specBody = (meta: any): any => ({
  meta,
  sections: [{ title: "Main", widgets: [{ id: "w1", kind: "kpi", title: "Total revenue", metric: { agg: "sum", col: "revenue" }, table: "orders" }] }],
});

// ---- planner sanitizes style fields deterministically -----------------------------
{
  const spec = await planSpec(
    { datasets, userPrompt: "make it teal" },
    fake(specBody({ title: "T", theme: "dark", accent: "#0d9488", chartPalette: ["#0d9488", "not-a-color", "#5eead4", "javascript:alert(1)"] })),
  );
  assert.ok(spec, "spec produced");
  assert.equal(spec!.meta.theme, "dark");
  assert.equal(spec!.meta.accent, "#0d9488", "valid accent kept");
  assert.deepEqual(spec!.meta.chartPalette, ["#0d9488", "#5eead4"], "invalid palette entries dropped");
}
{
  const spec = await planSpec({ datasets, userPrompt: "x" }, fake(specBody({ title: "T", accent: "red" })));
  assert.equal(spec!.meta.accent, undefined, "non-hex accent dropped");
}
console.log("style sanitization ✅");

// ---- change summaries are human, not title echoes -----------------------------------
{
  const a: DashboardSpec = specBody({ title: "Sales", theme: "light" });
  const first = summarizeSpecChange(undefined, a);
  assert.ok(first[0].includes("Built “Sales”") && first[0].includes("1 widget"), first[0]);

  const b: DashboardSpec = specBody({ title: "Sales", theme: "dark", accent: "#0d9488", chartPalette: ["#0d9488", "#5eead4"] });
  b.sections[0].widgets.push({ id: "w2", kind: "bar", title: "Revenue by region", table: "orders", x: { col: "region" }, series: [{ agg: "sum", col: "revenue" }] } as any);
  const diff = summarizeSpecChange(a, b);
  const joined = diff.join(" ");
  assert.ok(joined.includes("dark theme"), joined);
  assert.ok(joined.includes("#0d9488"), joined);
  assert.ok(joined.includes("2-color chart palette"), joined);
  assert.ok(joined.includes("Added") && joined.includes("Revenue by region"), joined);

  const same = summarizeSpecChange(b, b);
  assert.deepEqual(same, ["Updated the dashboard."], "no-op edit still replies humanly");
}
console.log("change summaries ✅");

// ---- brief -> style hints -------------------------------------------------------------
{
  const h = briefToStyleHints({ palette: { primary: "#123456", accent: "#654321", vibe: "vibrant" }, designDirection: "dense, bold" });
  assert.ok(h && h.includes("#123456") && h.includes("vibe: vibrant") && h.includes("dense, bold"), String(h));
  assert.equal(briefToStyleHints(undefined), null);
  assert.equal(briefToStyleHints({}), null);
}
console.log("brief→styleHints ✅");

// ---- al5: the handler returns the spec that ACTUALLY RENDERED ----------------------
// Before: it returned the raw planner spec, so the summary counted widgets that
// validation had dropped ("5 widgets" for a 4-widget board) and the client
// persisted ghost widgets as currentSpec — the next edit turn then reasoned
// about widgets that were not on screen.
{
  const ds = [{
    tableName: "orders",
    profile: {
      source: { filename: "x", format: "json" }, rowCount: 10,
      columns: [{ name: "region", type: "string" } as any, { name: "revenue", type: "number" } as any],
      sampleRows: [{ region: "EMEA", revenue: 5 }],
    },
  } as any];
  const ghosty = async () => ({
    version: 1,
    meta: { title: "T" },
    sections: [{ id: "s1", title: "Main", widgets: [
      { id: "w1", kind: "kpi", title: "Total revenue", table: "orders", metric: { agg: "sum", col: "revenue" } },
      // references a column that does not exist -> validation MUST drop it
      { id: "w2", kind: "bar", title: "By ghost", table: "orders", x: { col: "not_a_column" }, series: [{ agg: "sum", col: "revenue" }] },
    ] }],
  } as any);
  const { status, body } = await handleDashboardBuild(
    { datasets: ds, userPrompt: "x", analystDirective: "d" },
    ghosty as any,
  );
  assert.equal(status, 200);
  const returned = body.spec.sections.flatMap((x: any) => x.widgets);
  assert.equal(returned.length, 1, "returned spec contains ONLY what rendered");
  assert.equal(returned[0].id, "w1");
  assert.ok(body.warnings.length >= 1, "the drop is reported, not silent");
  assert.ok(body.summary.join(" ").includes("1 widget"), `summary must not claim dropped widgets: ${body.summary.join(" ")}`);
}
console.log("validated spec returned (no ghost widgets) ✅");

// ---- theming reaches the generated app ---------------------------------------------
{
  const plan: any = { meta: { title: "T", theme: "dark", accent: "#0d9488", chartPalette: ["#0d9488"] }, sections: [], warnings: [] };
  const app = renderPlanToApp(plan);
  const src = app.files[0].content;
  for (const needle of ["const ACCENT", "PLAN.meta.chartPalette", "CARD_CLS", "bg-slate-950"]) {
    assert.ok(src.includes(needle), `generated app missing ${needle}`);
  }
  assert.ok(!src.includes(`const COLORS = ["#4f46e5"`), "hardcoded palette replaced");
}
console.log("renderer theming ✅");

// ---- orchestrator: respond beats build ------------------------------------------------
{
  const r = await orchestrate({ datasets, userPrompt: "which region sold most?" },
    fake({ respond: true, reply: "EMEA leads in the sample, but let me check the full data.", dataQuestion: true,
           outputMode: "dashboard", title: "x", kpis: [], charts: [], palette: { primary: "#111111", accent: "#222222", vibe: "calm" }, designDirection: "d", enhancedPrompt: "e" }));
  assert.ok(r && "respond" in r, "respond turn returned");
  assert.equal((r as any).dataQuestion, true);
}
console.log("orchestrator respond ✅");

// ---- follow-up gate ---------------------------------------------------------------------
{
  const q = await gateTurn({ userPrompt: "which month peaked?", artifactKind: "dashboard" },
    fake({ action: "question", reply: "Let me look that up.", dataQuestion: true }));
  assert.equal(q?.action, "question");
  assert.equal(q?.dataQuestion, true);

  const e = await gateTurn({ userPrompt: "make the bars teal", artifactKind: "dashboard" }, fake({ action: "edit" }));
  assert.equal(e?.action, "edit");

  const junk = await gateTurn({ userPrompt: "x", artifactKind: "dashboard" }, fake({ action: "detonate" }));
  assert.equal(junk, null, "unknown action → null → caller defaults to edit");

  const emptyReply = await gateTurn({ userPrompt: "hi", artifactKind: "dashboard" }, fake({ action: "chat" }));
  assert.equal(emptyReply?.action, "edit", "reply-less chat degrades to edit, never a dead end");

  const down = await gateTurn({ userPrompt: "x", artifactKind: "dashboard" }, async () => { throw new Error("down"); });
  assert.equal(down, null, "model failure → null → edit");
}
console.log("follow-up gate ✅");

console.log("conversational.test.ts: all assertions passed ✅");

// ---- v8/qe1: query rewriter + house-style enforcement --------------------------------
{
  const { rewritePrompt } = await import("./planner");
  const { briefToAnalyticalDirective, coverageShortfalls } = await import("./handler");

  // rewriter: grounded output passes through; garbage/failure -> null (never blocks)
  const good = await rewritePrompt({ datasets, userPrompt: "sales dashboard" },
    async () => ({ text: "Aggregate sum of revenue as the headline KPI. Break revenue down by region as a bar chart ranking regions. Trend revenue by month as a line chart. Show region composition as a pie. Compare average revenue per region as an area or bar.", finishReason: "STOP" } as any));
  assert.ok(good && good.includes("revenue") && good.includes("region"), String(good));
  assert.equal(await rewritePrompt({ datasets, userPrompt: "x" }, async () => ({ text: "ok", finishReason: "STOP" } as any)), null, "too-short rewrite rejected");
  assert.equal(await rewritePrompt({ datasets, userPrompt: "x" }, async () => { throw new Error("down"); }), null, "failure -> null, never throws");

  // brief -> analytical directive (first builds get content for free)
  const d = briefToAnalyticalDirective({ kpis: ["total revenue", "orders count"], charts: [{ type: "bar", x: "region", y: "revenue", why: "ranking" }], enhancedPrompt: "Focus on regional performance." });
  assert.ok(d && d.includes("total revenue") && d.includes("bar of revenue by region") && d.includes("regional performance"), String(d));
  assert.equal(briefToAnalyticalDirective(null), null);

  // coverage: rich data demands 4 charts / 3 types / 3 KPIs; thin data scales down
  const rich = [{ tableName: "t", profile: { source: { filename: "x", format: "json" }, rowCount: 9, columns: Array.from({ length: 8 }, (_, i) => ({ name: "c" + i, type: "number" })), sampleRows: [] } } as any];
  const spec1: any = { meta: { title: "T" }, sections: [{ title: "S", widgets: [
    { id: "k1", kind: "kpi", title: "A" },
    { id: "c1", kind: "bar", title: "B" },
    { id: "c2", kind: "bar", title: "C" },
  ] }] };
  const s1 = coverageShortfalls(spec1, rich);
  assert.ok(s1.some((x) => x.includes("chart(s), need at least 4")), s1.join(";"));
  assert.ok(s1.some((x) => x.includes("KPI")), s1.join(";"));
  const spec2: any = { meta: { title: "T" }, sections: [{ title: "S", widgets: [
    { id: "k1", kind: "kpi", title: "A" }, { id: "k2", kind: "kpi", title: "B" }, { id: "k3", kind: "kpi", title: "C" },
    { id: "c1", kind: "bar", title: "1" }, { id: "c2", kind: "line", title: "2" },
    { id: "c3", kind: "pie", title: "3" }, { id: "c4", kind: "area", title: "4" },
  ] }] };
  assert.deepEqual(coverageShortfalls(spec2, rich), [], "compliant spec has no shortfalls");
  const thin = [{ tableName: "t", profile: { source: { filename: "x", format: "json" }, rowCount: 3, columns: [{ name: "v", type: "number" }], sampleRows: [] } } as any];
  const s3 = coverageShortfalls(spec1, thin);
  assert.ok(!s3.some((x) => x.includes("need at least 4")), "thin data never demands padding: " + s3.join(";"));

  // al5 REGRESSION: the gate must count the kinds the PLANNER SCHEMA actually
  // emits. The old filter tested `kind === "chart"` — a kind no widget ever has —
  // so every real build reported "0 charts", burned a re-plan, and shipped
  // KPI-only dashboards. Guard the real enum, and guard that a KPI-only board
  // is flagged (it is the failure the user actually saw on screen).
  const CHART_ENUM = ["line", "bar", "area", "pie", "donut"];
  for (const kind of CHART_ENUM) {
    const one: any = { meta: { title: "T" }, sections: [{ title: "S", widgets: [{ id: "c", kind, title: "x" }] }] };
    const gaps = coverageShortfalls(one, rich);
    assert.ok(!gaps.some((x) => x.includes("only 0 chart(s)")), `kind "${kind}" must count as a chart, got: ${gaps.join(";")}`);
  }
  const kpiOnly: any = { meta: { title: "T" }, sections: [{ title: "S", widgets: [
    { id: "k1", kind: "kpi", title: "A" }, { id: "k2", kind: "kpi", title: "B" },
    { id: "k3", kind: "kpi", title: "C" }, { id: "k4", kind: "kpi", title: "D" },
  ] }] };
  const kpiGaps = coverageShortfalls(kpiOnly, rich);
  assert.ok(kpiGaps.some((x) => x.includes("only 0 chart(s)")), `a KPI-only dashboard MUST be flagged: ${kpiGaps.join(";")}`);
  // chart-type diversity reads the widget kind (it used to read a phantom `.chart`).
  const sameType: any = { meta: { title: "T" }, sections: [{ title: "S", widgets: [
    { id: "k1", kind: "kpi", title: "A" }, { id: "k2", kind: "kpi", title: "B" }, { id: "k3", kind: "kpi", title: "C" },
    { id: "c1", kind: "bar", title: "1" }, { id: "c2", kind: "bar", title: "2" },
    { id: "c3", kind: "bar", title: "3" }, { id: "c4", kind: "bar", title: "4" },
  ] }] };
  assert.ok(coverageShortfalls(sameType, rich).some((x) => x.includes("chart type(s)")), "4 bars is not 3 types");
}
console.log("query rewriter + house style ✅");
