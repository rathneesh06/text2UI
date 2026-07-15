// bff/text2sql/grounding.ts — Stage 1 of the analyst loop: SEMANTIC GROUNDING.
//
// Naive NL→SQL fails on prompts like "trends in SOS last 30 days" because "SOS"
// is usually a CELL VALUE (ticket_type = 'SOS'), not a table or column. This
// stage finds such links before any analysis SQL is written:
//   1. keyword extraction — one small fail-soft LLM call, ALWAYS merged with a
//      deterministic pass (quoted phrases + ALL-CAPS tokens), so a term like
//      "SOS" never depends on the model to be noticed.
//   2. value probing — guarded `SELECT DISTINCT col … LIMIT n` queries against
//      text-ish columns of the top-ranked tables, run on the LIVE attach. Every
//      probe passes guardSelect; probes are bounded (columns × values) so this
//      can never storm the database.
// The output (GroundingNotes) is prompt material for the analysis planner:
// "'SOS' is a value of tickets.ticket_type" turns a naive query into a semantic one.
import type { ChatMessage, Dataset } from "../../shared/types";
import { callGemini, ORCHESTRATE_OPTS, type GenOptions, type GenResult } from "../aiflow";
import { guardSelect } from "./guard";
import { rankTables, type PlanSqlInput } from "./planner";

const KEYWORD_TIMEOUT_MS = Number(process.env.T2SQL_GROUNDING_TIMEOUT_MS ?? 8_000);
const MAX_PROBE_COLUMNS = Number(process.env.T2SQL_PROBE_MAX_COLUMNS ?? 12);
const MAX_PROBE_VALUES = Number(process.env.T2SQL_PROBE_MAX_VALUES ?? 40);
const MAX_VALUE_HITS = 12;

export type GroundingRun = (s: string, u: string, o?: GenOptions) => Promise<GenResult>;

export interface ValueHit {
  keyword: string;
  table: string;    // display name
  column: string;
  value: string;    // the actual cell value as stored
  ref: string;      // exact SQL ref of the table (e.g. src."public"."tickets")
}

export interface GroundingNotes {
  keywords: string[];
  valueHits: ValueHit[];
  probedColumns: number;
  warnings: string[];
}

const KEYWORD_SCHEMA = {
  type: "object",
  properties: {
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "3-8 short search terms from the request: entity names, category values, statuses, metrics. NOT generic words (show, make, dashboard, data).",
    },
  },
  required: ["keywords"],
};

const KEYWORD_SYSTEM = `Extract the concrete search terms from a data-analysis request: names of entities, categories, statuses, products, regions, metrics — the words one would grep a database for. Exclude verbs and generic analytics words (dashboard, chart, trend, show, build, data). Output JSON only.`;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "what", "which", "are", "was", "were",
  "show", "make", "build", "give", "get", "over", "into", "per", "all", "any", "our", "your",
  "last", "past", "next", "days", "weeks", "months", "years", "current", "recent",
  "dashboard", "chart", "charts", "graph", "report", "trend", "trends", "data", "insight", "insights",
]);

/** Deterministic keyword pass: quoted phrases and ALL-CAPS tokens are ALWAYS
 *  keywords (this is what makes "SOS" model-independent); plus plain words that
 *  survive the stopword filter. Exported for tests. */
export function deterministicKeywords(prompt: string): string[] {
  const out = new Set<string>();
  for (const m of prompt.matchAll(/["'“”]([^"'“”]{2,40})["'“”]/g)) out.add(m[1].trim());
  for (const m of prompt.matchAll(/\b[A-Z][A-Z0-9_]{1,15}\b/g)) out.add(m[0]);
  for (const w of prompt.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
  }
  return [...out].slice(0, 16);
}

/** LLM keyword extraction, fail-soft, always merged with the deterministic pass. */
export async function extractKeywords(
  prompt: string,
  run: GroundingRun = callGemini,
  timeoutMs = KEYWORD_TIMEOUT_MS,
): Promise<string[]> {
  const det = deterministicKeywords(prompt);
  const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve(det), timeoutMs));
  const call = (async () => {
    try {
      const { text } = await run(KEYWORD_SYSTEM, prompt, { ...ORCHESTRATE_OPTS, responseSchema: KEYWORD_SCHEMA });
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim());
      const llm: string[] = Array.isArray(parsed?.keywords) ? parsed.keywords.map((k: unknown) => String(k).trim()).filter(Boolean) : [];
      return [...new Set([...llm, ...det])].slice(0, 16);
    } catch (err: any) {
      console.warn(`[grounding] keyword call failed -> deterministic only: ${err?.message ?? err}`);
      return det;
    }
  })();
  return Promise.race([call, timeout]);
}

const TEXTY_RE = /char|text|string|enum|varchar/i;
const quoteId = (s: string) => `"${String(s).replace(/"/g, '""')}"`;

/** Columns worth probing for value links: text-typed, in ranked-table order. */
export function probeCandidates(
  prompt: string,
  history: ChatMessage[] | undefined,
  allTables: PlanSqlInput["allTables"],
  datasets: Dataset[],
  maxColumns = MAX_PROBE_COLUMNS,
): { table: string; ref: string; column: string }[] {
  const { detailed } = rankTables(prompt, history, allTables, datasets, Math.max(6, Math.min(12, allTables.length)));
  const profiled = new Map(datasets.map((d) => [d.tableName, d] as const));
  const out: { table: string; ref: string; column: string }[] = [];
  for (const t of detailed) {
    const d = profiled.get(t.name);
    if (!d) continue;
    const ref = t.ref ?? quoteId(t.name);
    for (const c of d.profile.columns) {
      const type = String((c as any).type ?? "");
      const sample = d.profile.sampleRows?.[0]?.[c.name];
      const texty = TEXTY_RE.test(type) || (!type && typeof sample === "string");
      if (!texty) continue;
      out.push({ table: t.name, ref, column: c.name });
      if (out.length >= maxColumns) return out;
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().trim();

/** Probe distinct values of candidate columns on the live attach and match them
 *  against the keywords. Every probe is guarded; every failure is a warning,
 *  never a throw — grounding must improve the plan, never block it. */
export async function probeValues(input: {
  keywords: string[];
  candidates: { table: string; ref: string; column: string }[];
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>;
}): Promise<{ valueHits: ValueHit[]; probedColumns: number; warnings: string[] }> {
  const keywords = input.keywords.map(norm).filter((k) => k.length >= 2);
  const valueHits: ValueHit[] = [];
  const warnings: string[] = [];
  let probed = 0;
  for (const cand of input.candidates) {
    if (valueHits.length >= MAX_VALUE_HITS) break;
    const raw = `SELECT DISTINCT ${quoteId(cand.column)} AS v FROM ${cand.ref} WHERE ${quoteId(cand.column)} IS NOT NULL LIMIT ${MAX_PROBE_VALUES}`;
    const guarded = guardSelect(raw, MAX_PROBE_VALUES);
    if (!guarded.ok) { warnings.push(`probe skipped (${cand.table}.${cand.column}): ${guarded.error}`); continue; }
    try {
      const rows = await input.runQuery(guarded.sql);
      probed++;
      for (const r of rows) {
        const v = r.v;
        if (typeof v !== "string" || !v.trim()) continue;
        const nv = norm(v);
        for (const kw of keywords) {
          const hit = nv === kw || (kw.length >= 3 && nv.includes(kw)) || (nv.length >= 3 && kw.includes(nv));
          if (hit) {
            valueHits.push({ keyword: kw, table: cand.table, column: cand.column, value: v, ref: cand.ref });
            break;
          }
        }
        if (valueHits.length >= MAX_VALUE_HITS) break;
      }
    } catch (err: any) {
      warnings.push(`probe failed (${cand.table}.${cand.column}): ${err?.message ?? err}`);
    }
  }
  // Dedupe (same value can match several keywords).
  const seen = new Set<string>();
  const deduped = valueHits.filter((h) => {
    const k = `${h.ref}|${h.column}|${h.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { valueHits: deduped, probedColumns: probed, warnings };
}

/** The whole grounding stage. Never throws. */
export async function groundPrompt(input: {
  prompt: string;
  history?: ChatMessage[];
  allTables: PlanSqlInput["allTables"];
  datasets: Dataset[];
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>;
  run?: GroundingRun;
}): Promise<GroundingNotes> {
  const keywords = await extractKeywords(input.prompt, input.run);
  const candidates = probeCandidates(input.prompt, input.history, input.allTables, input.datasets);
  const { valueHits, probedColumns, warnings } = await probeValues({ keywords, candidates, runQuery: input.runQuery });
  if (valueHits.length) console.log(`[grounding] ${valueHits.length} value link(s): ${valueHits.slice(0, 4).map((h) => `${h.value}→${h.table}.${h.column}`).join(", ")}`);
  return { keywords, valueHits, probedColumns, warnings };
}

/** Prompt material for the analysis planner. */
export function describeGrounding(notes: GroundingNotes): string {
  if (!notes.valueHits.length) return "";
  const lines = notes.valueHits.map(
    (h) => `- '${h.value}' is a VALUE of column "${h.column}" in table ${h.table} (filter with WHERE "${h.column}" = '${h.value.replace(/'/g, "''")}' on ${h.ref})`,
  );
  return `Known value matches discovered by probing the database:\n${lines.join("\n")}`;
}
