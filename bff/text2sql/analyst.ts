// bff/text2sql/analyst.ts — Stages 3-4 of the analyst loop: COMPONENT AGENTS and
// the EVIDENCE PACK. This is the conjoint text2SQL→text2UI junction: real
// findings computed from the LIVE database become the analytical directive the
// dashboard spec planner builds around.
//
//   Stage 3 — each sub-question from the AnalysisPlan runs as an independent
//   component agent, in parallel (bounded concurrency): guard → execute on the
//   live attach → on failure ONE model-repair attempt (re-guarded) → done.
//   The supervisor/worker shape keeps the final artifact coherent: workers
//   fetch and summarize; ONE spec planner composes the dashboard.
//
//   Stage 4 — results are summarized DETERMINISTICALLY per role (KPI value,
//   trend first/last/min/max/delta, top-N rows), never by dumping rows into a
//   prompt. An optional single narration call adds cross-finding prose,
//   fail-soft. formatEvidenceDirective() renders the pack as the directive.
//
// The whole loop never throws to its caller and returns null when it produced
// nothing useful — the build then proceeds exactly as before (fail-soft, same
// contract as the orchestrator and rewriter).
import type { ChatMessage, Dataset } from "../../shared/types";
import { callGemini, ORCHESTRATE_OPTS, type GenOptions, type GenResult } from "../aiflow";
import { guardSelect, unfence } from "./guard";
import type { PlanSqlInput } from "./planner";
import { groundPrompt, type GroundingNotes, type GroundingRun } from "./grounding";
import { planAnalysis, coverageGaps, type AnalysisPlan, type AnalysisRole, type AnalysisRun, type SubQuestion } from "./analysis-planner";

const ANALYST_MAX_ROWS = Number(process.env.T2SQL_ANALYST_MAX_ROWS ?? 1000);
const ANALYST_CONCURRENCY = Number(process.env.T2SQL_ANALYST_CONCURRENCY ?? 4);
const REPAIR_TIMEOUT_MS = Number(process.env.T2SQL_REPAIR_TIMEOUT_MS ?? 15_000);
const NARRATE_TIMEOUT_MS = Number(process.env.T2SQL_NARRATE_TIMEOUT_MS ?? 12_000);

export type ModelRun = (s: string, u: string, o?: GenOptions) => Promise<GenResult>;

export interface Finding {
  id: string;
  role: AnalysisRole;
  question: string;
  sql: string;             // the guarded SQL that actually ran (or last attempt)
  ok: boolean;
  error?: string;
  repaired?: boolean;      // succeeded only after the one repair attempt
  rowCount?: number;
  summary?: string;        // deterministic, role-aware
  topRows?: Record<string, unknown>[];  // small, clipped — for the client panel
  durationMs?: number;
}

export interface EvidencePack {
  title?: string;
  findings: Finding[];
  narrative?: string;      // optional model prose over the findings (fail-soft)
  grounding?: GroundingNotes;
  warnings: string[];
}

export interface AnalystInput {
  prompt: string;
  dialect?: "mysql" | "postgres";
  allTables: PlanSqlInput["allTables"];
  datasets: Dataset[];
  history?: ChatMessage[];
  /** Live executor — the handler wires this to runOnLiveAttach(rec, sql). */
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>;
}

export interface AnalystDeps {
  plan?: ModelRun;       // decomposer + keyword + repair runner (tests inject fakes)
  compose?: ModelRun;    // narration runner
}

export type AnalystRun = (input: AnalystInput, deps?: AnalystDeps) => Promise<EvidencePack | null>;

// ---- Stage 3: execution ------------------------------------------------------------

const REPAIR_SCHEMA = { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] };
const REPAIR_SYSTEM = `A DuckDB SELECT failed. Fix it. Keep the analytical intent identical; use ONLY the tables/columns in the schema, with their EXACT SQL refs. Emit JSON {"sql": "..."} with exactly ONE read-only SELECT — no writes, DDL, ATTACH, COPY, or PRAGMA.`;

async function repairSql(
  q: SubQuestion,
  error: string,
  schemaText: string,
  run: ModelRun,
  timeoutMs = REPAIR_TIMEOUT_MS,
): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<string | null> => {
    try {
      const { text } = await run(
        REPAIR_SYSTEM,
        `Schema:\n${schemaText}\n\nSub-question: ${q.question}\nFailing SQL:\n${q.sql}\nError: ${error}`,
        { ...ORCHESTRATE_OPTS, responseSchema: REPAIR_SCHEMA },
      );
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim());
      const sql = typeof parsed?.sql === "string" ? unfence(parsed.sql).trim() : "";
      return sql || null;
    } catch {
      return null;
    }
  })();
  return Promise.race([call, timeout]);
}

/** Run one component agent: guard → execute → one repair → summarize. */
async function runComponent(
  q: SubQuestion,
  input: AnalystInput,
  schemaText: string,
  planRun: ModelRun,
): Promise<Finding> {
  const base: Finding = { id: q.id, role: q.role, question: q.question, sql: q.sql, ok: false };
  const attempt = async (sql: string): Promise<{ rows: Record<string, unknown>[]; sql: string }> => {
    const guarded = guardSelect(sql, ANALYST_MAX_ROWS);
    if (!guarded.ok) throw new Error(guarded.error);
    return { rows: await input.runQuery(guarded.sql), sql: guarded.sql };
  };
  const t0 = Date.now();
  try {
    const { rows, sql } = await attempt(q.sql);
    return { ...base, ...summarizeResult(q.role, rows), sql, ok: true, durationMs: Date.now() - t0 };
  } catch (err: any) {
    const firstError = String(err?.message ?? err);
    const fixed = await repairSql(q, firstError, schemaText, planRun);
    if (fixed) {
      try {
        const { rows, sql } = await attempt(fixed);
        return { ...base, ...summarizeResult(q.role, rows), sql, ok: true, repaired: true, durationMs: Date.now() - t0 };
      } catch (err2: any) {
        return { ...base, sql: fixed, error: `${firstError}; repair also failed: ${err2?.message ?? err2}`, durationMs: Date.now() - t0 };
      }
    }
    return { ...base, error: firstError, durationMs: Date.now() - t0 };
  }
}

/** Bounded-concurrency map (live DB politeness — never storm the source). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- Stage 4: deterministic summarization -------------------------------------------

const cell = (v: unknown): string => {
  if (v == null) return "∅";
  if (typeof v === "bigint") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
};
const toNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const isDateish = (v: unknown): boolean =>
  v instanceof Date || (typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?/.test(v));

const rowText = (r: Record<string, unknown>) =>
  Object.entries(r).map(([k, v]) => `${k}=${cell(v)}`).join(", ");

/** Role-aware deterministic summary — the "insight reading" that never needs a model. */
export function summarizeResult(role: AnalysisRole, rows: Record<string, unknown>[]): Pick<Finding, "rowCount" | "summary" | "topRows"> {
  const rowCount = rows.length;
  const topRows = rows.slice(0, 8).map((r) => {
    const out: Record<string, unknown> = {};
    for (const k in r) out[k] = cell(r[k]);
    return out;
  });
  if (!rowCount) return { rowCount, summary: "no rows matched", topRows: [] };

  const cols = Object.keys(rows[0]);
  // Single cell → the KPI shape, whatever the declared role.
  if (rowCount === 1 && cols.length === 1) {
    return { rowCount, summary: `${cols[0]} = ${cell(rows[0][cols[0]])}`, topRows };
  }
  if (rowCount === 1) return { rowCount, summary: rowText(rows[0]), topRows };

  // Time-series shape: first column date-ish + some numeric column.
  const numericCol = cols.find((c) => toNum(rows[0][c]) != null && c !== cols[0]);
  if (rows.length >= 3 && isDateish(rows[0][cols[0]]) && numericCol) {
    const vals = rows.map((r) => toNum(r[numericCol])).filter((v): v is number => v != null);
    if (vals.length >= 3) {
      const first = vals[0], last = vals[vals.length - 1];
      const min = Math.min(...vals), max = Math.max(...vals);
      const change = first !== 0 ? (((last - first) / Math.abs(first)) * 100).toFixed(1) + "%" : "n/a";
      return {
        rowCount,
        summary: `${rowCount} points from ${cell(rows[0][cols[0]])} (${numericCol}=${first}) to ${cell(rows[rowCount - 1][cols[0]])} (${numericCol}=${last}); min ${min}, max ${max}; change ${last >= first ? "+" : ""}${change}`,
        topRows,
      };
    }
  }

  // Ranking / composition / everything else: top rows.
  const shown = Math.min(rowCount, role === "detail" ? 5 : 6);
  return {
    rowCount,
    summary: `${rowCount} rows; top: ${rows.slice(0, shown).map(rowText).join(" | ")}`,
    topRows,
  };
}

// ---- Narration (optional, fail-soft) -----------------------------------------------

const NARRATE_SYSTEM = `You are the insight-reading stage of a dashboard generator. Given computed findings (each already summarized with real numbers), write 2-4 plain sentences of cross-finding insight: the headline movement, the biggest driver, anything surprising. Use ONLY the numbers provided — never invent one. No markdown, no preamble.`;

async function narrate(findings: Finding[], prompt: string, run: ModelRun, timeoutMs = NARRATE_TIMEOUT_MS): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<string | null> => {
    try {
      const body = findings.filter((f) => f.ok).map((f) => `[${f.role}] ${f.question}: ${f.summary}`).join("\n");
      const { text } = await run(NARRATE_SYSTEM, `User asked: ${prompt}\n\nFindings:\n${body}`, { temperature: 0.3 });
      const out = (text ?? "").trim();
      return out && out.length <= 800 ? out : null;
    } catch {
      return null;
    }
  })();
  return Promise.race([call, timeoutMs === 0 ? Promise.resolve(null) : timeout]);
}

// ---- The loop ------------------------------------------------------------------------

/** Compact schema text for the repair prompt (refs + columns only). */
function schemaForRepair(input: AnalystInput): string {
  const profiled = new Map(input.datasets.map((d) => [d.tableName, d] as const));
  return input.allTables.slice(0, 16).map((t) => {
    const d = profiled.get(t.name);
    const cols = d ? d.profile.columns.map((c: any) => c.name).join(", ") : "?";
    return `${t.ref ?? t.name}: ${cols}`;
  }).join("\n");
}

/** Run the full analyst loop. Never throws; null means "nothing useful — build plain". */
export async function runAnalystLoop(input: AnalystInput, deps: AnalystDeps = {}): Promise<EvidencePack | null> {
  const planRun: ModelRun = deps.plan ?? callGemini;
  const warnings: string[] = [];

  // Stage 1 — grounding (keyword extraction + value probes on the live attach).
  const grounding = await groundPrompt({
    prompt: input.prompt, history: input.history,
    allTables: input.allTables, datasets: input.datasets,
    runQuery: input.runQuery, run: planRun as GroundingRun,
  });
  warnings.push(...grounding.warnings);

  // Stage 2 — decompose, with ONE corrective re-plan when coverage falls short.
  const planInput = {
    prompt: input.prompt, allTables: input.allTables,
    datasets: input.datasets, history: input.history, grounding,
  };
  let plan: AnalysisPlan | null = await planAnalysis(planInput, planRun as AnalysisRun);
  if (!plan) return null;
  let gaps = coverageGaps(plan, input.datasets);
  if (gaps.length) {
    const retry = await planAnalysis({ ...planInput, revise: gaps.join("; ") }, planRun as AnalysisRun);
    if (retry && coverageGaps(retry, input.datasets).length < gaps.length) {
      plan = retry;
      gaps = coverageGaps(plan, input.datasets);
    }
    if (gaps.length) warnings.push(`analysis coverage: ${gaps.join("; ")}`);
  }

  // Stage 3 — component agents in parallel (bounded), one repair each.
  const schemaText = schemaForRepair(input);
  const findings = await mapPool(plan.subQuestions, ANALYST_CONCURRENCY, (q) =>
    runComponent(q, input, schemaText, planRun),
  );
  for (const f of findings) if (!f.ok) warnings.push(`sub-question ${f.id} failed: ${f.error}`);
  const okCount = findings.filter((f) => f.ok).length;
  console.log(`[analyst] ${okCount}/${findings.length} findings ok${findings.some((f) => f.repaired) ? " (some repaired)" : ""}`);
  if (!okCount) return null;

  // Stage 4 — optional cross-finding narration (fail-soft).
  const narrative = (await narrate(findings, input.prompt, deps.compose ?? callGemini)) ?? undefined;

  return { title: plan.title, findings, narrative, grounding, warnings };
}

// ---- Rendering the pack --------------------------------------------------------------

/** The evidence pack as the spec planner's analytical directive: real numbers,
 *  role-tagged, with build instructions. This is the text2SQL→text2UI junction. */
export function formatEvidenceDirective(pack: EvidencePack): string {
  const ok = pack.findings.filter((f) => f.ok);
  const lines = ok.map((f, i) => `${i + 1}. [${f.role}] ${f.question} — ${f.summary}`);
  const values = pack.grounding?.valueHits?.length
    ? `\nValue filters that define the topic: ${pack.grounding.valueHits.map((h) => `"${h.column}" = '${h.value}' (${h.table})`).join("; ")}.`
    : "";
  return [
    "ANALYSIS FINDINGS — computed from the live database before this build:",
    ...lines,
    pack.narrative ? `Insight: ${pack.narrative}` : "",
    values,
    "Design the dashboard around these findings: map each finding to a widget of its bracketed role (kpi → KPI card, trend → line/area over the same time grain, composition → pie/donut, ranking → bar, comparison → grouped bar or paired KPIs, detail → table). Use the same measures, dimensions, time grains, and value filters the findings used, so the widgets reproduce these real numbers.",
  ].filter(Boolean).join("\n");
}

/** Small, row-free view for chat memory (briefJson) and the HTTP body. */
export function compactEvidence(pack: EvidencePack) {
  return {
    title: pack.title,
    findings: pack.findings.map((f) => ({
      id: f.id, role: f.role, question: f.question, sql: f.sql,
      ok: f.ok, ...(f.repaired ? { repaired: true } : {}),
      ...(f.ok ? { rowCount: f.rowCount, summary: f.summary } : { error: f.error }),
    })),
    ...(pack.narrative ? { narrative: pack.narrative } : {}),
    ...(pack.grounding?.valueHits?.length
      ? { valueHits: pack.grounding.valueHits.map((h) => ({ keyword: h.keyword, table: h.table, column: h.column, value: h.value })) }
      : {}),
    warnings: pack.warnings,
  };
}
