import assert from "node:assert";
import { runEval, formatReport } from "./runner";
import { parseJudge, makeJudge } from "./judge";
import type { GoldenCase } from "./golden";
import type { GeneratedApp } from "../../shared/types";

const GOOD = `import { rows } from "./data";
export default function App(){ const loading=false; return <div className="p-4">{rows.length===0?"No data":rows.length}</div>; }`;
const BAD = `import x from "axios";\nexport default function App(){ return null; }`;

function appOf(code: string): GeneratedApp {
  return { files: [{ path: "App.tsx", content: code }] };
}
const cases: GoldenCase[] = [
  { id: "good-case", domain: "sales", prompt: "show sales", datasets: [{ tableName: "sales", columns: [{ name: "region" }], rows: [] }] },
  { id: "bad-case", domain: "generic", prompt: "make it", datasets: [{ tableName: "data", columns: [{ name: "value" }], rows: [] }] },
];

// ---- parseJudge ------------------------------------------------------------
{
  assert.deepEqual(parseJudge('{"polish":4,"promptResponsive":5,"notes":"good"}'), { polish: 4, promptResponsive: 5, notes: "good" });
  assert.deepEqual(parseJudge('```json\n{"polish":3,"promptResponsive":2}\n```')!, { polish: 3, promptResponsive: 2, notes: undefined });
  assert.equal(parseJudge("not json"), null, "garbage -> null");
  assert.equal(parseJudge('{"polish":9,"promptResponsive":5}'), null, "out-of-range -> null");
  assert.equal(parseJudge('{"polish":4}'), null, "missing dimension -> null");
}

// ---- makeJudge (injected call) --------------------------------------------
{
  const ok = makeJudge(async () => '{"polish":5,"promptResponsive":4}');
  assert.deepEqual(await ok("p", "code"), { polish: 5, promptResponsive: 4, notes: undefined });
  const throws = makeJudge(async () => { throw new Error("network"); });
  assert.equal(await throws("p", "code"), null, "judge failure -> null (best-effort)");
}

// ---- runEval: scoring + aggregation + injected judge -----------------------
{
  const generate = async (c: GoldenCase) => appOf(c.id === "good-case" ? GOOD : BAD);
  const judge = async () => ({ polish: 4, promptResponsive: 5 });
  const report = await runEval(cases, generate, judge);

  assert.equal(report.total, 2);
  assert.equal(report.passed, 1, "only the good case passes hard dims");
  const good = report.cases.find((c) => c.id === "good-case")!;
  const bad = report.cases.find((c) => c.id === "bad-case")!;
  assert.ok(good.pass, "good case passes");
  assert.ok(!bad.pass, "bad case fails (disallowed import)");
  assert.ok(bad.dimensions.some((d) => d.dimension === "imports" && !d.pass), "bad case flags imports");
  assert.equal(report.meanPolish, 4, "mean polish from judge");
  assert.equal(report.meanPromptResponsive, 5, "mean prompt-responsive from judge");
  assert.ok(report.meanScore > 0 && report.meanScore < 1, "mean score between 0 and 1");
}

// ---- runEval: a generate failure is reported, not thrown -------------------
{
  const generate = async () => { throw new Error("boom"); };
  const report = await runEval([cases[0]], generate);
  assert.equal(report.passed, 0);
  assert.ok(report.cases[0].dimensions.some((d) => d.dimension === "generate" && !d.pass), "generate failure captured");
  assert.equal(report.meanPolish, null, "no judge -> null means");
}

// ---- formatReport ----------------------------------------------------------
{
  const generate = async (c: GoldenCase) => appOf(c.id === "good-case" ? GOOD : BAD);
  const report = await runEval(cases, generate, async () => ({ polish: 4, promptResponsive: 5 }));
  const txt = formatReport(report);
  assert.ok(txt.includes("[PASS] good-case"), "report lists a pass");
  assert.ok(txt.includes("[FAIL] bad-case"), "report lists a fail");
  assert.ok(/cases: 1\/2 passed/.test(txt), "report has the summary line");
  assert.ok(/judge: polish 4\.00\/5/.test(txt), "report has the judge line");
}

console.log("runner.test.ts: all assertions passed");
