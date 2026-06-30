// storage.test.ts — the read-only guard, plus ONE behavioral suite executed
// against every StorageEngine implementation. DuckDB always runs; Postgres runs
// when PG_URL is set (e.g. PG_URL=postgres://t2ui:t2ui@127.0.0.1:5432/text2ui).
// Run: npm run test:storage
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripSqlNoise, assertReadOnly } from "./guard";
import { DuckDBStorage } from "./duckdb";
import type { StorageEngine } from "./types";
import type { DataProfile, ColumnProfile } from "../../shared/types";

// ---------- guard ----------
{
  assert.ok(!stripSqlNoise(`SELECT 'DROP TABLE x' AS s FROM t`).includes("DROP"));
  assert.ok(!stripSqlNoise(`SELECT "update" FROM t -- DELETE everything`).includes("DELETE"));
  assert.ok(!stripSqlNoise(`SELECT /* INSERT */ a FROM t`).includes("INSERT"));

  for (const ok of [
    `SELECT region, SUM(revenue) AS total FROM data GROUP BY region`,
    `WITH top AS (SELECT * FROM data LIMIT 5) SELECT * FROM top`,
    `FROM data SELECT count(*)`,
    `SELECT "update" FROM data`,
    `SELECT 'DROP TABLE x' AS label`,
    `SELECT a FROM t LIMIT 10 OFFSET 5;`,
  ]) assert.doesNotThrow(() => assertReadOnly(ok), ok);

  for (const bad of [
    `INSERT INTO data VALUES (1)`,
    `UPDATE data SET a = 1`,
    `DELETE FROM data`,
    `DROP TABLE data`,
    `CREATE TABLE x AS SELECT 1`,
    `SELECT 1; DROP TABLE data`,
    `WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x`,
    `ATTACH 'other.db'`,
    `SET memory_limit='1GB'`,
    `PRAGMA database_list`,
    `USE main`,
    `COPY data TO 'out.csv'`,
    ``,
  ]) assert.throws(() => assertReadOnly(bad), Error, `should reject: ${bad || "(empty)"}`);
}
console.log("guard: all assertions passed");

// ---------- shared fixtures ----------
const col = (name: string, type: ColumnProfile["type"]): ColumnProfile => ({
  name, type, nullable: false, uniqueCount: 0, sampleValues: [],
});
const ordersProfile: DataProfile = {
  source: { filename: "orders.csv", format: "csv" },
  rowCount: 3,
  columns: [
    col("id", "integer"), col("customer_id", "integer"), col("revenue", "number"),
    col("region", "string"), col("order_date", "date"),
  ],
  sampleRows: [],
};
const customersProfile: DataProfile = {
  source: { filename: "customers.csv", format: "csv" },
  rowCount: 2,
  columns: [col("customer_id", "integer"), col("segment", "string")],
  sampleRows: [],
};
const orders = [
  { id: 1, customer_id: 7, revenue: 100.5, region: "south", order_date: "2024-01-15" },
  { id: 2, customer_id: 8, revenue: 50, region: "north", order_date: "2024-02-03" },
  { id: 3, customer_id: 7, revenue: 25, region: "south", order_date: "2024-01-20" },
];
const customers = [
  { customer_id: 7, segment: "smb" },
  { customer_id: 8, segment: "enterprise" },
];

// ---------- engine behavioral suite (runs identically on every engine) ----------
async function runEngineSuite(name: string, engine: StorageEngine, seriesSql: string) {
  try {
    const meta = await engine.replaceDatasets("alpha", [
      { tableName: "orders", filename: "orders.csv", profile: ordersProfile, rows: orders },
      { tableName: "customers", filename: "customers.csv", profile: customersProfile, rows: customers },
    ]);
    assert.equal(meta.length, 2);

    const agg = await engine.query("alpha",
      `SELECT region, SUM(revenue) AS total FROM orders GROUP BY region ORDER BY region`);
    assert.deepEqual(agg.rows, [
      { region: "north", total: 50 },
      { region: "south", total: 125.5 },
    ]);
    assert.equal(agg.truncated, false);

    const joined = await engine.query("alpha",
      `SELECT c.segment, SUM(o.revenue) AS total FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.segment ORDER BY total DESC`);
    assert.equal(joined.rows[0].segment, "smb");

    // temporal typing: date_trunc must work on the date column (both dialects)
    const monthly = await engine.query("alpha",
      `SELECT date_trunc('month', order_date) AS m, SUM(revenue) AS total FROM orders GROUP BY 1 ORDER BY 1`);
    assert.equal(monthly.rows.length, 2);
    assert.equal(monthly.rows[0].total, 125.5);

    // BIGINT results come back as JS numbers, not strings
    const counted = await engine.query("alpha", `SELECT count(*) AS n FROM orders`);
    assert.strictEqual(counted.rows[0].n, 3);

    const capped = await engine.query("alpha", seriesSql, { rowCap: 10 });
    assert.equal(capped.rows.length, 10);
    assert.equal(capped.truncated, true);

    await assert.rejects(engine.query("alpha", `DROP TABLE orders`), /non-read-only|read statements/);

    await engine.replaceDatasets("beta", [
      { tableName: "data", filename: "x.csv", profile: customersProfile, rows: [{ customer_id: 1, segment: "x" }] },
    ]);
    await assert.rejects(engine.query("beta", `SELECT * FROM orders`));

    await engine.replaceDatasets("alpha", [
      { tableName: "orders", filename: "orders.csv", profile: ordersProfile, rows: orders },
    ]);
    await assert.rejects(engine.query("alpha", `SELECT * FROM customers`));
    const list = await engine.listDatasets("alpha");
    assert.deepEqual(list.map((d) => d.tableName), ["orders"]);

    // ---- M3: project persistence ----
    await engine.upsertProject("alpha", "Revenue Ops");
    await engine.saveVersion("alpha", { num: 1, label: "build a dashboard", app: { files: [{ path: "App.tsx", content: "export default 1" }] } });
    await engine.saveVersion("alpha", { num: 2, label: "make it a pie", app: { files: [{ path: "App.tsx", content: "export default 2" }] } });
    const projects = await engine.listProjects();
    const alpha = projects.find((x) => x.projectId === "alpha");
    assert.ok(alpha, "alpha listed");
    assert.equal(alpha!.name, "Revenue Ops");
    assert.equal(alpha!.versionCount, 2);
    assert.deepEqual(alpha!.tableNames, ["orders"]);
    assert.ok(alpha!.editedAt >= alpha!.createdAt);

    const loaded = await engine.getProject("alpha");
    assert.ok(loaded, "getProject returns the project");
    assert.equal(loaded!.versions.length, 2);
    assert.equal((loaded!.versions[1].app as any).files[0].content, "export default 2", "app JSON roundtrips");

    await engine.upsertProject("alpha", "Revenue Ops Renamed");
    assert.equal((await engine.getProject("alpha"))!.project.name, "Revenue Ops Renamed");
    assert.equal(await engine.getProject("nosuch"), null);

    await engine.deleteProject("beta");
    await assert.rejects(engine.query("beta", `SELECT * FROM data`), Error, "deleted project schema is gone");
    assert.equal((await engine.listProjects()).find((x) => x.projectId === "beta"), undefined);

    await assert.rejects(engine.replaceDatasets("bad-id!", []), /invalid projectId/);
    await assert.rejects(
      engine.replaceDatasets("alpha", [{ tableName: "Robert'); DROP", filename: "x", profile: customersProfile, rows: [] }]),
      /invalid table name/,
    );

    console.log(`${name} engine: all assertions passed`);
  } finally {
    await engine.close();
  }
}

// ---------- DuckDB (always) ----------
{
  const dir = mkdtempSync(join(tmpdir(), "t2ui-storage-"));
  try {
    await runEngineSuite("duckdb", new DuckDBStorage(join(dir, "test.duckdb")), `SELECT * FROM range(100)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- Postgres (when PG_URL is set) ----------
if (process.env.PG_URL) {
  // clean slate FIRST — the engine's constructor creates the registry table,
  // so cleanup must complete before the engine exists (was a race).
  const pgmod = (await import("pg")).default;
  const admin = new pgmod.Client({ connectionString: process.env.PG_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS p_alpha CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS p_beta CASCADE`);
  await admin.query(`DROP TABLE IF EXISTS public._datasets`);
  await admin.end();
  const { PostgresStorage } = await import("./postgres");
  await runEngineSuite("postgres", new PostgresStorage(process.env.PG_URL), `SELECT * FROM generate_series(1, 100)`);
} else {
  console.log("postgres engine: SKIPPED (set PG_URL to run it)");
}