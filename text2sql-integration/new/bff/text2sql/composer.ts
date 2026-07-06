// bff/text2sql/composer.ts — turns real query results into a short, grounded
// chat reply. Same reliability posture as the rest of the system: the LLM writes
// the prose, but every number it may cite is already computed and sitting in the
// rows we hand it — and if the call fails, composeFallback() guarantees the user
// still gets a useful deterministic answer (drop-not-crash).
import { callGemini, PLAN_OPTS, type GenOptions, type GenResult } from "../aiflow";

const COMPOSE_TIMEOUT_MS = Number(process.env.T2SQL_COMPOSE_TIMEOUT_MS ?? 15_000);
const MAX_ROWS_IN_PROMPT = 50;

const SYSTEM = `You are the answer stage of a SQL workbench chat. You are given the user's question, the SQL that was executed, and the ACTUAL result rows.
Write a short natural-language answer (1-4 sentences).
- Every number, name, and fact in your answer MUST come from the result rows. Never invent or extrapolate values.
- Lead with the direct answer, then one supporting detail if useful.
- If the result is empty, say so plainly and suggest what to check.
- Do not restate the SQL, do not use markdown tables (the client renders the grid itself), do not apologize.`;

export type ComposeRun = (s: string, u: string, o?: GenOptions) => Promise<GenResult>;

export interface ComposeInput {
  question: string;
  sql: string;
  rows: Record<string, unknown>[];
  truncated?: boolean;
}

/** Deterministic reply used when the LLM is unavailable — still real information. */
export function composeFallback(input: ComposeInput): string {
  const n = input.rows.length;
  if (!n) return "The query ran successfully but returned no rows.";
  const cols = Object.keys(input.rows[0] ?? {});
  const single = n === 1 && cols.length === 1;
  if (single) return `Result: ${cols[0]} = ${String(input.rows[0][cols[0]])}.`;
  return `Returned ${n}${input.truncated ? "+" : ""} row${n === 1 ? "" : "s"} (${cols.join(", ")}). See the result grid below.`;
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
