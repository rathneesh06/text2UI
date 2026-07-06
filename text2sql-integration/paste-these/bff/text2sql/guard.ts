// bff/text2sql/guard.ts — the safety gate between the planner LLM and the executor.
//
// The planner is treated as unreliable by design (same philosophy as the deck
// pipeline's validators): whatever SQL it emits must pass through here before it
// can touch a database. Three layers, cheapest first:
//   1. normalize   — strip markdown fences / trailing semicolons the model loves to add
//   2. assertReadOnly (storage/guard) — single statement, SELECT/WITH/FROM only,
//      banned-keyword scan (INSERT/UPDATE/DROP/ATTACH/COPY/…)
//   3. cap         — guarantee a LIMIT by wrapping the query in a subselect.
//      Wrapping (rather than regex-appending "LIMIT n") is dialect-safe: it works
//      for ORDER BY tails, CTEs, and UNIONs alike, and DuckDB flattens it away.
//
// Note the underlying MySQL ATTACH is READ_ONLY and workbench snapshots are local
// DuckDB files, so this guard is defense-in-depth, not the only wall.
import { assertReadOnly, stripSqlNoise } from "../storage/guard";

export interface GuardOk { ok: true; sql: string; capped: boolean }
export interface GuardErr { ok: false; error: string }
export type GuardResult = GuardOk | GuardErr;

const FENCE_RE = /^```(?:sql)?\s*([\s\S]*?)\s*```$/i;
const LIMIT_RE = /\blimit\s+(\d+)\b/i;

/** Strip a ```sql fence if the model wrapped the query in one. */
export function unfence(raw: string): string {
  const s = (raw ?? "").trim();
  const m = s.match(FENCE_RE);
  return (m ? m[1] : s).trim();
}

/** Validate + cap a planner-emitted query. Never throws — callers branch on ok. */
export function guardSelect(raw: string, maxRows = 500): GuardResult {
  let sql = unfence(raw).replace(/;\s*$/, "").trim();
  if (!sql) return { ok: false, error: "planner produced empty SQL" };

  try {
    assertReadOnly(sql);
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "SQL rejected by read-only guard" };
  }

  // Guarantee a row cap. If the query already carries a LIMIT at or under the cap,
  // trust it; otherwise wrap. (A LIMIT inside a CTE/subquery that this regex hits
  // just means we wrap unnecessarily — harmless, never unsafe.)
  const m = stripSqlNoise(sql).match(LIMIT_RE);
  const declared = m ? Number(m[1]) : NaN;
  if (Number.isFinite(declared) && declared > 0 && declared <= maxRows) {
    return { ok: true, sql, capped: false };
  }
  return { ok: true, sql: `SELECT * FROM (${sql}) AS _t2sql_capped LIMIT ${maxRows}`, capped: true };
}
