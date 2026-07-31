// bff/text2sql/combined-schema.test.ts — run with: npm run test:combined-schema
//
// Proves the layer end to end on a REAL DuckDB file: dependencies -> join graph
// -> CREATE VIEW -> the view actually returns rows. No network, so it belongs in
// `npm test`.
//
// Why executing the DDL matters: viewDdl() builds SQL by string assembly, and
// SQL that typechecks is not SQL that runs. A quoting or alias bug would sail
// past tsc and only show up as "combined view skipped" in a commit log nobody
// reads.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildJoinGraph, viewDdl, describeCombinedSchema, type StagedTable } from "./combined-schema";
import { depId, type Dependency } from "../../shared/dependencies";

const DIR = mkdtempSync(join(tmpdir(), "t2ui-combined-"));
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

const A = "mem_a", B = "mem_b";

// Two databases' worth of tables, staged side by side as the snapshot leaves them.
const staged: StagedTable[] = [
  { member: A, sourceTable: "orders", localName: "orders" },
  { member: B, sourceTable: "customers", localName: "customers" },
  { member: B, sourceTable: "regions", localName: "regions" },
  { member: A, sourceTable: "audit_log", localName: "audit_log" }, // deliberately unrelated
];

const mkJoin = (from: any, to: any, statement: string, confidence: Dependency["confidence"] = "validated"): Dependency => {
  const d: any = { kind: "join", from, to, cardinality: "N:1", confidence, statement };
  d.id = depId(d);
  return d;
};

const deps: Dependency[] = [
  mkJoin({ member: A, table: "orders", column: "customer_id" }, { member: B, table: "customers", column: "id" },
    "orders.customer_id points at customers.id"),
  mkJoin({ member: B, table: "customers", column: "region_id" }, { member: B, table: "regions", column: "id" },
    "customers.region_id points at regions.id"),
  // Inferred joins must NOT be built into views — nobody checked them.
  mkJoin({ member: A, table: "audit_log", column: "who" }, { member: B, table: "customers", column: "id" },
    "audit_log.who might be a customer", "inferred"),
  // A semantic statement has no SQL form but must reach the directive.
  (() => { const d: any = { kind: "semantic", scope: [{ member: A, table: "orders" }], confidence: "validated", statement: "all amounts are in GBP" }; d.id = depId(d); return d; })(),
];

// ---- the graph ---------------------------------------------------------------------
const graph = buildJoinGraph(deps, staged);
{
  assert.equal(graph.components.length, 1, "orders+customers+regions form ONE joinable component");
  const c = graph.components[0];
  assert.deepEqual(c.members.map((m) => m.localName).sort(), ["customers", "orders", "regions"]);
  assert.equal(c.edges.length, 2, "spanning tree: two edges for three tables");
  assert.ok(
    graph.isolated.some((t) => t.localName === "audit_log"),
    "an `inferred` join is not buildable, so audit_log stays isolated rather than silently shaping data",
  );
}

// ---- the DDL actually runs, and the view returns rows -------------------------------
{
  const dbPath = join(DIR, "stage.duckdb");
  const inst = await DuckDBInstance.create(dbPath);
  const c = await inst.connect();
  try {
    await c.run(`CREATE TABLE orders     AS SELECT * FROM (VALUES (1, 10, 100.0), (2, 10, 50.0), (3, 20, 7.5)) t(id, customer_id, amount)`);
    await c.run(`CREATE TABLE customers  AS SELECT * FROM (VALUES (10, 'Acme', 1), (20, 'Globex', 2)) t(id, name, region_id)`);
    await c.run(`CREATE TABLE regions    AS SELECT * FROM (VALUES (1, 'EMEA'), (2, 'APAC')) t(id, label)`);
    await c.run(`CREATE TABLE audit_log  AS SELECT * FROM (VALUES (1, 10)) t(id, who)`);

    const columnsOf = (local: string): string[] => ({
      orders: ["id", "customer_id", "amount"],
      customers: ["id", "name", "region_id"],
      regions: ["id", "label"],
      audit_log: ["id", "who"],
    } as Record<string, string[]>)[local] ?? [];

    const ddl = viewDdl(graph, columnsOf);
    assert.ok(ddl.length >= 1, "at least one view is emitted");

    for (const sql of ddl) {
      await c.run(sql); // the assertion IS that this does not throw
    }

    // The anchor's row count must be preserved (LEFT JOINs off `orders`).
    const view = graph.components[0].viewName;
    const r = await c.runAndReadUntil(`SELECT count(*) AS n FROM ${view}`, 10);
    const n = Number((r.getRowObjectsJS()[0] as any).n);
    assert.equal(n, 3, `the combined view returns rows (anchor row count preserved) — got ${n}`);

    // And the join actually resolved, rather than producing all-NULL columns.
    const r2 = await c.runAndReadUntil(`SELECT count(*) AS n FROM ${view} WHERE "customers_name" IS NOT NULL`, 10);
    const matched = Number((r2.getRowObjectsJS()[0] as any).n);
    assert.ok(matched > 0, `the join resolved — ${matched} row(s) carry a customer name`);
  } finally {
    c.disconnectSync();
    inst.closeSync();
  }
}

// ---- the directive carries what SQL cannot ------------------------------------------
{
  const text = describeCombinedSchema(graph, deps);
  assert.match(text, /CROSS-DATABASE SCHEMA/, "has the header the planner keys on");
  assert.match(text, /all amounts are in GBP/, "semantic dependencies reach the planner — they have no SQL form");
  assert.match(text, /orders/, "names the tables");
}

console.log("combined-schema.test.ts: all assertions passed ✅");
