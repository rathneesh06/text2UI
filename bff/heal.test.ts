import assert from "node:assert";
import { classifyError, healHint, extractMissingColumn, diagnose, type ErrorClass } from "./heal";
import { assemble } from "./assembler";
import type { Dataset } from "../shared/types";

function ds(tableName: string, cols: string[]): Dataset {
  return {
    tableName,
    profile: {
      source: { filename: `${tableName}.csv`, format: "csv" },
      rowCount: 100,
      columns: cols.map((name) => ({ name, type: "string", nullable: false, uniqueCount: 5, sampleValues: [] })),
      sampleRows: [],
    },
  } as any;
}

// ---- classifyError: each class is recognized -----------------------------
{
  const cases: [string, ErrorClass][] = [
    ['"rows" is read-only', "read_only"],
    ["Assignment to constant variable.", "read_only"],
    ['Binder Error: Referenced column "revenue" not found in FROM clause! Candidate bindings: "amount"', "duckdb_sql"],
    ["Catalog Error: Table with name salez does not exist!", "duckdb_sql"],
    ["Parser Error: syntax error at or near \"GROUP\"", "duckdb_sql"],
    ["Conversion Error: Could not convert string to DATE", "duckdb_sql"],
    ["No function matches the given name and argument types", "duckdb_sql"],
    ["Query timed out after 15000ms", "timeout"],
    ["The operation was aborted", "timeout"],
    ["Query returned 0 rows", "empty_result"],
    ["Result set is empty", "empty_result"],
    ["Transform failed with 1 error: Unexpected token", "ts_compile"],
    ["Could not resolve 'recharts/lib/x'", "ts_compile"],
    ["Cannot find module './data'", "ts_compile"],
    ["TypeError: x.map is not a function", "react_runtime"],
    ["Cannot read properties of undefined (reading 'name')", "react_runtime"],
    ["Maximum update depth exceeded", "react_runtime"],
    ["Rendered more hooks than during the previous render", "react_runtime"],
    ["", "unknown"],
    ["some totally novel gremlin", "unknown"],
  ];
  for (const [msg, expected] of cases) {
    assert.equal(classifyError(msg), expected, `classify: ${JSON.stringify(msg)} -> ${expected} (got ${classifyError(msg)})`);
  }
}

// ---- read_only must win over duckdb-ish co-text ---------------------------
{
  // a read-only message that also mentions a column should still be read_only
  assert.equal(classifyError('Cannot assign to read only property of "amount"'), "read_only");
}

// ---- extractMissingColumn -------------------------------------------------
{
  assert.equal(
    extractMissingColumn('Binder Error: Referenced column "revenue" not found in FROM clause!'),
    "revenue",
  );
  assert.equal(extractMissingColumn("column profit does not exist"), "profit");
  assert.equal(extractMissingColumn("no column mentioned here"), null);
}

// ---- healHint: SQL hint re-grounds on the real schema --------------------
{
  const hint = healHint("duckdb_sql", { schema: [{ table: "sales", columns: ["region", "amount", "closed_at"] }] });
  assert.ok(hint.includes("sales(region, amount, closed_at)"), "SQL hint lists the real columns");
  assert.ok(/date_trunc|strftime/.test(hint), "SQL hint steers date handling");
  assert.ok(hint.toLowerCase().includes("aggregation into sql"), "SQL hint forbids JS aggregation");

  // every class returns a non-empty, actionable hint
  const classes: ErrorClass[] = ["read_only", "duckdb_sql", "timeout", "empty_result", "ts_compile", "react_runtime", "unknown"];
  for (const c of classes) assert.ok(healHint(c).trim().length > 0, `${c} produces a hint`);

  // SQL hint still works with no schema (degrades, no crash, no column list)
  const bare = healHint("duckdb_sql");
  assert.ok(bare.length > 0 && !bare.includes("Use ONLY these real columns"), "SQL hint without schema omits the column list");
}

// ---- diagnose convenience -------------------------------------------------
{
  const d = diagnose('Binder Error: Referenced column "x" not found', { schema: [{ table: "t", columns: ["a", "b"] }] });
  assert.equal(d.cls, "duckdb_sql");
  assert.ok(d.hint.includes("t(a, b)"));
}

// ---- assembler heal turn: class + grounded hint reach the prompt ----------
{
  const datasets = [ds("sales", ["region", "amount", "closed_at"])];
  const code = "export default function App(){return null}";

  // DuckDB SQL heal turn
  const sqlHeal = assemble({
    datasets,
    userPrompt: "",
    currentCode: code,
    lastError: 'Binder Error: Referenced column "revenue" not found in FROM clause!',
  });
  assert.ok(sqlHeal.user_prompt.includes("class: duckdb_sql"), "heal prompt labels the class");
  assert.ok(sqlHeal.user_prompt.includes("sales(region, amount, closed_at)"), "heal prompt re-grounds on real columns");

  // read-only heal turn keeps the specific immutable-assignment guidance
  const roHeal = assemble({ datasets, userPrompt: "", currentCode: code, lastError: '"rows" is read-only' });
  assert.ok(roHeal.user_prompt.includes("class: read_only"));
  assert.ok(roHeal.user_prompt.toLowerCase().includes("immutable"), "read-only hint present");

  // heal turns do NOT inject design/exemplar (discipline preserved)
  assert.ok(!/Design system|exemplar/i.test(sqlHeal.user_prompt), "heal turn omits design/exemplar blocks");
}

console.log("heal.test.ts: all assertions passed");
