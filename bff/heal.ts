// bff/heal.ts — Phase 5 (self-heal hardening), SERVER side.
// The pure classifier + retry policy live in shared/errors.ts (so the browser
// can use them for the bounded auto-heal loop). This module adds the SERVER-only
// piece: a targeted, schema-grounded repair HINT for the heal-turn prompt. The
// SQL hint re-grounds queries on the REAL schema — the prompt-level half of the
// data-error channel.

import { classifyError, extractMissingColumn, type ErrorClass } from "../shared/errors";

export { classifyError, extractMissingColumn };
export type { ErrorClass };

/** One table's real columns — used to re-ground SQL errors on actual columns. */
export interface SchemaHintTable {
  table: string;
  columns: string[];
}
export interface HealContext {
  schema?: SchemaHintTable[];
}

function schemaLine(schema?: SchemaHintTable[]): string {
  if (!schema || !schema.length) return "";
  return schema.map((t) => `${t.table}(${t.columns.join(", ")})`).join("; ");
}

/** A targeted repair hint for the given class. Always actionable (even "unknown"). */
export function healHint(cls: ErrorClass, ctx: HealContext = {}): string {
  switch (cls) {
    case "read_only":
      return "Hint (immutable assignment): the code assigned to something immutable — an imported binding (rows, tables, query, selectFeature), a const, or a reserved global (message, status, name, event, location). Copy imports into fresh local variables before changing them (e.g. const data = [...rows]), rename any variable that shadows a reserved global, and never reassign imports or consts.";
    case "duckdb_sql": {
      const cols = schemaLine(ctx.schema);
      const colsLine = cols ? ` Use ONLY these real columns: ${cols}.` : "";
      return (
        "Hint (DuckDB SQL error): a query referenced a column/table/function that does not exist or is mistyped." +
        colsLine +
        " Re-ground every query on the real columns above (do not invent columns). Push all aggregation into SQL (no reduce() over rows). For dates use date_trunc/strftime — never SUBSTR/LEFT on dates."
      );
    }
    case "timeout":
      return "Hint (timeout): the query or render took too long. Simplify the SQL (avoid cross joins and unbounded scans; add LIMIT where appropriate), and avoid expensive work in render.";
    case "empty_result":
      return "Hint (empty result): a query returned no rows. Render a graceful empty state instead of crashing (guard array access / chart inputs), and check that filters and joins are not over-restrictive.";
    case "ts_compile":
      return "Hint (compile error): fix the syntax/import problem. Import ONLY from react, recharts, lucide-react, ./data, ./selection. Emit valid TSX and keep the default export named App.";
    case "react_runtime":
      return "Hint (React runtime): guard against undefined before reading properties or calling functions; never call hooks conditionally or inside loops; give lists stable keys; ensure children are valid React nodes (not raw objects).";
    case "unknown":
    default:
      return "Hint: change only what is needed to fix the error; preserve all existing features, layout, queries, and styling.";
  }
}

/** Convenience: classify + hint in one call. */
export function diagnose(raw: string, ctx: HealContext = {}): { cls: ErrorClass; hint: string } {
  const cls = classifyError(raw);
  return { cls, hint: healHint(cls, ctx) };
}