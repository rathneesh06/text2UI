import assert from "node:assert";
import {
  toSchemaSql, toSeedSql, toSqlDump, inferColumns, sqlType, quoteIdent, formatValue,
  type DumpTable,
} from "./dbexport";

const tables: DumpTable[] = [{
  tableName: "sales",
  columns: [
    { name: "region", type: "string" },
    { name: "amount", type: "number" },
    { name: "active", type: "boolean" },
    { name: "closed_at", type: "date" },
    { name: "note", type: "string" },
  ],
  rows: [
    { region: "NA", amount: 120.5, active: true, closed_at: "2024-01-05", note: "O'Brien's deal" },
    { region: "EU", amount: 90, active: false, closed_at: "2024-02-11", note: null },
  ],
}];

// ---- identifier quoting ----------------------------------------------------
{
  assert.equal(quoteIdent("region"), '"region"');
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
}

// ---- type mapping per dialect ----------------------------------------------
{
  assert.equal(sqlType("number", "duckdb"), "DOUBLE");
  assert.equal(sqlType("number", "postgres"), "DOUBLE PRECISION");
  assert.equal(sqlType("number", "sqlite"), "REAL");
  assert.equal(sqlType("boolean", "sqlite"), "INTEGER");
  assert.equal(sqlType("boolean", "duckdb"), "BOOLEAN");
  assert.equal(sqlType("date", "duckdb"), "TIMESTAMP");
  assert.equal(sqlType("date", "sqlite"), "TEXT");
  assert.equal(sqlType("string", "postgres"), "TEXT");
}

// ---- value formatting + escaping -------------------------------------------
{
  assert.equal(formatValue(null, "string", "duckdb"), "NULL");
  assert.equal(formatValue(120.5, "number", "duckdb"), "120.5");
  assert.equal(formatValue(NaN, "number", "duckdb"), "NULL");
  assert.equal(formatValue(true, "boolean", "duckdb"), "TRUE");
  assert.equal(formatValue(true, "boolean", "sqlite"), "1");
  assert.equal(formatValue(false, "boolean", "sqlite"), "0");
  assert.equal(formatValue("O'Brien's", "string", "duckdb"), "'O''Brien''s'");
  assert.equal(formatValue({ a: 1 }, "string", "duckdb"), `'{"a":1}'`);
}

// ---- schema sql ------------------------------------------------------------
{
  const dd = toSchemaSql(tables, "duckdb");
  assert.ok(dd.includes('CREATE TABLE "sales"'), "creates the table");
  assert.ok(dd.includes('"amount" DOUBLE'), "number -> DOUBLE (duckdb)");
  assert.ok(dd.includes('"active" BOOLEAN'), "boolean -> BOOLEAN (duckdb)");
  assert.ok(dd.includes('"closed_at" TIMESTAMP'), "date -> TIMESTAMP (duckdb)");
  assert.ok(dd.includes('"region" TEXT'), "string -> TEXT");
  assert.ok(dd.includes('DROP TABLE IF EXISTS "sales"'), "idempotent drop");

  const sq = toSchemaSql(tables, "sqlite");
  assert.ok(sq.includes('"amount" REAL') && sq.includes('"active" INTEGER') && sq.includes('"closed_at" TEXT'), "sqlite types");

  const pg = toSchemaSql(tables, "postgres");
  assert.ok(pg.includes('"amount" DOUBLE PRECISION'), "postgres number type");
}

// ---- seed sql --------------------------------------------------------------
{
  const dd = toSeedSql(tables, "duckdb");
  assert.ok(dd.includes('INSERT INTO "sales"'), "inserts into the table");
  assert.ok(dd.includes("'O''Brien''s deal'"), "escapes single quotes");
  assert.ok(dd.includes("TRUE") && dd.includes("FALSE"), "booleans as TRUE/FALSE");
  assert.ok(dd.includes("NULL"), "null preserved");
  assert.ok(dd.includes("120.5"), "number literal");

  const sq = toSeedSql(tables, "sqlite");
  assert.ok(/\b1\b/.test(sq) && /\b0\b/.test(sq), "sqlite booleans as 1/0");
}

// ---- inference (rows only) -------------------------------------------------
{
  const inferred = inferColumns(tables[0].rows);
  const byName = Object.fromEntries(inferred.map((c) => [c.name, c.type]));
  assert.equal(byName.amount, "number");
  assert.equal(byName.active, "boolean");
  assert.equal(byName.closed_at, "date");
  assert.equal(byName.region, "string");
}

// ---- full dump -------------------------------------------------------------
{
  const dump = toSqlDump(tables, "duckdb");
  assert.ok(dump.indexOf("CREATE TABLE") < dump.indexOf("INSERT INTO"), "schema precedes seed");
  assert.ok(dump.includes("-- text2UI data export (duckdb)"), "has a header");
}

console.log("dbexport.test.ts: all assertions passed");
