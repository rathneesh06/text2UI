// bff/sources/db-conn.test.ts — run with: npm run test:db-conn
// Parse-layer tests only: attach/introspect need a live database + the DuckDB
// extension download, which the manual QA script covers.
import assert from "node:assert";
import { detectDialect, parseDbUrl, describeDbConn, refFor } from "./db-conn";

// ---- dialect detection ---------------------------------------------------------
assert.equal(detectDialect("mysql://u:p@h/db"), "mysql");
assert.equal(detectDialect("mysql+pymysql://u:p@h/db"), "mysql");
assert.equal(detectDialect("postgres://u:p@h/db"), "postgres");
assert.equal(detectDialect("postgresql://u:p@h/db"), "postgres");
assert.equal(detectDialect("postgresql+psycopg2://u:p@h/db"), "postgres");
assert.equal(detectDialect("host=h database=db"), "mysql", "key=value defaults to mysql (pre-Postgres behavior)");
assert.equal(detectDialect("host=h database=db dialect=postgres"), "postgres");
assert.equal(detectDialect("host=h database=db driver=postgresql"), "postgres");

// ---- postgres defaults (port 5432, user postgres) --------------------------------
{
  const c = parseDbUrl("postgres://h.example.com/shop");
  assert.equal(c.dialect, "postgres");
  assert.equal(c.port, 5432, "default pg port");
  assert.equal(c.user, "postgres", "default pg user");
  assert.equal(c.database, "shop");
}

// ---- explicit port/user are honored ------------------------------------------------
{
  const c = parseDbUrl("postgresql://alice:secret@db.internal:6543/analytics");
  assert.equal(c.port, 6543);
  assert.equal(c.user, "alice");
  assert.equal(c.password, "secret");
}

// ---- hardened password survival (raw @ # $ ! : in the password) ---------------------
{
  const c = parseDbUrl("postgres://svc:p@ss:w0rd#$!@10.0.0.5:5432/prod");
  assert.equal(c.user, "svc");
  assert.equal(c.password, "p@ss:w0rd#$!", "raw special chars survive");
  assert.equal(c.host, "10.0.0.5");
  assert.equal(c.port, 5432);
  assert.equal(c.database, "prod");
}

// ---- ssl flag --------------------------------------------------------------------
{
  const c = parseDbUrl("postgres://u:p@h/db?sslmode=require");
  assert.equal(c.ssl, true);
}

// ---- key=value postgres ------------------------------------------------------------
{
  const c = parseDbUrl("host=pg.local database=erp dialect=postgres password=x");
  assert.equal(c.dialect, "postgres");
  assert.equal(c.port, 5432, "kv default pg port");
  assert.equal(c.user, "postgres", "kv default pg user");
}
{
  const c = parseDbUrl("host=pg.local database=erp dialect=postgres port=15432 user=bob");
  assert.equal(c.port, 15432, "kv explicit port honored");
  assert.equal(c.user, "bob", "kv explicit user honored");
}

// ---- mysql behavior unchanged --------------------------------------------------------
{
  const c = parseDbUrl("mysql://root:pw@db:3307/shop");
  assert.equal(c.dialect, "mysql");
  assert.equal(c.port, 3307);
  assert.equal(c.user, "root");
}
{
  const c = parseDbUrl("mysql://h/db");
  assert.equal(c.port, 3306, "mysql default port untouched");
  assert.equal(c.user, "root", "mysql default user untouched");
}

// ---- describe never leaks the password ------------------------------------------------
{
  const d = describeDbConn(parseDbUrl("postgres://alice:hunter2@h:5432/db"));
  assert.ok(d.includes("postgres://alice:***@h:5432/db"), d);
  assert.ok(!d.includes("hunter2"), "password masked");
}

// ---- refs -------------------------------------------------------------------------------
assert.equal(refFor("public", "orders"), 'src."public"."orders"');
assert.equal(refFor("we\"ird", "ta\"ble"), 'src."we""ird"."ta""ble"', "identifier quoting escapes quotes");

console.log("db-conn.test.ts: all assertions passed ✅");

// ---- snapshotFromHandle against a REAL attached src catalog (no extension needed):
// a plain DuckDB file attached as `src` exercises exactly the same catalog +
// pull + profile path production uses through the MySQL/Postgres attach.
{
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const { snapshotFromHandle } = await import("./db-conn");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = mkdtempSync(join(tmpdir(), "t2sql-"));
  const srcPath = join(dir, "source.duckdb");

  // Build a fake source with two schemas + a name that needs sanitizing.
  const s = await DuckDBInstance.create(srcPath);
  const sc = await s.connect();
  await sc.run(`CREATE TABLE orders AS SELECT * FROM (VALUES ('EMEA', 120, DATE '2026-01-05'), ('APAC', 300, DATE '2026-02-11'), ('NA', 210, NULL)) t(region, revenue, sold_on)`);
  await sc.run(`CREATE SCHEMA sales`);
  await sc.run(`CREATE TABLE sales."Order-Lines" AS SELECT * FROM (VALUES (1, 'widget'), (2, 'gadget')) t(id, sku)`);
  sc.disconnectSync();
  // Release the instance's handle on source.duckdb before re-opening it via ATTACH.
  // Windows locks the file while the instance is live (POSIX tolerates the overlap).
  s.closeSync();

  // Attach it read-only as `src` in a fresh snapshot instance — the production shape.
  const snapPath = join(dir, "wb_test.duckdb");
  const inst = await DuckDBInstance.create(snapPath);
  const c = await inst.connect();
  await c.run(`ATTACH '${srcPath}' AS src (READ_ONLY)`);
  const readAll = async (sql: string, _label: string) => {
    const reader = await c.runAndReadUntil(sql, 1_000_000);
    return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((row) => {
      for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
      return row;
    });
  };
  const run = async (sql: string, _ms: number, _label: string) => { await c.run(sql); };

  const r = await snapshotFromHandle({ readAll, run }, "postgres", {
    tables: ["orders", "sales.Order-Lines", "does_not_exist"],
    dbPath: snapPath,
    rowCap: 2, // force the cap warning on orders (3 rows)
  });

  assert.equal(r.datasets.length, 2, "two tables snapshotted");
  assert.deepEqual(r.skipped, ["does_not_exist: table not found"], "missing table skipped, not fatal");
  assert.ok(r.warnings.some((w) => w.includes("row cap")), "row cap warning surfaces");

  const orders = r.datasets.find((d) => d.tableName === "orders")!;
  assert.equal(orders.profile.rowCount, 2, "orders capped at rowCap");
  assert.deepEqual(orders.profile.columns.map((c) => c.name), ["region", "revenue", "sold_on"]);
  assert.equal(orders.profile.columns[1].type, "integer", "DESCRIBE types mapped through duckTypeToColumnType");
  assert.ok(orders.profile.source.filename.startsWith("postgres:main.orders"), orders.profile.source.filename);

  const lines = r.datasets.find((d) => d.tableName === "order_lines")!;
  assert.ok(lines, "schema-qualified request resolved; name sanitized to order_lines");
  assert.equal(lines.profile.rowCount, 2);

  // The snapshot file itself must be queryable — the wbQuery contract.
  const rows = await readAll(`SELECT count(*) AS n FROM main.order_lines`, "verify");
  assert.equal(Number((rows[0] as any).n), 2, "snapshotted table lives in main");
  c.disconnectSync();
  console.log("snapshotFromHandle: all assertions passed ✅");
}

// ---- percent-encoded credentials (the URL standard) --------------------------------
{
  const { parseDbUrl, safeDecode } = await import("./db-conn");
  // encoded @ in the password — the exact real-world shape that failed
  const c = parseDbUrl("postgresql://svcuser:Secret%40123@10.0.0.7:5432/uatdb");
  assert.equal(c.password, "Secret@123", "%40 decodes to @");
  assert.equal(c.user, "svcuser");
  assert.equal(c.host, "10.0.0.7");
  assert.equal(c.database, "uatdb");

  // other common encodings
  assert.equal(parseDbUrl("postgres://u:p%23w%24d%3A1@h/db").password, "p#w$d:1", "%23 %24 %3A decode");
  assert.equal(parseDbUrl("postgres://my%40user:x@h/db").user, "my@user", "encoded user decodes");

  // raw special characters STILL survive (the original hardening) — invalid
  // percent sequences fall back to the literal text
  assert.equal(parseDbUrl("postgres://u:p@ss%word!@h/db").password, "p@ss%word!", "raw % without hex stays raw");
  assert.equal(parseDbUrl("mysql://root:p%40ss@h/db").password, "p%40ss", "MYSQL is byte-exact raw — decoding is postgres-only");

  // key=value form is always raw (the documented escape hatch for literal %XX)
  assert.equal(parseDbUrl("host=h database=db password=lit%40eral dialect=postgres").password, "lit%40eral", "kv form stays raw");

  assert.equal(safeDecode("no-percent"), "no-percent");
}
console.log("percent-encoding: all assertions passed ✅");

// ---- percent-encoding: the exact failure shape the flowops string exposed --------
{
  const c = parseDbUrl("postgresql://appuser:S3cret%40123@10.0.0.9:5432/appdb");
  assert.equal(c.password, "S3cret@123", "postgres URI %40 decodes to @ (libpq spec)");
  assert.equal(c.user, "appuser");
  assert.equal(c.host, "10.0.0.9");
  assert.equal(c.port, 5432);
  assert.equal(c.database, "appdb");
}
{
  const c = parseDbUrl("postgres://u:p%20w%23x@h/db");
  assert.equal(c.password, "p w#x", "space + hash escapes decode");
}
{
  const c = parseDbUrl("postgres://u:raw@pass%zz!@h/db");
  assert.equal(c.password, "raw@pass%zz!", "malformed escape -> raw passthrough (never throws)");
}
{
  const c = parseDbUrl("mysql://u:p%40ss@h/db");
  assert.equal(c.password, "p%40ss", "MYSQL raw-passthrough is byte-exact — decoding is postgres-only");
}

// ---- connFromParts: the structured (dedicated PG page) path -------------------------
{
  const { connFromParts } = await import("./db-conn");
  const c = connFromParts({ host: " 10.0.0.9 ", database: "appdb", password: "Raw@%40#Pass! " });
  assert.equal(c.dialect, "postgres", "parts default to postgres");
  assert.equal(c.host, "10.0.0.9", "host trimmed");
  assert.equal(c.port, 5432);
  assert.equal(c.user, "postgres");
  assert.equal(c.password, "Raw@%40#Pass! ", "password taken literally — no trim, no decode");
  assert.throws(() => connFromParts({ host: "", database: "x" }), /host is required/);
  assert.throws(() => connFromParts({ host: "h", database: "" }), /database is required/);
  assert.throws(() => connFromParts({ host: "h", database: "d", port: "abc" }), /port must be/);
  const my = connFromParts({ dialect: "mysql", host: "h", database: "d" });
  assert.equal(my.port, 3306, "mysql parts default port");
  assert.equal(my.user, "root");
}
console.log("encoding + parts: all assertions passed ✅");

// ---- v6: durable staging survives a process restart (two-process test) -------------
{
  const { execSync } = await import("node:child_process");
  const { writeFileSync: writeChild, rmSync } = await import("node:fs");
  const { join: joinChild } = await import("node:path");
  const conv = "conv_persist_" + Date.now();
  // process 1: stage two tables (writes stages.json through). Run a temp script file
  // via tsx instead of `tsx -e '<script>'`: POSIX single-quote wrapping doesn't
  // survive Windows' cmd.exe, which corrupts the inline program (Unterminated string).
  const childPath = joinChild(process.cwd(), `.t2sql-persist-child-${conv}.mts`);
  writeChild(childPath, [
    `import { addStaged, stagingDbPath } from "./bff/sources/workbench-store";`,
    `import { writeFileSync } from "node:fs";`,
    `const ds = (n) => ({ tableName: n, profile: { source: { filename: "t:" + n, format: "json" }, rowCount: 1, columns: [], sampleRows: [] } });`,
    `writeFileSync(stagingDbPath("${conv}"), "x");  // stand-in stage file so recovery keeps it`,
    `addStaged("${conv}", "public", stagingDbPath("${conv}"), [ds("a"), ds("b")]);`,
  ].join("\n"));
  try {
    execSync(`npx tsx "${childPath.split("\\").join("/")}"`, { stdio: "pipe" });
  } finally {
    rmSync(childPath, { force: true });
  }
  // process 2 (a fresh module registry = a restarted BFF): the stage is recovered
  const { getStaged: getStaged2, finalizeStaged: fin2 } = await import("./workbench-store");
  const recovered = getStaged2(conv);
  assert.ok(recovered, "stage recovered after restart");
  assert.equal(recovered!.tables.length, 2, "both staged tables recovered");
  // idempotent publish: second finalize returns the same source instead of throwing
  const src1 = fin2(conv, "persist test");
  const src2 = fin2(conv);
  assert.equal(src2.projectId, src1.projectId, "duplicate publish returns the existing source");
}
console.log("durable staging + idempotent publish: all assertions passed ✅");

// ---- v6: planner table-relevance ranking ---------------------------------------------
{
  const { rankTables } = await import("../text2sql/planner");
  const mk = (n: string, cols: string[] = []) => ({
    name: n, approxRows: 10, ref: `src."public"."${n}"`,
    ds: { tableName: n, profile: { source: { filename: "x", format: "json" }, rowCount: 10, columns: cols.map((c) => ({ name: c })), sampleRows: [] } } as any,
  });
  const tabs = Array.from({ length: 20 }, (_, i) => mk(`table_${i}`, ["id"]));
  tabs[15] = mk("orders", ["region", "revenue"]);
  tabs[18] = mk("customers", ["name"]);
  const all = tabs.map(({ ds, ...t }) => t);
  const datasets = tabs.map((t) => t.ds);
  const r = rankTables("which region drove revenue in orders?", [], all, datasets, 5);
  assert.equal(r.detailed.length, 5, "top-N respected");
  assert.equal(r.detailed[0].name, "orders", "mentioned + column-matched table ranks first");
  assert.ok(r.rest.length === 15 && r.rest.some((t) => t.name === "table_19"), "rest carries the tail (ties keep catalog order, so early tables fill the top-N)");
  const small = rankTables("hi", [], all.slice(0, 4), datasets.slice(0, 4), 5);
  assert.equal(small.detailed.length, 4, "small catalogs are sent whole");
  assert.equal(small.rest.length, 0);
}
console.log("relevance ranking: all assertions passed ✅");
