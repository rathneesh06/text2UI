// bff/text2sql/composer.ts — turns real query results into a short, grounded
// chat reply. Same reliability posture as the rest of the system: the LLM writes
// the prose, but every number it may cite is already computed and sitting in the
// rows we hand it — and if the call fails, composeFallback() guarantees the user
// still gets a useful deterministic answer (drop-not-crash).
import { callGemini, PLAN_OPTS, type GenOptions, type GenResult } from "../aiflow";

const COMPOSE_TIMEOUT_MS = Number(process.env.T2SQL_COMPOSE_TIMEOUT_MS ?? 15_000);
const MAX_ROWS_IN_PROMPT = 50;

// The voice deliberately matches INTERPRET_SYSTEM in ./interpret.ts — the main
// chat and the /select chat should not sound like different products. Two
// differences are intentional here:
//   1. No markdown TABLES. ChatPage renders the result grid itself, so a table
//      in the prose duplicates what is already on screen. (Other markdown is
//      now fine — ChatPage renders it via ChatMarkdown.)
//   2. This stage is given the rows outright and never asks for more queries,
//      so it has no need_more escape hatch.
// This prompt, not the code below it, is what decides whether the chat feels
// like an analyst or a query tool. Edit it first when replies feel wrong.
const SYSTEM = `You are a data analyst talking to a colleague. You are given their question, the SQL that was executed, and the ACTUAL result rows.

Your job is to explain what the data MEANS, not to recite it.

- Open with the finding, in a full sentence. "Revenue fell 12% in October, the first drop in five months." Not "October: 41,203".
- Then say what's behind it — the breakdown, the outlier, the trend, whichever the numbers actually support. Two or three short paragraphs at most.
- Quantify. Percentages, deltas, ratios, shares of total. Compute them yourself from the rows; don't make the reader do arithmetic.
- Every number, name, and fact MUST come from the result rows. Never invent or extrapolate values — derived percentages and deltas are fine, invented rows are not.
- Point out anything that looks off: nulls where you'd expect values, a category taking a suspicious share, a date range that stops early, counts that don't reconcile. A colleague would mention it.
- Be honest about limits. If the query answers a narrower question than the one asked, say which. If a number looks wrong rather than interesting, say that instead of dressing it up.
- If the result is empty, say so plainly and suggest what to check.
- No preamble, no "Based on the data provided", no restating the question or the SQL, no apologising.

Formatting: markdown. Short paragraphs. A bullet list only when the content is genuinely a list. **Bold** for the numbers that matter. Never a markdown table — the client renders the result grid itself, so a table here just duplicates it.`;

export type ComposeRun = (s: string, u: string, o?: GenOptions) => Promise<GenResult>;

export interface ComposeInput {
  question: string;
  sql: string;
  rows: Record<string, unknown>[];
  truncated?: boolean;
}

/** Deterministic reply used when the LLM is unavailable — still real information.
 *
 *  Says WHY it is terse, the same way fallbackSummary() in ./interpret.ts does.
 *  A bare "Returned 42 rows" is indistinguishable from a deliberately curt
 *  answer, so the user has no way to tell a working system from a degraded one.
 *
 *  `modelDown` separates the two reasons a caller lands here: the model failed,
 *  or the result was too trivial to be worth a model call. Callers that skip the
 *  model on purpose (the single-cell case) pass false and get no apology. */
export function composeFallback(input: ComposeInput, modelDown = true): string {
  const n = input.rows.length;
  const why = modelDown ? " (the model didn't respond)" : "";
  if (!n) return `The query ran successfully but returned no rows.${modelDown ? " I couldn't write it up — the model didn't respond." : ""}`;
  const cols = Object.keys(input.rows[0] ?? {});
  if (n === 1 && cols.length === 1) return `Result: ${cols[0]} = ${String(input.rows[0][cols[0]])}.`;
  return `I got the data but couldn't write it up${why}. Returned ${n}${input.truncated ? "+" : ""} row${n === 1 ? "" : "s"} (${cols.join(", ")}). See the result grid below.`;
}

/** LLM-grounded reply with the deterministic fallback. Never throws. */
export async function composeAnswer(
  input: ComposeInput,
  run: ComposeRun = callGemini,
  timeoutMs = COMPOSE_TIMEOUT_MS,
): Promise<string> {
  const sample = input.rows.slice(0, MAX_ROWS_IN_PROMPT);
  const user =
    `Question: ${input.question}\n\nSQL executed:\n${input.sql}\n\n` +
    `Result rows (${input.rows.length}${input.truncated ? ", truncated" : ""}` +
    `${input.rows.length > sample.length ? `; showing first ${sample.length}` : ""}):\n` +
    JSON.stringify(sample);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async () => {
    try {
      const { text } = await run(SYSTEM, user, PLAN_OPTS);
      const t = text.trim();
      return t.length ? t : null;
    } catch {
      return null;
    }
  })();
  const out = await Promise.race([call, timeout]);
  return out ?? composeFallback(input);
}
