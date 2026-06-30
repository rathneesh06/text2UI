import assert from "node:assert";
import {
  scoreApp, checkCompiles, checkImports, checkMarkers, checkSqlColumns, checkStates, checkLeakage, checkLayout,
  type ScoreContext,
} from "./scorers";
import type { GeneratedApp } from "../../shared/types";

const ctx: ScoreContext = {
  datasets: [{ tableName: "sales", columns: ["region", "amount", "closed_at"] }],
};

function app(code: string): GeneratedApp {
  return { files: [{ path: "App.tsx", content: code }] };
}

const GOOD = `import { useEffect, useState } from "react";
import { rows, query } from "./data";
import { selectFeature } from "./selection";
import { BarChart, Bar, XAxis } from "recharts";
import { TrendingUp } from "lucide-react";
export default function App() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    query("SELECT region, SUM(amount) AS total FROM sales GROUP BY region")
      .then((r) => { setData(r); setLoading(false); });
  }, []);
  if (loading) return <div className="p-4">Loading...</div>;
  if (data.length === 0) return <div className="p-4">No data available</div>;
  return <BarChart data={data}><Bar dataKey="total" onClick={selectFeature} /><XAxis dataKey="region" /></BarChart>;
}
`;

// ---- the good app passes everything ---------------------------------------
{
  const s = scoreApp(app(GOOD), ctx);
  const fails = s.results.filter((r) => !r.pass).map((r) => `${r.dimension}: ${r.detail}`);
  assert.ok(s.pass, "good app passes (hard)");
  assert.equal(s.score, 1, `good app scores 1.0 (failed: ${fails.join(" | ")})`);
}

// ---- compiles --------------------------------------------------------------
{
  assert.ok(checkCompiles(GOOD).pass, "valid TSX compiles");
  const broken = checkCompiles("export default function App() { const x = ; return null; }");
  assert.ok(!broken.pass, "syntax error is caught");
}

// ---- imports ---------------------------------------------------------------
{
  assert.ok(checkImports(GOOD).pass, "allowed imports pass");
  const bad = checkImports(`import axios from "axios";\n${GOOD}`);
  assert.ok(!bad.pass && bad.detail.includes("axios"), "disallowed import flagged");
}

// ---- markers ---------------------------------------------------------------
{
  assert.ok(checkMarkers(GOOD).pass, "clean code passes markers");
  assert.ok(!checkMarkers(GOOD + "\n//__END__").pass, "leftover marker flagged");
  assert.ok(!checkMarkers("//__SUMMARY__ x\n" + GOOD).pass, "summary marker flagged");
}

// ---- sql columns -----------------------------------------------------------
{
  assert.ok(checkSqlColumns(GOOD, ctx).pass, "real columns + alias pass");
  const halluc = `query("SELECT bogus_col, region FROM sales")`;
  const r = checkSqlColumns(halluc, ctx);
  assert.ok(!r.pass && r.detail.includes("bogus_col"), "hallucinated column flagged");
  // functions, aliases, and CTEs are not flagged
  const tricky = `query("WITH t AS (SELECT region, SUM(amount) AS total FROM sales GROUP BY region) SELECT region, total FROM t ORDER BY total DESC")`;
  assert.ok(checkSqlColumns(tricky, ctx).pass, "CTE + alias + functions are not false positives");
  // no SQL at all -> pass
  assert.ok(checkSqlColumns(`const x = rows.length;`, ctx).pass, "no SQL -> pass");
  // words inside SQL comments are NOT hallucinated columns (the live-eval bug)
  const commented = `query("SELECT region, SUM(amount) AS total FROM sales -- MoM calculations comparing latest to previous\\nGROUP BY region")`;
  assert.ok(checkSqlColumns(commented, ctx).pass, "line-comment words are not flagged");
  const blockComment = `query("SELECT /* growth_calc total_stats */ region FROM sales")`;
  assert.ok(checkSqlColumns(blockComment, ctx).pass, "block-comment words are not flagged");
  // words inside string literals are values, not columns
  const literal = `query("SELECT region FROM sales WHERE region = 'All Departments'")`;
  assert.ok(checkSqlColumns(literal, ctx).pass, "string-literal words are not flagged");
}

// ---- states (soft) ---------------------------------------------------------
{
  assert.ok(checkStates(GOOD).pass, "good app has loading + empty");
  const noStates = `export default function App(){ return <div>{rows.map(r=><span>{r.region}</span>)}</div>; }`;
  assert.ok(!checkStates(noStates).pass, "missing states flagged (soft)");
}

// ---- leakage (soft) --------------------------------------------------------
{
  const exemplar = `const title = "Revenue by Region"; const kpi = "Total Profit Margin"; const m = "Average Order Value";`;
  // app that copies the exemplar's distinctive string literals verbatim
  const copied = `export default function App(){ const a = "Revenue by Region"; const b = "Total Profit Margin"; const c = "Average Order Value"; return <div>{a}{b}{c}</div>; }`;
  const leak = checkLeakage(copied, exemplar);
  assert.ok(!leak.pass, "stenciled labels flagged as leakage");
  // app with its own labels
  const original = `export default function App(){ const t = "My Sales Overview"; return <div>{t}</div>; }`;
  assert.ok(checkLeakage(original, exemplar).pass, "original labels are not leakage");
  // no exemplar -> pass
  assert.ok(checkLeakage(copied, undefined).pass, "no exemplar -> pass");
  // shared structural/JSX fragments are NOT leakage (the live-eval false positive).
  // These quoted strings have a space + capital but contain JSX/code characters,
  // so the tightened filter rejects them; before the fix they were counted.
  const struct = `const a = "Row One />"; const b = "Col Two <div>"; const c = "Cell Three {x}"; const d = "Item Four = z";`;
  assert.ok(checkLeakage(struct, struct).pass, "structural/JSX fragments are not counted as leakage");
  // (real distinctive labels copied verbatim are still flagged — see the `copied` case above)
}

// ---- overall: a hard failure fails the app even if soft dims pass ----------
{
  const hardFail = scoreApp(app(`import x from "axios";\n${GOOD}`), ctx);
  assert.ok(!hardFail.pass, "a hard failure (imports) fails the whole app");
  assert.ok(hardFail.score < 1, "score reflects the failure");
}

// ---- layout (soft density) -------------------------------------------------
{
  const three = `<ResponsiveContainer/><ResponsiveContainer/><ResponsiveContainer/>`;
  assert.ok(!checkLayout(`<div>${three}</div>`).pass, "3 charts, no grid -> sprawl flagged");
  assert.ok(checkLayout(`<div className="grid grid-cols-2 gap-4">${three}</div>`).pass, "multi-column grid -> pass");
  assert.ok(checkLayout(`<div className="lg:grid-cols-3">${three}</div>`).pass, "responsive grid -> pass");
  assert.ok(checkLayout(`<div className="flex"><div className="w-1/2">${three}</div></div>`).pass, "fractional-width columns -> pass");
  assert.ok(checkLayout(`<div><ResponsiveContainer/></div>`).pass, "few charts -> not a layout concern");
}

console.log("scorers.test.ts: all assertions passed");
