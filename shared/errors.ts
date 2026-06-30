// shared/errors.ts — pure error classification + auto-heal retry policy.
// Shared by the SERVER (heal-prompt hints, bff/heal.ts) and the BROWSER
// (bounded auto-heal loop, DashboardPage). No dependencies, no secrets — safe
// to import from both src/ and bff/.

export type ErrorClass =
  | "read_only"
  | "duckdb_sql"
  | "timeout"
  | "empty_result"
  | "ts_compile"
  | "react_runtime"
  | "unknown";

/** Classify a raw error string into a repair class. Order matters: the most
 *  specific / highest-signal patterns are tested first. */
export function classifyError(raw: string): ErrorClass {
  const e = (raw || "").toLowerCase();
  if (!e.trim()) return "unknown";

  // Immutable assignment (imported binding, const, or reserved global).
  if (/read[- ]?only|assignment to constant|invalid assignment|cannot assign to (read only|constant)/.test(e)) {
    return "read_only";
  }

  // DuckDB SQL errors — matched on DuckDB's own categories/phrasings, not bare
  // "does not exist" (which could be a module-resolution message).
  if (
    /\b(binder|catalog|parser|conversion|invalid input|out of range)\s+error\b/.test(e) ||
    /referenced column .* not found|candidate bindings|table with name .* does not exist|no function matches the given name|referenced table .* not found|syntax error at or near/.test(e)
  ) {
    return "duckdb_sql";
  }

  if (/timed out|timeout|deadline exceeded|etimedout|operation was aborted/.test(e)) return "timeout";

  if (/\bno rows\b|empty result|\bno data\b|result set is empty|returned 0 rows/.test(e)) return "empty_result";

  if (
    /transform failed|could not resolve|cannot find module|failed to compile|unexpected token|unterminated|expected .* but (found|got)|module not found|\bts\d{3,}\b/.test(e)
  ) {
    return "ts_compile";
  }

  if (
    /is not a function|cannot read propert|cannot access .* before initialization|undefined is not|not valid as a react child|maximum update depth|too many re-?renders|hooks can only be called|rendered (more|fewer) hooks|invalid hook call/.test(e)
  ) {
    return "react_runtime";
  }

  return "unknown";
}

/** Pull the offending column name out of a DuckDB "column not found" message. */
export function extractMissingColumn(raw: string): string | null {
  const m =
    /referenced column ["'`]?([A-Za-z_][\w]*)["'`]?\s+not found/i.exec(raw) ||
    /column ["'`]?([A-Za-z_][\w]*)["'`]?\s+does not exist/i.exec(raw);
  return m ? m[1] : null;
}

// ---- auto-heal retry policy ------------------------------------------------
// Per-class caps on how many times the browser will AUTOMATICALLY ask the model
// to fix an error before giving up and surfacing it. Plus a hard global ceiling
// so a shifting error class can never produce an infinite loop.

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  reason: string;
}

const MAX_BY_CLASS: Record<ErrorClass, number> = {
  read_only: 2,
  duckdb_sql: 2,
  react_runtime: 2,
  ts_compile: 2,
  empty_result: 1, // a genuine no-data condition shouldn't loop — one try to add an empty state
  timeout: 1,      // simplify once; if it still times out, stop
  unknown: 1,
};

export const GLOBAL_RETRY_MAX = 3; // hard ceiling across ALL classes
const BASE_DELAY_MS = 800;

/**
 * Decide whether to auto-retry an error.
 * @param cls           the classified error
 * @param classAttempt  heals ALREADY tried for this class (0 = none yet)
 * @param totalAttempts heals ALREADY tried across all classes this episode
 */
export function healPolicy(cls: ErrorClass, classAttempt: number, totalAttempts = classAttempt): RetryDecision {
  if (totalAttempts >= GLOBAL_RETRY_MAX) {
    return { shouldRetry: false, delayMs: 0, reason: `reached the global retry cap (${GLOBAL_RETRY_MAX})` };
  }
  const cap = MAX_BY_CLASS[cls] ?? 1;
  if (classAttempt >= cap) {
    return { shouldRetry: false, delayMs: 0, reason: `reached the ${cls} retry cap (${cap})` };
  }
  const delayMs = BASE_DELAY_MS * Math.pow(2, classAttempt); // 800ms, 1600ms, ...
  return { shouldRetry: true, delayMs, reason: `${cls} attempt ${classAttempt + 1}/${cap}` };
}
