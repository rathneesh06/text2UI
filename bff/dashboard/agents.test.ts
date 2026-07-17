// bff/dashboard/agents.test.ts — run with: npm run test:agents
// Covers the restored text2UI pipeline layers:
//   1. the query enhancement layer is ALWAYS on (tiny data, tiny prompt, no model),
//   2. the specialist widget agents (kpi/bar/line/pie/table) parse model output,
//   3. every agent degrades to its deterministic fallback when the model fails,
//   4. the merger dedupes and assembles a coherent sectioned spec,
//   5. handleDashboardBuild runs the full agents path end-to-end offline.
import assert from "node:assert";
import { baselineInstructions, classifySchema, enhanceQuery } from "./enhance";
import { runChartAgents, fallbackKpis, fallbackLines } from "./agents";
import { mergeHarvest, widgetSignature, deriveTitle } from "./merge";
import { handleDashboardBuild } from "./handler";
import type { Dataset } from "../../shared/types";

const col = (name: string, type: string, uniqueCount: number, extra: object = {}) =>
  ({ name, type, uniqueCount, nullable: false, sampleValues: [], ...extra } as any);

const orders: Dataset[] = [{
  tableName: "orders",
  profile: {
    source: { filename: "orders.csv", format: "csv" }, rowCount: 1000,
    columns: [
      col("order_id", "integer", 1000),
      col("region", "string", 4),
      col("status", "string", 3),
      col("revenue", "number", 800),
      col("created_at", "date", 900, { min: "2024-01-01", max: "2025-06-30" }),
    ],
    sampleRows: [{ order_id: 1, region: "EMEA", status: "paid", revenue: 12.5, created_at: "2024-01-01" }],
  },
} as any];

// One column, three-word prompt — the layer must still produce full instructions.
const tiny: Dataset[] = [{
  tableName: "t",
  profile: { source: { filename: "t.csv", format: "csv" }, rowCount: 3, columns: [col("v", "number", 3)], sampleRows: [{ v: 1 }] },
} as any];

const fake = (obj: unknown) => async () => ({ text: JSON.stringify(obj), finishReason: "STOP" } as any);
const failing = async () => { throw new Error("model down"); };

// ---- 1. enhancement layer: baseline is total and size-independent -----------------
{
  const roles = classifySchema(orders);
  assert.equal(roles.measures.length, 1, "revenue is the measure");
  assert.equal(roles.measures[0].col.name, "revenue");
  assert.equal(roles.temporals[0].col.name, "created_at");
  assert.equal(roles.temporals[0].suggestedGrain, "month", "18-month span → month grain");
  assert.ok(roles.dimensions.some((d) => d.col.name === "region"));
  assert.ok(roles.identifiers.some((r) => r.col.name === "order_id"), "order_id classified as identifier, not measure");

  const big = baselineInstructions(orders, "make a sales dashboard");
  for (const needle of ["BASELINE INSTRUCTIONS", "Measures", "orders.revenue", "Temporal", "grain: month", "Dimensions", "region [4]", "count_distinct"]) {
    assert.ok(big.includes(needle), `baseline missing: ${needle}`);
  }

  const small = baselineInstructions(tiny, "dash");
  assert.ok(small.includes("BASELINE INSTRUCTIONS"), "baseline present for tiny data");
  assert.ok(small.includes("do NOT plan line/area"), "tiny data: trend rule stated");
  assert.ok(small.includes("request is brief"), "terse prompt gets the confidence rule");
  assert.ok(small.length > 300, "instructions are complete regardless of size");

  const e = await enhanceQuery({ datasets: tiny, userPrompt: "dash", skipRewrite: true });
  assert.equal(e.directiveSource, "none");
  assert.ok(e.combined.length > 300, "combined never empty even with no directive at all");

  const e2 = await enhanceQuery({ datasets: orders, userPrompt: "x", analystDirective: "ANALYSIS: total revenue = 500", skipRewrite: true });
  assert.ok(e2.combined.startsWith("ANALYSIS:"), "analyst directive leads");
  assert.ok(e2.combined.includes("BASELINE INSTRUCTIONS"), "…but the baseline is still attached");
}
console.log("enhancement layer: always-on baseline ✅");

// ---- 2. agents parse model output; inapplicable agents are skipped ----------------
{
  const perAgent = (system: string) => {
    if (system.includes("KPI-card agent")) return { widgets: [{ title: "Total revenue", table: "orders", metric: { col: "revenue", agg: "sum", format: "currency" } }] };
    if (system.includes("bar-chart agent")) return { widgets: [{ title: "Revenue by region", table: "orders", x: { col: "region" }, series: [{ col: "revenue", agg: "sum" }], kind: "bar" }] };
    if (system.includes("trend-chart agent")) return { widgets: [{ title: "Revenue over time", table: "orders", x: { col: "created_at", timeGrain: "month" }, series: [{ col: "revenue", agg: "sum" }], kind: "line" }] };
    if (system.includes("composition-chart agent")) return { widgets: [{ title: "Share by status", table: "orders", x: { col: "status" }, series: [{ col: "revenue", agg: "sum" }, { col: "revenue", agg: "avg" }], kind: "pie" }] };
    return { widgets: [{ title: "Region summary", table: "orders", columns: [{ col: "region" }, { col: "revenue", agg: "sum" }], groupBy: [{ col: "region" }], limit: 10 }] };
  };
  const run = async (system: string) => ({ text: JSON.stringify(perAgent(system)), finishReason: "STOP" } as any);
  const h = await runChartAgents({ datasets: orders, userPrompt: "sales dashboard", directive: "d" }, run, 2000);
  assert.equal(h.kpis.length, 1);
  assert.equal(h.bars[0].kind, "bar");
  assert.equal(h.trends[0].x.timeGrain, "month");
  assert.equal(h.compositions[0].series.length, 1, "pie trimmed to one series");
  assert.equal(h.tables[0].limit, 10);
  assert.ok(h.reports.every((r) => r.source === "model" || r.count > 0));

  // No temporal column → the line agent must be SKIPPED, not fall back to garbage.
  const h2 = await runChartAgents({ datasets: tiny, userPrompt: "x", directive: "d" }, fake({ widgets: [] }), 500);
  assert.equal(h2.trends.length, 0);
  assert.equal(h2.reports.find((r) => r.name === "line")!.source, "skipped");
}
console.log("specialist agents: model path + applicability ✅");

// ---- 3. every agent survives a total model outage via deterministic fallbacks -----
{
  const h = await runChartAgents({ datasets: orders, userPrompt: "sales dashboard", directive: "d" }, failing as any, 1500);
  assert.ok(h.kpis.length >= 3, `fallback KPIs (got ${h.kpis.length})`);
  assert.equal(h.bars.length, 1, "fallback bar");
  assert.equal(h.trends.length, 1, "fallback line");
  assert.equal(h.trends[0].x.timeGrain, "month");
  assert.equal(h.compositions.length, 1, "fallback donut");
  assert.equal(h.tables.length, 1, "fallback table");
  assert.ok(h.reports.every((r) => r.source === "fallback"), "all agents report fallback");

  const kpis = fallbackKpis(orders, classifySchema(orders));
  assert.ok(kpis.some((k) => k.metric.agg === "count_distinct" && k.metric.col === "order_id"), "identifier → count_distinct KPI");
  assert.equal(fallbackLines(tiny, classifySchema(tiny)).length, 0, "no date column → no trend fallback");
}
console.log("specialist agents: deterministic fallbacks ✅");

// ---- 4. merge: dedupe, sections, caps, title -----------------------------------------
{
  const h = await runChartAgents({ datasets: orders, userPrompt: "x", directive: "d" }, failing as any, 1000);
  // Inject a duplicate of the bar chart under a different title — signature must catch it.
  h.bars.push({ ...h.bars[0], id: "dup", title: "Same question, new name" });
  assert.equal(widgetSignature(h.bars[0]), widgetSignature(h.bars[1]));
  const spec = mergeHarvest(h, orders, "sales performance dashboard");
  const widgets = spec.sections.flatMap((s) => s.widgets);
  assert.equal(widgets.filter((w: any) => w.title === "Same question, new name").length, 0, "duplicate merged away");
  assert.deepEqual(spec.sections.map((s) => s.id), ["s_kpis", "s_trends", "s_breakdowns", "s_details"]);
  assert.ok(spec.meta.chartPalette!.length >= 5, "vibrant palette by default");
  assert.equal(spec.meta.title, "Sales performance dashboard");
  assert.equal(deriveTitle("please analyze everything about my very long request. it goes on.", orders), "Orders Dashboard");
}
console.log("merge: dedupe + sections + defaults ✅");

// ---- 5. handleDashboardBuild end-to-end on the agents path (fully offline) --------
{
  const run = async (system: string) => {
    if (system.includes("KPI-card agent")) return { text: JSON.stringify({ widgets: [
      { title: "Total revenue", table: "orders", metric: { col: "revenue", agg: "sum", format: "currency" } },
      { title: "Orders", table: "orders", metric: { col: "order_id", agg: "count_distinct", format: "compact" } },
      { title: "Ghost", table: "orders", metric: { col: "not_a_column", agg: "sum" } }, // validation must drop
    ] }), finishReason: "STOP" } as any;
    return { text: JSON.stringify({ widgets: [] }), finishReason: "STOP" } as any; // others → fallbacks
  };
  const { status, body } = await handleDashboardBuild(
    { datasets: orders, userPrompt: "sales dashboard", analystDirective: "ANALYSIS: revenue concentrated in EMEA" },
    { agentRun: run as any, skipRewrite: true },
  );
  assert.equal(status, 200);
  assert.equal(body.pipeline, "agents");
  const widgets = body.spec.sections.flatMap((s: any) => s.widgets);
  assert.ok(!widgets.some((w: any) => w.title === "Ghost"), "invalid column dropped by validation");
  assert.ok(widgets.filter((w: any) => w.kind === "kpi").length >= 2);
  const kinds = new Set(widgets.map((w: any) => w.kind));
  assert.ok(["bar", "line", "donut"].every((k) => kinds.has(k)), `fallback charts present (${[...kinds].join(",")})`);
  assert.ok(body.app?.files?.length, "a runnable app was rendered");
  assert.ok(body.spec.meta.accent, "accent guaranteed");
  assert.ok(String(body.summary?.[0] ?? "").includes("Built"), "human summary");
}
console.log("handler: agents path end-to-end ✅");

// ---- edit turns still take the surgical single-planner path -----------------------
{
  let plannerCalls = 0;
  const planner = async (input: any) => {
    plannerCalls++;
    assert.ok(input.directive?.includes("BASELINE INSTRUCTIONS"), "edit turn still receives the baseline");
    assert.ok(input.currentSpec, "edit turn receives the current spec");
    return input.currentSpec;
  };
  const currentSpec = {
    version: 1, meta: { title: "Sales", theme: "light" },
    sections: [{ id: "s1", widgets: [{ id: "w1", kind: "kpi", title: "Total revenue", table: "orders", metric: { col: "revenue", agg: "sum" } }] }],
  } as any;
  const { status, body } = await handleDashboardBuild(
    { datasets: orders, userPrompt: "make it dark", currentSpec },
    { planner: planner as any, skipRewrite: true },
  );
  assert.equal(status, 200);
  assert.equal(plannerCalls, 1, "edits do NOT fan out to the agents");
  assert.equal(body.pipeline, "planner");
}
console.log("handler: edit turns stay surgical ✅");


// ---- layout: no row ships unfilled; orphans rebalance --------------------------------
{
  const { balanceSection, packRows } = await import("./layout");
  const chart = (id: string): any => ({ id, kind: "bar", title: id, table: "orders", x: { col: "region" }, series: [{ col: "revenue", agg: "sum" }], width: "half" });
  const kpi = (id: string): any => ({ id, kind: "kpi", title: id, table: "orders", metric: { col: "revenue", agg: "sum" }, width: "quarter" });

  // 3 half-width charts: the old layout left the third floating beside white space.
  const s1 = balanceSection({ id: "s", widgets: [chart("a"), chart("b"), chart("c")] } as any);
  assert.deepEqual(s1.widgets.map((w: any) => w.width), ["half", "half", "full"], "orphan chart expands to full");

  // 5 KPIs: 4+1 rebalances to 3+2 (thirds then halves), every row sums to 12.
  const s2 = balanceSection({ id: "s", widgets: [kpi("1"), kpi("2"), kpi("3"), kpi("4"), kpi("5")] } as any);
  assert.deepEqual(s2.widgets.map((w: any) => w.width), ["third", "third", "third", "half", "half"], "5 KPIs → 3+2");

  // Full rows are left alone; a lone table stays full.
  const s3 = balanceSection({ id: "s", widgets: [kpi("1"), kpi("2"), kpi("3"), kpi("4")] } as any);
  assert.ok(s3.widgets.every((w: any) => w.width === "quarter"), "full quarter row untouched");
  assert.equal(packRows([{ kind: "table", id: "t", title: "t", table: "orders", columns: [{ col: "region" }] } as any]).length, 1);

  // Through compileSpec: validation drops one of a pair → the survivor fills the row.
  const { compileSpec } = await import("./compile");
  const spec: any = {
    version: 1, meta: { title: "T" },
    sections: [{ id: "s", widgets: [chart("keep"), { ...chart("drop"), x: { col: "not_a_column" } }] }],
  };
  const plan = compileSpec(spec, orders);
  assert.equal(plan.spec.sections[0].widgets.length, 1);
  assert.equal((plan.spec.sections[0].widgets[0] as any).width, "full", "post-validation survivor expands");
}
console.log("layout: rows always filled ✅");

// ---- renderer: compact mode + display polish -----------------------------------------
{
  const { renderPlanToApp } = await import("./renderer");
  const mkPlan = (n: number): any => ({
    meta: { title: "T" },
    sections: [{ id: "s", widgets: Array.from({ length: n }, (_, i) => ({ widget: { id: `k${i}`, kind: "kpi", title: "t", table: "orders", metric: { col: "revenue", agg: "sum" } }, sql: "select 1 as value" })) }],
    warnings: [], spec: {},
  });
  const src = renderPlanToApp(mkPlan(3)).files[0].content;
  for (const needle of ["const COMPACT = N_WIDGETS <= 7", "CHART_H = COMPACT ? 165 : 210", "PIE_R", "function prettyHeader"]) {
    assert.ok(src.includes(needle), `renderer missing: ${needle}`);
  }
  // The generated helpers must WORK, not just exist (escaping inside the template
  // literal burned us once — fmtX's date regex shipped broken for months).
  const fx = new Function("v", src.match(/function fmtX\(v\) \{([\s\S]*?)\n\}/)![1]);
  assert.equal(fx("2024-03-01T00:00:00.000Z"), "2024-03-01", "ISO timestamps trim to dates");
  assert.equal(fx("EMEA"), "EMEA");
  const ph = new Function("h", src.match(/function prettyHeader\(h\) \{([\s\S]*?)\n\}/)![1]);
  assert.equal(ph("TOTAL_TICKETS_0"), "TOTAL TICKETS", "SQL alias suffix stripped");
  assert.equal(ph("AVERAGE_AGE_HOURS__1"), "AVERAGE AGE HOURS");
  assert.equal(ph("PRIORITY"), "PRIORITY");
}
console.log("renderer: compact mode + header/date polish ✅");

// ---- chat↔dashboard connection: session, undo/redo, context, selection ---------------
{
  const { pushVersion, undo, redo, detectHistoryIntent, decisionsText, versionCount, resetSession } = await import("./session");
  const conv = "test_conv_1";
  resetSession(conv);
  const specV = (title: string): any => ({ version: 1, meta: { title },
    sections: [{ id: "s", widgets: [{ id: "w1", kind: "kpi", title: "Total revenue", table: "orders", metric: { col: "revenue", agg: "sum" } }] }] });

  // Version stack semantics: push → undo → redo; edit-after-undo truncates redo.
  pushVersion(conv, specV("V1"), "Built V1", "sales dashboard");
  pushVersion(conv, specV("V2"), "Made it dark", "make it dark");
  pushVersion(conv, specV("V3"), "Added a chart", "add a trend chart");
  assert.equal(versionCount(conv), 3);
  assert.equal(undo(conv)!.spec.meta.title, "V2");
  assert.equal(undo(conv)!.spec.meta.title, "V1");
  assert.equal(undo(conv), null, "bottom of the stack");
  assert.equal(redo(conv)!.spec.meta.title, "V2");
  pushVersion(conv, specV("V2b"), "Renamed", "rename it");   // truncates the V3 branch
  assert.equal(redo(conv), null, "redo branch truncated by a new edit");
  assert.ok(decisionsText(conv)!.includes("make it dark"), "decisions accumulate");

  // Intent detection: bare commands only — content-bearing prompts stay edits.
  assert.equal(detectHistoryIntent("undo"), "undo");
  assert.equal(detectHistoryIntent("Undo that."), "undo");
  assert.equal(detectHistoryIntent("go back"), "undo");
  assert.equal(detectHistoryIntent("redo"), "redo");
  assert.equal(detectHistoryIntent("undo the color change but keep the new chart"), null);
  assert.equal(detectHistoryIntent("make it darker"), null);
  resetSession(conv);
}
console.log("session: version stack + history intents ✅");

{
  const { pushVersion, resetSession } = await import("./session");
  const conv = "test_conv_2";
  resetSession(conv);
  const mkSpec = (title: string): any => ({ version: 1, meta: { title },
    sections: [{ id: "s", widgets: [{ id: "w1", kind: "kpi", title: "Total revenue", table: "orders", metric: { col: "revenue", agg: "sum" } }] }] });

  // The edit planner receives conversation context + the selected widget.
  let captured: any = null;
  const planner = async (input: any) => { captured = input; return input.currentSpec; };
  const history = [
    { role: "user", content: "sales dashboard" },
    { role: "assistant", content: "Built \u201cSales\u201d \u2014 5 widgets." },
    { role: "user", content: "make the bars teal" },
  ];
  pushVersion(conv, mkSpec("Sales v1"), "Built", "sales dashboard");
  const r1 = await handleDashboardBuild(
    { datasets: orders, userPrompt: "make this a donut", currentSpec: mkSpec("Sales v1"),
      conversationId: conv, history, selectedWidget: { id: "w1", title: "Total revenue" } },
    { planner: planner as any, skipRewrite: true },
  );
  assert.equal(r1.status, 200);
  assert.ok(captured.chatContext.includes("make the bars teal"), "recent turns reach the planner");
  assert.ok(captured.chatContext.includes("DECISIONS SO FAR"), "rolling decisions reach the planner");
  assert.equal(captured.selectedWidget.id, "w1", "the clicked widget reaches the planner");

  // Accepted edits enter the version stack -> a later bare "undo" restores V1 with no model call.
  let plannerCalls = 0;
  const counting = async (input: any) => { plannerCalls++; return input.currentSpec; };
  const r2 = await handleDashboardBuild(
    { datasets: orders, userPrompt: "undo", currentSpec: mkSpec("Sales v2"), conversationId: conv },
    { planner: counting as any, skipRewrite: true },
  );
  assert.equal(r2.status, 200);
  assert.equal(plannerCalls, 0, "undo is deterministic — no model call");
  assert.equal(r2.body.pipeline, "history");
  assert.equal(r2.body.spec.meta.title, "Sales v1", "previous version restored");
  assert.ok(r2.body.app?.files?.length, "restored version re-rendered");
  assert.ok(r2.body.summary[0].includes("Reverted"), r2.body.summary[0]);

  // Undo with nothing earlier: friendly no-op, canvas untouched.
  const r3 = await handleDashboardBuild(
    { datasets: orders, userPrompt: "undo", currentSpec: mkSpec("Sales v1"), conversationId: conv },
    { planner: counting as any, skipRewrite: true },
  );
  assert.equal(r3.status, 200);
  assert.equal(r3.body.noChange, true);
  assert.ok(r3.body.summary[0].includes("Nothing to undo"), r3.body.summary[0]);
  resetSession(conv);
}
console.log("handler: undo/redo + conversation context ✅");

// ---- regression: a brief carrying respond:false survives as a brief -------------------
// Production failure: BRIEF_SCHEMA includes respond/reply/dataQuestion, so the model
// returns respond:false on build turns. The brief then carried that key, downstream
// "respond" in result matched it, and the WHOLE PLAN (title, palette, KPIs) was
// silently discarded — logs showed "[orchestrator] brief: ..." then "-> respond",
// and the built dashboard fell back to a derived title with no brief directives.
{
  const { orchestrate } = await import("../orchestrator");
  const fakeRun = async () => ({ text: JSON.stringify({
    respond: false, reply: "", dataQuestion: false, needsClarification: false,
    outputMode: "dashboard", title: "ITIL Service Desk & SLA Performance Dashboard",
    kpis: ["Total tickets"], charts: [{ type: "bar", x: "priority", y: "count" }],
    palette: { primary: "#7c3aed", accent: "#06b6d4", vibe: "vibrant" },
    designDirection: "dense", enhancedPrompt: "build it",
  }), finishReason: "STOP" } as any);
  const r: any = await orchestrate({ datasets: orders, userPrompt: "make a dashboard" }, fakeRun);
  assert.ok(r, "brief produced");
  assert.ok(!("respond" in r), "respond discriminator stripped from the brief");
  assert.ok(!("reply" in r) && !("dataQuestion" in r), "all respond fields stripped");
  assert.equal(r.title, "ITIL Service Desk & SLA Performance Dashboard", "the plan survives");
  // A REAL respond turn still routes as one.
  const r2: any = await orchestrate({ datasets: orders, userPrompt: "which region sold most?" },
    async () => ({ text: JSON.stringify({ respond: true, reply: "EMEA leads.", dataQuestion: true,
      outputMode: "dashboard", title: "x", kpis: [], charts: [], palette: { primary: "#111", accent: "#222", vibe: "calm" }, designDirection: "d", enhancedPrompt: "e" }), finishReason: "STOP" } as any));
  assert.equal(r2.respond, true);
  assert.equal(r2.reply, "EMEA leads.");
}
console.log("orchestrator: respond:false no longer eats the brief ✅");

// ---- regression: a gutted edit can no longer destroy the dashboard --------------------
// Production failure: a style-only edit ("make it dark") came back from the model
// with every chart's `series` omitted; validation dropped them all ("no series —
// dropped" x5, section s_trends empty) and 7 widgets vanished. Reconciliation now
// heals kept widgets against the previous version before validation runs.
{
  const { reconcileEdit } = await import("./reconcile");
  const prev: any = { version: 1, meta: { title: "Helpdesk", theme: "light" }, sections: [
    { id: "s1", widgets: [
      { id: "k1", kind: "kpi", title: "Total tickets", table: "orders", metric: { col: "revenue", agg: "sum" }, width: "quarter" },
      { id: "c1", kind: "line", title: "Daily trend", table: "orders", x: { col: "created_at", timeGrain: "day" }, series: [{ col: "revenue", agg: "sum" }], width: "half" },
      { id: "c2", kind: "bar", title: "By region", table: "orders", x: { col: "region" }, series: [{ col: "revenue", agg: "sum" }], width: "half" },
      { id: "t1", kind: "table", title: "Detail", table: "orders", columns: [{ col: "region" }, { col: "revenue", agg: "sum" }], width: "full" },
    ] },
  ] };
  // The model "kept" everything but dropped series/metric/columns, changed theme.
  const gutted: any = { version: 1, meta: { title: "Helpdesk", theme: "dark" }, sections: [
    { id: "s1", widgets: [
      { id: "k1", kind: "kpi", title: "Total tickets", table: "orders", width: "quarter" },
      { id: "c1", kind: "line", title: "Daily trend", table: "orders", x: { col: "created_at", timeGrain: "day" }, width: "half" },
      { id: "c2", kind: "bar", title: "By region", table: "orders", series: [], width: "half" },
      { id: "t1", kind: "table", title: "Detail", table: "orders", columns: [], width: "full" },
    ] },
  ] };
  const { spec: healedSpec, healed } = reconcileEdit(prev, gutted);
  const ws: any[] = healedSpec.sections[0].widgets as any[];
  assert.deepEqual(ws.find((w) => w.id === "k1").metric, { col: "revenue", agg: "sum" }, "kpi metric healed");
  assert.equal(ws.find((w) => w.id === "c1").series[0].col, "revenue", "line series healed");
  assert.equal(ws.find((w) => w.id === "c2").series[0].col, "revenue", "bar series healed");
  assert.equal(ws.find((w) => w.id === "t1").columns.length, 2, "table columns healed");
  assert.equal(healedSpec.meta.theme, "dark", "the requested change is preserved");
  assert.ok(healed.length >= 4, `heals recorded (${healed.length})`);

  // Kind change on the SAME widget still heals ("make this a donut" without series).
  const kindChange: any = { ...gutted, sections: [{ id: "s1", widgets: [
    { id: "c2", kind: "donut", title: "By region", table: "orders", width: "half" },
  ] }] };
  const r2 = reconcileEdit(prev, kindChange);
  const donut: any = (r2.spec.sections[0].widgets as any[])[0];
  assert.equal(donut.kind, "donut");
  assert.equal(donut.series[0].col, "revenue", "series healed across a chart-kind change");
  assert.equal(donut.x.col, "region", "x healed across a chart-kind change");

  // Deliberate removals are respected — absence of an id is not healed back.
  const removal: any = { ...gutted, sections: [{ id: "s1", widgets: gutted.sections[0].widgets.filter((w: any) => w.id !== "c1") }] };
  const r3 = reconcileEdit(prev, removal);
  assert.ok(!(r3.spec.sections[0].widgets as any[]).some((w: any) => w.id === "c1"), "removed widget stays removed");

  // End-to-end through the handler: gutted planner output survives validation.
  const gutPlanner = async () => gutted;
  const { status, body } = await handleDashboardBuild(
    { datasets: orders, userPrompt: "make it dark", currentSpec: prev },
    { planner: gutPlanner as any, skipRewrite: true },
  );
  assert.equal(status, 200);
  const outWidgets = body.spec.sections.flatMap((s: any) => s.widgets);
  assert.equal(outWidgets.length, 4, `all 4 widgets survive (got ${outWidgets.length})`);
  assert.ok(body.warnings.some((w: string) => w.includes("restored")), "heals surfaced in warnings");
  assert.ok(!body.summary.join(" ").includes("Removed"), "no phantom removals in the summary");
}
console.log("reconcile: gutted edits healed, removals respected ✅");

// ---- patch-based edits: the Figma model — scoped ops, gated removals ------------------
// Production failure this replaces: "the table displays many rows, stick to just 5"
// came back as a full-spec rewrite that DELETED five unrelated widgets. Edits are
// now op lists applied deterministically: unnamed widgets cannot change, and
// removals only apply with explicit removal intent (or on the selected widget).
{
  const { applyOps } = await import("./patch");
  const cur: any = { version: 1, meta: { title: "Helpdesk", theme: "light" }, sections: [
    { id: "s1", widgets: [
      { id: "k1", kind: "kpi", title: "Total tickets", table: "orders", metric: { col: "revenue", agg: "sum" } },
      { id: "c1", kind: "bar", title: "By region", table: "orders", x: { col: "region" }, series: [{ col: "revenue", agg: "sum" }] },
      { id: "t1", kind: "table", title: "Oldest open tickets", table: "orders", columns: [{ col: "region" }], limit: 25 },
    ] },
  ] };

  // The exact production ask: one field on one widget. Nothing else may move.
  const r1 = applyOps(cur, [{ op: "update_widget", id: "t1", set: { limit: 5 } }], "stick to just 5 rows");
  const w1: any[] = r1.spec.sections[0].widgets as any[];
  assert.equal(w1.length, 3, "no widgets lost");
  assert.equal(w1.find((w) => w.id === "t1").limit, 5, "limit updated");
  assert.equal(w1.find((w) => w.id === "c1").series[0].col, "revenue", "untouched widget untouched");

  // A spurious removal (no removal intent in the prompt) is REJECTED, not applied.
  const r2 = applyOps(cur, [
    { op: "update_widget", id: "t1", set: { limit: 5 } },
    { op: "remove_widget", id: "c1" },
  ], "stick to just 5 rows");
  assert.equal((r2.spec.sections[0].widgets as any[]).length, 3, "spurious removal blocked");
  assert.ok(r2.rejected.some((x: string) => x.includes("didn't ask for a removal")), r2.rejected.join("|"));

  // Explicit removal intent applies; empty-array sets can never wipe fields.
  const r3 = applyOps(cur, [
    { op: "remove_widget", id: "c1" },
    { op: "update_widget", id: "t1", set: { columns: [] } },
  ], "remove the region chart");
  assert.equal((r3.spec.sections[0].widgets as any[]).length, 2, "requested removal applied");
  assert.equal((r3.spec.sections[0].widgets as any[]).find((w: any) => w.id === "t1").columns.length, 1, "empty array cannot wipe columns");

  // The selected widget is removable without magic words ("delete this").
  const r4 = applyOps(cur, [{ op: "remove_widget", id: "c1" }], "this one", "c1");
  assert.equal((r4.spec.sections[0].widgets as any[]).length, 2, "selected widget removal allowed");

  // add_widget + update_meta round out the op set.
  const r5 = applyOps(cur, [
    { op: "add_widget", sectionId: "s1", widget: { kind: "donut", title: "Share", subtitle: "Revenue share by region", table: "orders", x: { col: "region" }, series: [{ col: "revenue", agg: "sum" }] } },
    { op: "update_meta", meta: { theme: "dark", insight: "EMEA drives 60% of revenue" } },
  ], "add a share donut and make it dark");
  assert.equal((r5.spec.sections[0].widgets as any[]).length, 4);
  assert.equal(r5.spec.meta.theme, "dark");
  assert.equal((r5.spec.meta as any).insight, "EMEA drives 60% of revenue");

  // End-to-end: the handler's edit path plans ops (injected runner), applies, renders.
  const opsRun = async () => ({ text: JSON.stringify({ ops: [{ op: "update_widget", id: "t1", set: { limit: 5 } }] }), finishReason: "STOP" } as any);
  const { status, body } = await handleDashboardBuild(
    { datasets: orders, userPrompt: "stick to just 5 rows", currentSpec: cur },
    { agentRun: opsRun as any, skipRewrite: true },
  );
  assert.equal(status, 200);
  assert.equal(body.pipeline, "patch");
  const outW = body.spec.sections.flatMap((s: any) => s.widgets);
  assert.equal(outW.length, 3, "patch path loses nothing");
  assert.equal(outW.find((w: any) => w.id === "t1").limit, 5);
  assert.ok(!body.summary.join(" ").includes("Removed"), "no phantom removals");
}
console.log("patch: scoped ops + gated removals ✅");

// ---- design surfaces: insight banner, icon chips, rainbow bars ------------------------
{
  const { renderPlanToApp } = await import("./renderer");
  const plan: any = { meta: { title: "T", subtitle: "The story", insight: "Alpha drives most downtime" },
    sections: [{ id: "s", widgets: [{ widget: { id: "k1", kind: "kpi", title: "Total", subtitle: "All records", table: "orders", metric: { col: "revenue", agg: "sum", format: "currency" } }, sql: "select 1 as value" }] }],
    warnings: [], spec: {} };
  const src = renderPlanToApp(plan).files[0].content;
  for (const needle of ["PLAN.meta.insight", "kpiGlyph", "linearGradient", "The story", "Alpha drives most downtime"]) {
    assert.ok(src.includes(needle), `design surface missing: ${needle}`);
  }
}
console.log("renderer: inspiration design surfaces ✅");

console.log("agents.test.ts: all assertions passed ✅");
