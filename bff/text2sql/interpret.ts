// bff/text2sql/interpret.ts — the analyst that INTERPRETS rather than reports,
// and is allowed more than one query per turn.
//
// WHAT CHANGED AND WHY
// The old single pass was told to answer "in one or two sentences" and then list
// rows as "label: value" (ANSWER_SYSTEM in selection.ts). That is a report. A
// person asking "how are sales doing?" wants to know that October fell 12% after
// four flat months and that one region drove all of it — which needs the shape of
// the data, not one number, and often needs a second query to find out where the
// drop came from.
//
// So: a planning pass may emit SEVERAL queries, results come back together, and a
// composition pass may ask for ONE more round before it answers.
//
// THE CAPS ARE THE POINT. This runs against whatever production database the user
// pasted a string for. An uncapped agentic loop is a way to put a service under
// load from a chat box. Three limits, all enforced here rather than trusted to
// the prompt:
//   T2SQL_SELECT_MAX_QUERIES  total queries per turn        (default 3)
//   T2SQL_SELECT_MAX_ROUNDS   planning rounds per turn      (default 2)
//   T2SQL_SELECT_BUDGET_MS    wall clock for the whole turn (default 45000)
// Whichever binds first wins, and the composer answers with what it has. A turn
// that runs out of budget still replies — it just says the picture is partial.
//
// Every query still goes through guardSelect() and then a READ ONLY transaction.
// This module adds a loop; it does not add a second SQL guard, and must not.
import type { ChatMessage } from "../../shared/types";

export interface QueryRunner {
  (sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; elapsedMs: number }>;
}
export interface Guard { (sql: string, rowCap?: number): { ok: true; sql: string } | { ok: false; error: string } }
export interface ChatModelRun { (system: string, user: string): Promise<{ text: string }> }

export interface QueryOutcome {
  sql: string;
  ok: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  elapsedMs: number;
  error?: string;
}

export interface AnalystResult {
  answer: string | null;
  outcomes: QueryOutcome[];
  rounds: number;
  // "compose_skipped": the caller's shouldCompose() said this result has nothing
  // worth interpreting (a single cell, an empty set), so the model was never
  // called. answer is null and the caller supplies its own deterministic text.
  stoppedBy: "answered" | "max_queries" | "max_rounds" | "budget" | "model_unavailable" | "compose_skipped";
}

const MAX_QUERIES = () => Math.max(1, Number(process.env.T2SQL_SELECT_MAX_QUERIES ?? 3));
const MAX_ROUNDS = () => Math.max(1, Number(process.env.T2SQL_SELECT_MAX_ROUNDS ?? 2));
const BUDGET_MS = () => Math.max(5_000, Number(process.env.T2SQL_SELECT_BUDGET_MS ?? 45_000));

// ---- prompts ---------------------------------------------------------------------

/** Composition. This is the prompt that decides whether the chat feels like an
 *  analyst or a query tool, so it is the first place to edit when replies feel
 *  wrong — not the code below it. */
export const INTERPRET_SYSTEM = `You are a data analyst talking to a colleague about their database. You have just run one or more queries and have the results.

Your job is to explain what the data MEANS, not to recite it.

- Open with the finding, in a full sentence. "Revenue fell 12% in October, the first drop in five months." Not "October: 41,203".
- Then say what's behind it — the breakdown, the outlier, the trend, whichever the numbers actually support. Two or three short paragraphs at most.
- Quantify. Percentages, deltas, ratios, shares of total. Compute them yourself from the rows; don't make the reader do arithmetic.
- Point out anything that looks off: nulls where you'd expect values, a category taking a suspicious share, a date range that stops early, counts that don't reconcile. A colleague would mention it.
- Be honest about limits. If the query answers a narrower question than the one asked, say which. If a number looks wrong rather than interesting, say that instead of dressing it up.
- No preamble, no "Based on the data provided", no restating the question.

Formatting: markdown. Short paragraphs. A bullet list only when the content is genuinely a list. **Bold** for the numbers that matter. Never a markdown table — this renders in a narrow chat column.

IF THE RESULTS ARE NOT ENOUGH to answer well, and you can name a specific query that would close the gap, reply with ONLY this JSON and nothing else:
{"need_more": ["SELECT ..."]}
Use that sparingly — only when the follow-up genuinely changes the answer, never to explore. Each query must be a single read-only SELECT.`;

/** Planning. Emits selection ops and/or up to N queries in one shot, so the
 *  common "add orders and tell me how they're trending" turn costs one round. */
export const ANALYST_PLAN_SYSTEM = `You plan how to answer a question about a database. You do not answer it yourself.

Reply with ONLY a JSON object:
{"sql": ["SELECT ..."], "reply": "optional short note"}

- "sql": zero or more single-statement read-only SELECT queries, at most {{MAX}}. Ask for several when the question genuinely needs them — a total AND its breakdown, or two periods to compare. Ask for none when the question isn't about the data.
- Every query must stand alone. They run independently, not in sequence.
- Use ONLY tables and columns that appear in the catalog you were given. Never invent a name.
- Prefer aggregates over raw rows. You are answering a question, not exporting data.
- "reply": only when there is something to say that isn't in the data.`;

// ---- the loop --------------------------------------------------------------------

function parseNeedMore(text: string): string[] | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const j = JSON.parse(t.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    const list = Array.isArray(j?.need_more) ? j.need_more : null;
    if (!list?.length) return null;
    return list.map((s: unknown) => String(s)).filter(Boolean);
  } catch { return null; }
}

/** Compact JSON beats a formatted table: cheaper, and the model reads it as well.
 *  Row cap per result set keeps one wide query from eating the whole prompt. */
function renderOutcomes(outcomes: QueryOutcome[], perQuery = 40): string {
  return outcomes.map((o, i) => {
    if (!o.ok) return `Query ${i + 1}:\n${o.sql}\nFAILED: ${o.error}`;
    const shown = o.rows.slice(0, perQuery);
    return [
      `Query ${i + 1}:`,
      o.sql,
      `Columns: ${o.columns.join(", ") || "(none)"}`,
      `Rows (${o.rows.length}${o.truncated ? "+, truncated" : ""}${shown.length < o.rows.length ? `, showing ${shown.length}` : ""}):`,
      JSON.stringify(shown),
    ].join("\n");
  }).join("\n\n");
}

/**
 * Execute a planned batch, then let the composer ask for one more round.
 *
 * `plannedSql` is whatever the planning pass produced. Deps are injected so the
 * whole loop is testable with no network — the same posture as the route
 * handlers and `snapshotFromHandle`.
 */
export async function runChatAnalyst(
  input: { prompt: string; plannedSql: string[]; history?: ChatMessage[] },
  deps: {
    runQuery: QueryRunner; guard: Guard; model: ChatModelRun; rowCap?: number; onQuery?: (sql: string) => void;
    // Caps may be supplied per caller. The /select analyst hits a live production
    // database and keeps the tight T2SQL_ANALYST_* defaults; the main chat runs
    // against a local DuckDB snapshot where an extra query costs milliseconds and
    // can't touch anyone's production system, so it passes its own T2SQL_SOURCE_*
    // values. Omit them and the defaults below still apply — additive, not a
    // behaviour change for existing callers.
    maxQueries?: number; maxRounds?: number; budgetMs?: number;
    /** Latency escape hatch: return false to skip the composition pass entirely.
     *  A single-cell or empty result has nothing to interpret, and a model call
     *  to say "the count is 42" is pure latency. Queries have already run when
     *  this is consulted, so the caller decides from real outcomes. */
    shouldCompose?: (outcomes: QueryOutcome[]) => boolean;
  },
): Promise<AnalystResult> {
  const started = Date.now();
  const maxQueries = Math.max(1, deps.maxQueries ?? MAX_QUERIES());
  const maxRounds = Math.max(1, deps.maxRounds ?? MAX_ROUNDS());
  const budget = Math.max(5_000, deps.budgetMs ?? BUDGET_MS());
  const outcomes: QueryOutcome[] = [];
  let stoppedBy: AnalystResult["stoppedBy"] = "answered";

  const budgetLeft = () => budget - (Date.now() - started);

  const runBatch = async (sqls: string[]): Promise<void> => {
    for (const raw of sqls) {
      if (outcomes.length >= maxQueries) { stoppedBy = "max_queries"; return; }
      if (budgetLeft() <= 0) { stoppedBy = "budget"; return; }
      const g = deps.guard(raw, deps.rowCap);
      if (!g.ok) {
        outcomes.push({ sql: raw, ok: false, columns: [], rows: [], truncated: false, elapsedMs: 0, error: g.error });
        console.warn(`[chat-analyst] query rejected: ${g.error} — ${raw.slice(0, 200)}`);
        continue;
      }
      deps.onQuery?.(g.sql);
      console.log(`[chat-analyst] query: ${g.sql.replace(/\s+/g, " ").slice(0, 300)}`);
      try {
        const r = await deps.runQuery(g.sql);
        outcomes.push({ sql: g.sql, ok: true, columns: r.columns, rows: r.rows, truncated: r.truncated, elapsedMs: r.elapsedMs });
        console.log(`[chat-analyst] query returned ${r.rows.length} row(s) in ${r.elapsedMs}ms`);
      } catch (err: any) {
        // A failed query is information — usually a wrong column or a permission
        // gap. Hand it to the composer rather than swallowing it.
        const msg = (err?.message || String(err)).trim() || "no error message reported";
        outcomes.push({ sql: g.sql, ok: false, columns: [], rows: [], truncated: false, elapsedMs: 0, error: msg });
        console.warn(`[chat-analyst] query failed: ${msg}`);
      }
    }
  };

  await runBatch(input.plannedSql.slice(0, maxQueries));
  if (!outcomes.length) return { answer: null, outcomes, rounds: 0, stoppedBy };
  if (deps.shouldCompose && !deps.shouldCompose(outcomes)) {
    return { answer: null, outcomes, rounds: 0, stoppedBy: "compose_skipped" };
  }

  for (let round = 1; round <= maxRounds; round++) {
    if (budgetLeft() <= 0) {
      stoppedBy = "budget";
      break;
    }
    const body = [
      input.history?.length
        ? "Recent conversation:\n" + input.history.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n") + "\n"
        : "",
      `Question: ${input.prompt}`,
      renderOutcomes(outcomes),
      round >= maxRounds || outcomes.length >= maxQueries
        ? "This is the final round — answer with what you have. Do not request more queries."
        : "",
    ].filter(Boolean).join("\n\n");

    let text: string;
    try {
      text = String((await deps.model(INTERPRET_SYSTEM, body)).text ?? "").trim();
    } catch (err: any) {
      console.warn(`[chat-analyst] composition failed: ${err?.message ?? err}`);
      return { answer: null, outcomes, rounds: round, stoppedBy: "model_unavailable" };
    }
    if (!text) return { answer: null, outcomes, rounds: round, stoppedBy: "model_unavailable" };

    const more = parseNeedMore(text);
    if (!more) return { answer: text, outcomes, rounds: round, stoppedBy: "answered" };

    if (round >= maxRounds) { stoppedBy = "max_rounds"; break; }
    if (outcomes.length >= maxQueries) { stoppedBy = "max_queries"; break; }
    console.log(`[chat-analyst] follow-up round ${round + 1}: ${more.length} query(ies)`);
    await runBatch(more);
  }

  // Caps bound the loop, so a last composition is forced rather than looping.
  try {
    const body = [
      `Question: ${input.prompt}`,
      renderOutcomes(outcomes),
      "This is the final round — answer with what you have. Do not request more queries.",
    ].join("\n\n");
    const text = String((await deps.model(INTERPRET_SYSTEM, body)).text ?? "").trim();
    const more = parseNeedMore(text);
    return { answer: more ? null : (text || null), outcomes, rounds: maxRounds, stoppedBy };
  } catch {
    return { answer: null, outcomes, rounds: maxRounds, stoppedBy: "model_unavailable" };
  }
}

/** Deterministic last resort, unchanged in spirit from describeRows(): when the
 *  model can't write the sentence, show the result rather than swallowing it.
 *  Never pretty, always honest — and now it says WHY it's terse. */
export function fallbackSummary(outcomes: QueryOutcome[]): string {
  if (!outcomes.length) return "I couldn't run a query for that.";
  const parts = outcomes.map((o, i) => {
    if (!o.ok) return `Query ${i + 1} failed: ${o.error}`;
    if (!o.rows.length) return `Query ${i + 1} returned no rows.`;
    const head = o.rows.slice(0, 8).map((row) => o.columns.map((c) => `${c}: ${row[c] ?? "—"}`).join(", "));
    const more = o.rows.length - head.length;
    return [`Query ${i + 1} — ${o.rows.length}${o.truncated ? "+" : ""} row(s):`, ...head, more > 0 ? `…and ${more} more.` : ""]
      .filter(Boolean).join("\n");
  });
  return ["I got the data but couldn't write it up (the model didn't respond). Raw results:", ...parts].join("\n\n");
}
