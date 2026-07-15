// bff/text2sql/analysis-planner.ts — Stage 2 of the analyst loop: the DECOMPOSER
// (supervisor in the supervisor/worker shape). One structured Gemini call turns
// the user's analytical ask + the grounded schema into a typed AnalysisPlan: a
// set of SUB-QUESTIONS, each with a COMPONENT ROLE (which kind of dashboard
// widget it will feed) and ONE read-only DuckDB SELECT. Each sub-question then
// becomes an independent component agent in Stage 3 (parallel execute + repair).
//
// Same philosophy as every other planner here: the model is creative and
// untrusted — validateAnalysisPlan() enforces shape, guards every statement
// syntactically, and coverageGaps() checks the plan spans the analytical roles
// a dashboard needs (KPI + trend + breakdowns), with ONE corrective re-plan
// handled by the caller.
import type { ChatMessage, Dataset } from "../../shared/types";
import { callGemini, ORCHESTRATE_OPTS, type GenOptions, type GenResult } from "../aiflow";
import { guardSelect } from "./guard";
import { rankTables, type PlanSqlInput } from "./planner";
import { describeGrounding, type GroundingNotes } from "./grounding";

const ANALYSIS_TIMEOUT_MS = Number(process.env.T2SQL_ANALYSIS_TIMEOUT_MS ?? 30_000);

export type AnalysisRole = "kpi" | "trend" | "composition" | "ranking" | "comparison" | "detail";
export const ANALYSIS_ROLES: AnalysisRole[] = ["kpi", "trend", "composition", "ranking", "comparison", "detail"];

export interface SubQuestion {
  id: string;
  role: AnalysisRole;
  question: string;
  sql: string;
}

export interface AnalysisPlan {
  title?: string;
  subQuestions: SubQuestion[];
}

export type AnalysisRun = (s: string, u: string, o?: GenOptions) => Promise<GenResult>;

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short title for the analysis." },
    subQuestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "q1, q2, ..." },
          role: {
            type: "string",
            enum: ANALYSIS_ROLES,
            description: "The dashboard component this feeds. kpi: one headline aggregate. trend: a time-bucketed series. composition: share by category. ranking: top-N by a measure. comparison: two periods/segments side by side. detail: a small supporting table.",
          },
          question: { type: "string", description: "The sub-question in plain language." },
          sql: { type: "string", description: "ONE read-only DuckDB SELECT answering it. No writes, DDL, ATTACH, COPY, or PRAGMA." },
        },
        required: ["role", "question", "sql"],
      },
    },
  },
  required: ["subQuestions"],
};

const SYSTEM = `You are the analysis-planning stage of a dashboard generator. The user asked an analytical question about a live database (attached READ-ONLY through DuckDB as "src"). Decompose it into 4-8 SUB-QUESTIONS whose answers together fully characterize the topic — each sub-question feeds one dashboard component (its "role").

Coverage requirements (a dashboard needs all of these unless the data genuinely cannot support them):
- at least 2 "kpi" sub-questions (headline aggregates: totals, averages, rates — include a period-over-period comparison as a kpi or comparison when a time window is involved)
- at least 1 "trend" (time-bucketed with date_trunc; pick day/week/month to give 10-40 points)
- at least 2 breakdowns across DIFFERENT roles (composition / ranking / comparison)

Rules for every sql:
- Exactly ONE SELECT (WITH...SELECT is fine). NEVER any write, DDL, ATTACH, COPY, or PRAGMA.
- Reference every table by the EXACT "SQL ref" shown in the schema (e.g. src."public"."orders"). Never invent tables or columns.
- DuckDB dialect regardless of source engine: date_trunc('day', col), count(*), double-quoted identifiers, no backticks, no engine-specific functions. For "last N days" use col >= current_date - INTERVAL N DAY.
- Apply the discovered VALUE FILTERS below when the user's terms match cell values (e.g. WHERE "ticket_type" = 'SOS') — this is what makes the analysis about what the user asked.
- Aggregate aggressively: return summaries (grouped counts, sums, series), never raw dumps. Keep every result under ~100 rows (trend series, top-10 rankings, single-row KPIs).

Emit ONE JSON AnalysisPlan and nothing else.`;

/** Clip long sample values so a wide text column can't bloat the prompt. */
const clipSample = (r: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const k in r) {
    const v = r[k];
    out[k] = typeof v === "string" && v.length > 40 ? v.slice(0, 37) + "…" : v;
  }
  return out;
};

function describeSchema(input: PlanAnalysisInput): string {
  const profiled = new Map(input.datasets.map((d) => [d.tableName, d] as const));
  const { detailed, rest } = rankTables(input.prompt, input.history, input.allTables, input.datasets);
  const lines = detailed.map((t) => {
    const ref = t.ref ?? `src."${t.name}"`;
    const d = profiled.get(t.name);
    if (!d) return `${t.name} — SQL ref: ${ref} (~${t.approxRows} rows) — not yet profiled`;
    const cols = d.profile.columns.map((c: any) => `${c.name}:${c.type ?? "?"}`).join(", ");
    const sample = (d.profile.sampleRows ?? []).slice(0, 2).map((r) => JSON.stringify(clipSample(r))).join(" | ");
    return `${t.name} — SQL ref: ${ref} (~${t.approxRows} rows)\n  columns: ${cols}${sample ? `\n  sample: ${sample}` : ""}`;
  });
  if (rest.length) lines.push(`Other tables: ${rest.map((t) => t.name).join(", ")}`);
  return lines.join("\n");
}

export interface PlanAnalysisInput {
  prompt: string;
  allTables: PlanSqlInput["allTables"];
  datasets: Dataset[];
  history?: ChatMessage[];
  grounding?: GroundingNotes;
  /** Corrective feedback for the one re-plan attempt. */
  revise?: string;
}

const stripFences = (s: string) => s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

/** Deterministic plan validation: coerce what's coercible, DROP what's unsafe or
 *  ungrounded, never throw. Returns null when nothing valid survives. */
export function validateAnalysisPlan(raw: unknown, allTables: PlanSqlInput["allTables"]): AnalysisPlan | null {
  const p = raw as any;
  if (!p || typeof p !== "object" || !Array.isArray(p.subQuestions)) return null;
  const known = allTables.map((t) => t.name.toLowerCase());
  const seen = new Set<string>();
  const subQuestions: SubQuestion[] = [];
  for (const q of p.subQuestions.slice(0, 10)) {
    if (!q || typeof q !== "object") continue;
    const sql = typeof q.sql === "string" ? q.sql.trim() : "";
    const question = typeof q.question === "string" ? q.question.trim() : "";
    if (!sql || !question) continue;
    if (!guardSelect(sql).ok) continue;                       // syntactic safety (executor guards again)
    const sqlLc = sql.toLowerCase();
    if (!known.some((n) => sqlLc.includes(n.split(".").pop()!))) continue; // invented tables → drop
    const role: AnalysisRole = ANALYSIS_ROLES.includes(q.role) ? q.role : "detail";
    let id = typeof q.id === "string" && q.id.trim() ? q.id.trim() : `q${subQuestions.length + 1}`;
    for (let i = 2; seen.has(id); i++) id = `${id}_${i}`;
    seen.add(id);
    subQuestions.push({ id, role, question, sql });
  }
  if (!subQuestions.length) return null;
  return { title: typeof p.title === "string" ? p.title : undefined, subQuestions };
}

/** House-coverage check for an analysis plan (mirror of the dashboard's
 *  coverageShortfalls, moved upstream). Scaled down for thin schemas. */
export function coverageGaps(plan: AnalysisPlan, datasets: Dataset[]): string[] {
  const columnCount = datasets.reduce((n, d) => n + d.profile.columns.length, 0);
  const thin = columnCount < 6;
  const roles = plan.subQuestions.map((q) => q.role);
  const count = (r: AnalysisRole) => roles.filter((x) => x === r).length;
  const gaps: string[] = [];
  const wantKpis = thin ? 1 : 2;
  if (count("kpi") < wantKpis) gaps.push(`only ${count("kpi")} kpi sub-question(s), need at least ${wantKpis}`);
  if (count("trend") < 1) gaps.push("no trend sub-question — add a time-bucketed series");
  const breakdowns = new Set(roles.filter((r) => r === "composition" || r === "ranking" || r === "comparison"));
  const wantBreakdowns = thin ? 1 : 2;
  if (breakdowns.size < wantBreakdowns) gaps.push(`only ${breakdowns.size} breakdown role(s) (composition/ranking/comparison), need ${wantBreakdowns} different ones`);
  if (plan.subQuestions.length < (thin ? 2 : 4)) gaps.push(`only ${plan.subQuestions.length} sub-questions total, need at least ${thin ? 2 : 4}`);
  return gaps;
}

/** Run the decomposer once. Null on any failure (caller may retry once or fall back). */
export async function planAnalysis(
  input: PlanAnalysisInput,
  run: AnalysisRun = callGemini,
  timeoutMs = ANALYSIS_TIMEOUT_MS,
): Promise<AnalysisPlan | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<AnalysisPlan | null> => {
    try {
      const hist = input.history?.length
        ? "Conversation so far:\n" + input.history.slice(-8).map((m) => `${m.role}: ${m.content}`).join("\n") + "\n\n"
        : "";
      const grounding = input.grounding ? describeGrounding(input.grounding) : "";
      const revise = input.revise ? `\n\nREVISE: the previous plan was insufficient — ${input.revise}. Keep what was good; add what is missing.` : "";
      const user = `${hist}Schema:\n${describeSchema(input)}\n\n${grounding ? grounding + "\n\n" : ""}User request: ${input.prompt}${revise}`;
      const { text } = await run(SYSTEM, user, { ...ORCHESTRATE_OPTS, responseSchema: ANALYSIS_SCHEMA });
      const plan = validateAnalysisPlan(JSON.parse(stripFences(text)), input.allTables);
      if (plan) console.log(`[analysis] plan: ${plan.subQuestions.length} sub-questions (${plan.subQuestions.map((q) => q.role).join(", ")})`);
      return plan;
    } catch (err: any) {
      console.warn(`[analysis] planner failed: ${err?.message ?? err}`);
      return null;
    }
  })();
  return Promise.race([call, timeout]);
}
