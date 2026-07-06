// bff/dashboard/conversational.test.ts — run with: npm run test:conversational
// Covers the v7 conversational-build layers: style sanitization in the spec
// planner, human change summaries, theming reaching the rendered app, and the
// orchestrator's respond intent + follow-up gate (all with fake model runners).
import assert from "node:assert";
import { planSpec } from "./planner";
import { summarizeSpecChange, briefToStyleHints } from "./handler";
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

const specBody = (meta: any): any => ({
  meta,
  sections: [{ title: "Main", widgets: [{ id: "w1", kind: "kpi", title: "Total revenue", metric: { agg: "sum", column: "revenue" }, table: "orders" }] }],
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
  b.sections[0].widgets.push({ id: "w2", kind: "chart", chart: "bar", title: "Revenue by region", table: "orders", x: { column: "region" }, series: [{ agg: "sum", column: "revenue" }] } as any);
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
