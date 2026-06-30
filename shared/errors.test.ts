import assert from "node:assert";
import { classifyError, healPolicy, GLOBAL_RETRY_MAX, type ErrorClass } from "./errors";

// ---- classifier sanity (full coverage lives in bff/heal.test.ts) ----------
{
  assert.equal(classifyError('Binder Error: Referenced column "x" not found'), "duckdb_sql");
  assert.equal(classifyError('"rows" is read-only'), "read_only");
  assert.equal(classifyError("Cannot read properties of undefined"), "react_runtime");
  assert.equal(classifyError(""), "unknown");
}

// ---- per-class caps: retry up to the cap, then stop -----------------------
{
  // duckdb_sql cap is 2: attempts 0,1 retry; attempt 2 stops.
  const d0 = healPolicy("duckdb_sql", 0, 0);
  const d1 = healPolicy("duckdb_sql", 1, 1);
  const d2 = healPolicy("duckdb_sql", 2, 2);
  assert.ok(d0.shouldRetry && d1.shouldRetry, "duckdb_sql retries within cap");
  assert.ok(!d2.shouldRetry, "duckdb_sql stops at its cap");
  assert.match(d2.reason, /cap/, "stop reason mentions the cap");

  // timeout/empty_result cap is 1: attempt 0 retries, attempt 1 stops.
  assert.ok(healPolicy("timeout", 0, 0).shouldRetry, "timeout retries once");
  assert.ok(!healPolicy("timeout", 1, 1).shouldRetry, "timeout stops after one try");
  assert.ok(healPolicy("empty_result", 0, 0).shouldRetry, "empty_result retries once");
  assert.ok(!healPolicy("empty_result", 1, 1).shouldRetry, "empty_result stops after one try");
}

// ---- exponential backoff --------------------------------------------------
{
  const a = healPolicy("react_runtime", 0, 0).delayMs;
  const b = healPolicy("react_runtime", 1, 1).delayMs;
  assert.ok(a > 0 && b === a * 2, `backoff doubles (${a} -> ${b})`);
}

// ---- global ceiling prevents infinite loops across shifting classes -------
{
  // Even if each class still has budget, the global total cap halts retries.
  const decision = healPolicy("react_runtime", 0, GLOBAL_RETRY_MAX);
  assert.ok(!decision.shouldRetry, "global cap halts retry regardless of class budget");
  assert.match(decision.reason, /global/, "stop reason mentions the global cap");

  // Simulate a worst-case loop: classes keep changing; total must still terminate.
  const classes: ErrorClass[] = ["duckdb_sql", "react_runtime", "ts_compile", "read_only", "timeout"];
  let total = 0;
  const byClass: Record<string, number> = {};
  let iterations = 0;
  while (iterations < 50) {
    const cls = classes[iterations % classes.length];
    const ca = byClass[cls] ?? 0;
    const dec = healPolicy(cls, ca, total);
    if (!dec.shouldRetry) break;
    total += 1;
    byClass[cls] = ca + 1;
    iterations += 1;
  }
  assert.ok(total <= GLOBAL_RETRY_MAX, `total auto-heals never exceed the global cap (got ${total})`);
  assert.ok(iterations < 50, "loop terminates (no infinite retry)");
}

console.log("errors.test.ts: all assertions passed");
