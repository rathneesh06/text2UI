// bff/text2sql/planner.ts — the workbench brain. One structured Gemini call that
// studies the live MySQL schema + the conversation and emits a typed TURN PLAN:
// what the user wants (intent) and the material to do it (SQL / table list /
// reply / build prompt). Follows the orchestrator's pattern exactly: compact
// responseSchema, timeout race, never throws — a null return means the handler
// falls back to a deterministic reply.
//
// Design note: SQL emitted here is treated as UNTRUSTED. It must pass
// text2sql/guard.ts before execution — the planner is where creativity lives,
// the guard is where correctness lives.
import type { ChatMessage, Dataset } from "../../shared/types";
import { callGemini, ORCHESTRATE_OPTS, type GenOptions, type GenResult } from "../aiflow";

const PLAN_TIMEOUT_MS = Number(process.env.T2SQL_PLAN_TIMEOUT_MS ?? 20_000);

export type SqlIntent = "query" | "preview" | "extract" | "build" | "chat";

export interface SqlTurnPlan {
  intent: SqlIntent;
  sql?: string;          // query | preview — ONE read-only DuckDB SELECT
  tables?: string[];     // extract | build — exact table names from the schema
  reply?: string;        // chat — direct answer; also optional flavor text for other intents
  buildPrompt?: string;  // build — the prompt to hand to the dashboard/deck pipeline
  artifact?: "dashboard" | "ppt";  // build — which pipeline the user asked for
}

export const SQL_PLAN_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["query", "preview", "extract", "build", "chat"],
      description: "query: answer a data question with SQL. preview: show rows of a table. extract: save named tables for later use. build: make a dashboard/deck from named tables. chat: answer from the schema alone (greetings, 'what tables are there').",
    },
    sql: { type: "string", description: "For query/preview: ONE DuckDB SELECT. Tables MUST be referenced as src.<table>. Read-only. Prefer aggregates for questions; LIMIT 20 for previews." },
    tables: { type: "array", items: { type: "string" }, description: "For extract/build: exact table names from the schema the user referenced." },
    reply: { type: "string", description: "For chat: the full answer. For other intents: one short sentence of context (optional)." },
    buildPrompt: { type: "string", description: "For build: a complete build request for the artifact pipeline, restating what to visualize." },
    artifact: { type: "string", enum: ["dashboard", "ppt"], description: "For build: which artifact the user asked for. Default dashboard." },
  },
  required: ["intent"],
};

const SYSTEM_SNAPSHOT_HEAD = `You are the data-question stage of text2UI: the user is chatting about data that was EXTRACTED into a local read-only DuckDB snapshot. Tables live in the default schema — reference each by the EXACT "SQL ref" shown (e.g. "orders", NOT src.orders). "Extract" and "build" requests here mean the user wants the ARTIFACT changed — answer with intent=chat telling them to just describe the change.`;

const SYSTEM = `You are the SQL workbench stage of text2UI: the user is chatting with a live database (MySQL or Postgres) attached READ-ONLY through DuckDB as "src".
Study the schema and the conversation, then emit ONE JSON turn plan.

Rules for SQL (intent=query or preview):
- Emit exactly ONE SELECT (a WITH...SELECT is fine). NEVER any write, DDL, ATTACH, COPY, or PRAGMA.
- Reference every table by the EXACT "SQL ref" shown for it in the schema below (e.g. src."public"."orders"). Never invent table or column names.
- DuckDB dialect (regardless of the source engine): date_trunc('month', col), count(*), double-quoted identifiers — no backticks, no engine-specific functions.
- For questions ("which region sold most?") prefer grouped aggregates with ORDER BY and a small LIMIT.
- For previews ("show me the orders table") emit SELECT * FROM <SQL ref> LIMIT 20.

Rules for intent=extract: the user wants to SAVE tables for later use elsewhere ("extract/keep/store/save X and Y", "we'll need these later"). Put the exact table names (as listed, e.g. "orders" or "sales.orders") in tables[].

Rules for intent=build: the user asks to MAKE a dashboard/deck/report from tables ("make a dashboard out of orders and customers"). Put table names in tables[], write a complete buildPrompt, set artifact ("slides/deck/ppt" -> ppt, otherwise dashboard).

Rules for intent=chat: schema questions, greetings, capability questions. Answer directly in reply using the schema — list real table names and row counts.

DEFAULT TO ACTING: prefer query over chat when a question is answerable from the data. Never ask for clarification when a reasonable reading exists.`;

const SCHEMA_TOP_N = Number(process.env.T2SQL_SCHEMA_TOP_N ?? 12);

const tokenize = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Deterministic lexical relevance ranking (blueprint: "retrieve only the most
 *  relevant tables per turn"). Scores each table against the prompt + recent
 *  history: exact table-name mention dominates, then name-token and column-name
 *  overlap. Ties keep catalog order, so behavior is stable and testable. On
 *  small catalogs (≤ topN) everything is sent, exactly as before. */
export function rankTables(
  prompt: string,
  history: { content: string }[] | undefined,
  allTables: PlanSqlInput["allTables"],
  datasets: Dataset[],
  topN = SCHEMA_TOP_N,
): { detailed: PlanSqlInput["allTables"]; rest: PlanSqlInput["allTables"] } {
  if (allTables.length <= topN) return { detailed: allTables, rest: [] };
  const text = [prompt, ...(history ?? []).slice(-6).map((m) => m.content)].join(" ").toLowerCase();
  const words = new Set(tokenize(text));
  const cols = new Map(datasets.map((d) => [d.tableName, d.profile.columns.map((c: any) => String(c.name).toLowerCase())] as const));
  const scored = allTables.map((t, i) => {
    let score = 0;
    const nameLc = t.name.toLowerCase();
    if (text.includes(nameLc)) score += 100;                       // literal mention wins
    for (const tok of tokenize(t.name)) if (words.has(tok)) score += 5;
    for (const c of cols.get(t.name) ?? []) if (words.has(c)) score += 1;
    return { t, i, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return { detailed: scored.slice(0, topN).map((x) => x.t), rest: scored.slice(topN).map((x) => x.t) };
}

/** Clip long sample values so one wide text column can't bloat the prompt. */
const clipSample = (r: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const k in r) {
    const v = r[k];
    out[k] = typeof v === "string" && v.length > 40 ? v.slice(0, 37) + "…" : v;
  }
  return out;
};

function describeSchema(input: PlanSqlInput): string {
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
  if (rest.length) {
    lines.push(`Other available tables (reference as src."<schema>"."<table>"; ask about one to see its columns): ${rest.map((t) => t.name).join(", ")}`);
  }
  return lines.join("\n");
}

function buildUserPrompt(input: PlanSqlInput): string {
  const hist = input.history?.length
    ? "Conversation so far:\n" + input.history.map((m) => `${m.role}: ${m.content}`).join("\n") + "\n\n"
    : "";
  const src = input.mode === "snapshot" ? "Extracted snapshot" : `${input.dialect === "postgres" ? "Postgres" : "MySQL"} schema (attached as "src")`;
  return `${hist}${src}:\n${describeSchema(input)}\n\nUser message: ${input.prompt}`;
}

const stripFences = (s: string) => s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

export interface PlanSqlInput {
  prompt: string;
  /** "snapshot": planning over an extracted local DuckDB (refs are bare, no src.) */
  mode?: "live" | "snapshot";
  dialect?: "mysql" | "postgres";
  allTables: { name: string; approxRows: number; ref?: string; schema?: string }[];
  datasets: Dataset[];
  history?: ChatMessage[];
}
export type PlanSqlRun = (s: string, u: string, o?: GenOptions) => Promise<GenResult>;

/** Plan one workbench turn. Returns null on any failure (handler falls back). */
export async function planSqlTurn(
  input: PlanSqlInput,
  run: PlanSqlRun = callGemini,
  timeoutMs = PLAN_TIMEOUT_MS,
): Promise<SqlTurnPlan | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<SqlTurnPlan | null> => {
    try {
      const system = input.mode === "snapshot" ? SYSTEM_SNAPSHOT_HEAD + "\n" + SYSTEM.split("\n").slice(1).join("\n") : SYSTEM;
      const { text } = await run(system, buildUserPrompt(input), { ...ORCHESTRATE_OPTS, responseSchema: SQL_PLAN_SCHEMA });
      const parsed = JSON.parse(stripFences(text)) as SqlTurnPlan;
      if (!parsed || typeof parsed !== "object") return null;
      if (!["query", "preview", "extract", "build", "chat"].includes(parsed.intent)) return null;
      // Minimal shape checks per intent — the guard/handler harden the rest.
      if ((parsed.intent === "query" || parsed.intent === "preview") && typeof parsed.sql !== "string") return null;
      if ((parsed.intent === "extract" || parsed.intent === "build") && !Array.isArray(parsed.tables)) return null;
      console.log(`[text2sql] plan: intent=${parsed.intent}${parsed.tables?.length ? ` tables=${parsed.tables.join(",")}` : ""}`);
      return parsed;
    } catch (err: any) {
      console.warn(`[text2sql] planner failed: ${err?.message ?? err}`);
      return null;
    }
  })();
  return Promise.race([call, timeout]);
}
