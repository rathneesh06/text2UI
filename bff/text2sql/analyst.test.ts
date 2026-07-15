// bff/text2sql/analyst.test.ts — run with: npm run test:analyst
// Covers the al1 analyst loop end to end with fake model runners and a REAL
// local DuckDB file standing in as the "live attach": grounding (deterministic
// keywords + value probes), analysis-plan validation + coverage, the parallel
// component agents with one-shot repair, deterministic evidence summaries, the
// rendered directive, and the dashboard handler's directive precedence.
// Hermetic: everything lives in a self-deleting temp dir; no network, no WB_DIR.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { deterministicKeywords, probeCandidates, probeValues, groundPrompt } from "./grounding";
import { validateAnalysisPlan, coverageGaps, type AnalysisPlan } from "./analysis-planner";
import { runAnalystLoop, summarizeResult, formatEvidenceDirective, compactEvidence } from "./analyst";
import { handleDashboardBuild } from "../dashboard/handler";

const fake = (obj: unknown) => async () => ({ text: JSON.stringify(obj), finishReason: "STOP" } as any);

// ---- fixture: a "live" DB with an SOS-shaped tickets table -------------------------
const dir = mkdtempSync(join(tmpdir(), "t2sql-analyst-"));
const dbPath = join(dir, "live.duckdb");
const inst = await DuckDBInstance.create(dbPath);
{
  const conn = await inst.connect();
  await conn.run(`CREATE TABLE tickets (id INTEGER, ticket_type VARCHAR, region VARCHAR, created_at DATE)`);
  await conn.run(`INSERT INTO tickets
    SELECT i, CASE WHEN i % 3 = 0 THEN 'SOS' ELSE 'GENERAL' END,
           CASE WHEN i % 2 = 0 THEN 'EMEA' ELSE 'APAC' END,
           DATE '2026-06-15' + INTERVAL (i % 30) DAY
    FROM range(1, 91) t(i)`);
  conn.disconnectSync();
}
const runQuery = async (sql: string): Promise<Record<string, unknown>[]> => {
  const conn = await inst.connect();
  try {
    const reader = await conn.runAndReadUntil(sql, 2000);
    return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((row) => {
      for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
      return row;
    });
  } finally {
    conn.disconnectSync();
  }
};

const allTables = [{ name: "tickets", approxRows: 90, ref: `"tickets"`, schema: "main", table: "tickets" }];
const datasets = [{
  tableName: "tickets",
  profile: {
    source: { filename: "x", format: "json" }, rowCount: 90,
    columns: [
      { name: "id", type: "integer" }, { name: "ticket_type", type: "varchar" },
      { name: "region", type: "varchar" }, { name: "created_at", type: "date" },
    ],
    sampleRows: [{ id: 1, ticket_type: "GENERAL", region: "APAC", created_at: "2026-06-16" }],
  },
} as any];

// ---- grounding: deterministic keywords always catch caps + quotes -------------------
{
  const kws = deterministicKeywords(`What are the current trends in SOS in the "last 30 days"?`);
  assert.ok(kws.includes("SOS"), `caps token kept: ${kws}`);
  assert.ok(kws.includes("last 30 days"), `quoted phrase kept: ${kws}`);
  assert.ok(!kws.includes("what") && !kws.includes("trends"), `stopwords dropped: ${kws}`);
}
// ---- grounding: value probe links SOS -> tickets.ticket_type ------------------------
{
  const candidates = probeCandidates("trends in SOS", undefined, allTables, datasets);
  assert.ok(candidates.some((c) => c.column === "ticket_type"), "texty column is a probe candidate");
  assert.ok(!candidates.some((c) => c.column === "id"), "numeric column is not probed");
  const { valueHits, probedColumns } = await probeValues({ keywords: ["sos"], candidates, runQuery });
  assert.ok(probedColumns >= 1, "probed at least one column");
  assert.ok(valueHits.some((h) => h.value === "SOS" && h.column === "ticket_type"), JSON.stringify(valueHits));
}
// ---- grounding: probe failures are warnings, never throws ---------------------------
{
  const boom = async () => { throw new Error("connection reset"); };
  const notes = await groundPrompt({ prompt: "SOS trends", allTables, datasets, runQuery: boom, run: fake({ keywords: ["SOS"] }) });
  assert.equal(notes.valueHits.length, 0);
  assert.ok(notes.warnings.length >= 1 && notes.warnings[0].includes("probe failed"), notes.warnings.join("; "));
}
console.log("grounding ✅");

// ---- plan validation: drops writes, invented tables; coerces roles/ids --------------
{
  const plan = validateAnalysisPlan({
    subQuestions: [
      { id: "q1", role: "kpi", question: "total", sql: `SELECT count(*) FROM "tickets"` },
      { id: "q1", role: "nonsense", question: "dup id + bad role", sql: `SELECT region FROM "tickets" GROUP BY region` },
      { id: "q3", role: "kpi", question: "write attempt", sql: `DROP TABLE tickets` },
      { id: "q4", role: "trend", question: "invented table", sql: `SELECT * FROM unicorns` },
      { id: "q5", role: "trend", question: "", sql: `SELECT 1` },
    ],
  }, allTables);
  assert.ok(plan, "plan survives");
  assert.equal(plan!.subQuestions.length, 2, "unsafe/ungrounded/blank dropped");
  assert.equal(plan!.subQuestions[1].role, "detail", "bad role coerced");
  assert.notEqual(plan!.subQuestions[0].id, plan!.subQuestions[1].id, "duplicate ids deduped");
  assert.equal(validateAnalysisPlan({ subQuestions: [{ role: "kpi", question: "x", sql: "DELETE FROM t" }] }, allTables), null, "nothing valid -> null");
}
// ---- coverage gaps mirror the house style upstream ----------------------------------
{
  const thinPlan: AnalysisPlan = { subQuestions: [{ id: "q1", role: "kpi", question: "t", sql: "SELECT 1" }] };
  const gaps = coverageGaps(thinPlan, datasets);
  assert.ok(gaps.some((g) => g.includes("trend")), gaps.join("; "));
  assert.ok(gaps.some((g) => g.includes("breakdown")), gaps.join("; "));
}
console.log("analysis plan validation + coverage ✅");

// ---- the loop: parallel component agents, one repair, deterministic evidence --------
{
  const goodPlan = {
    title: "SOS last 30 days",
    subQuestions: [
      { id: "q1", role: "kpi", question: "Total SOS tickets", sql: `SELECT count(*) AS total FROM "tickets" WHERE "ticket_type" = 'SOS'` },
      { id: "q2", role: "trend", question: "Daily SOS volume", sql: `SELECT date_trunc('day', "created_at") AS day, count(*) AS n FROM "tickets" WHERE "ticket_type" = 'SOS' GROUP BY 1 ORDER BY 1` },
      { id: "q3", role: "ranking", question: "SOS by region", sql: `SELECT "region", count(*) AS n FROM "tickets" WHERE "ticket_type" = 'SOS' GROUP BY 1 ORDER BY n DESC` },
      { id: "q4", role: "composition", question: "broken on purpose", sql: `SELECT "no_such_col" FROM "tickets"` },
      { id: "q5", role: "comparison", question: "SOS vs GENERAL", sql: `SELECT "ticket_type", count(*) AS n FROM "tickets" GROUP BY 1` },
    ],
  };
  // ONE runner plays keywordist, decomposer, AND repairer — dispatch on the system prompt.
  const planRun = async (system: string, _user: string) => {
    if (system.includes("search terms")) return { text: JSON.stringify({ keywords: ["SOS"] }), finishReason: "STOP" } as any;
    if (system.includes("failed. Fix it")) return { text: JSON.stringify({ sql: `SELECT "ticket_type" AS t, count(*) AS n FROM "tickets" GROUP BY 1` }), finishReason: "STOP" } as any;
    return { text: JSON.stringify(goodPlan), finishReason: "STOP" } as any;
  };
  const pack = await runAnalystLoop(
    { prompt: "What are the current trends in SOS in the last 30 days?", allTables, datasets, runQuery },
    { plan: planRun, compose: fake("SOS volume held steady with EMEA slightly ahead.") as any },
  );
  assert.ok(pack, "pack produced");
  assert.equal(pack!.findings.length, 5);
  assert.equal(pack!.findings.filter((f) => f.ok).length, 5, "all ok (one via repair)");
  const repaired = pack!.findings.find((f) => f.id === "q4");
  assert.ok(repaired?.ok && repaired.repaired, "broken sub-question repaired once");
  const kpi = pack!.findings.find((f) => f.id === "q1");
  assert.equal(kpi!.summary, "total = 30", `deterministic KPI summary: ${kpi!.summary}`);
  const trend = pack!.findings.find((f) => f.id === "q2");
  assert.ok(/\d+ points from .* to .*; min \d+, max \d+; change/.test(trend!.summary ?? ""), trend!.summary);
  assert.ok(pack!.grounding?.valueHits.some((h) => h.value === "SOS"), "grounding rode along");

  const directive = formatEvidenceDirective(pack!);
  assert.ok(directive.includes("ANALYSIS FINDINGS"), directive.slice(0, 60));
  assert.ok(directive.includes("[kpi] Total SOS tickets — total = 30"), "real numbers in the directive");
  assert.ok(directive.includes(`"ticket_type" = 'SOS'`), "value filter surfaced");

  const compact = compactEvidence(pack!);
  assert.ok(compact.findings.every((f: any) => !("topRows" in f)), "compact view is row-free");
  assert.ok((compact as any).narrative, "narration kept");
}
// ---- the loop: zero usable findings -> null (caller builds plain) -------------------
{
  const deadPlan = { subQuestions: [{ id: "q1", role: "kpi", question: "x", sql: `SELECT "nope" FROM "tickets"` }] };
  const planRun = async (system: string) => {
    if (system.includes("search terms")) return { text: JSON.stringify({ keywords: [] }), finishReason: "STOP" } as any;
    if (system.includes("failed. Fix it")) throw new Error("model down");
    return { text: JSON.stringify(deadPlan), finishReason: "STOP" } as any;
  };
  const pack = await runAnalystLoop({ prompt: "x", allTables, datasets, runQuery }, { plan: planRun });
  assert.equal(pack, null, "no usable findings -> null");
}
console.log("analyst loop (component agents + repair + evidence) ✅");

// ---- summarizers handle awkward cells ------------------------------------------------
{
  const s1 = summarizeResult("kpi", [{ total: 42n as unknown as bigint }]);
  assert.equal(s1.summary, "total = 42", "bigint KPI");
  const s2 = summarizeResult("ranking", []);
  assert.equal(s2.summary, "no rows matched");
  const long = "x".repeat(100);
  const s3 = summarizeResult("detail", [{ a: long }, { a: "b" }]);
  assert.ok(!s3.summary!.includes(long) && s3.summary!.includes("…"), "long cells clipped");
}
console.log("deterministic summaries ✅");

// ---- dashboard build: analystDirective outranks brief + rewriter ---------------------
{
  const buildDatasets = [{
    tableName: "orders",
    profile: {
      source: { filename: "x", format: "json" }, rowCount: 10,
      columns: [{ name: "region", type: "string" } as any, { name: "revenue", type: "number" } as any],
      sampleRows: [{ region: "EMEA", revenue: 5 }],
    },
  } as any];
  const captured: any[] = [];
  const fakePlanner = async (input: any) => {
    captured.push(input);
    return {
      version: 1,
      meta: { title: "T" },
      sections: [{ id: "s1", title: "Main", widgets: [{ id: "w1", kind: "kpi", title: "Total revenue", metric: { agg: "sum", col: "revenue" }, table: "orders" }] }],
    } as any;
  };
  const brief = { kpis: ["Total revenue"], charts: [], palette: { primary: "#111", accent: "#222", vibe: "calm" }, enhancedPrompt: "brief text", outputMode: "dashboard", title: "B", designDirection: "d" };
  const { status } = await handleDashboardBuild(
    { datasets: buildDatasets, userPrompt: "SOS dashboard", brief, analystDirective: "ANALYSIS FINDINGS —\n1. [kpi] total = 30" },
    fakePlanner as any,
  );
  assert.equal(status, 200);
  assert.ok(captured[0].directive?.startsWith("ANALYSIS FINDINGS"), "analyst directive won precedence");
  // Without a directive or brief, the rewriter path would need the network — the
  // directive's presence must fully short-circuit it (no callGemini import hit).
}
console.log("directive precedence in dashboard build ✅");

// ---- teardown (Windows-safe: close before delete) ------------------------------------
inst.closeSync();
rmSync(dir, { recursive: true, force: true });
console.log("analyst.test.ts: all assertions passed ✅");
