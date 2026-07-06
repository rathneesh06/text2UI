// bff/text2sql/guard.test.ts — run with: npm run test:t2sql-guard
import assert from "node:assert";
import { guardSelect, unfence } from "./guard";

// ---- fence stripping ---------------------------------------------------------
assert.equal(unfence("```sql\nSELECT 1\n```"), "SELECT 1", "strips sql fence");
assert.equal(unfence("```\nSELECT 1\n```"), "SELECT 1", "strips bare fence");
assert.equal(unfence("  SELECT 1  "), "SELECT 1", "trims plain SQL");

// ---- happy path: plain select gets capped by wrapping -------------------------
{
  const r = guardSelect("SELECT region, sum(revenue) FROM src.orders GROUP BY 1 ORDER BY 2 DESC");
  assert.ok(r.ok, "aggregate select passes");
  if (r.ok) {
    assert.ok(r.capped, "cap applied");
    assert.ok(/LIMIT 500$/.test(r.sql), "wrapped with default cap");
    assert.ok(r.sql.includes("ORDER BY 2 DESC"), "ORDER BY survives wrapping");
  }
}

// ---- existing small LIMIT is trusted ------------------------------------------
{
  const r = guardSelect("SELECT * FROM src.orders LIMIT 20");
  assert.ok(r.ok && !r.capped, "small explicit LIMIT passes through unwrapped");
}

// ---- oversized LIMIT gets re-capped --------------------------------------------
{
  const r = guardSelect("SELECT * FROM src.orders LIMIT 999999", 500);
  assert.ok(r.ok && r.capped, "oversized LIMIT re-capped");
  if (r.ok) assert.ok(/LIMIT 500$/.test(r.sql));
}

// ---- CTEs pass ------------------------------------------------------------------
{
  const r = guardSelect("WITH t AS (SELECT * FROM src.orders) SELECT count(*) FROM t");
  assert.ok(r.ok, "WITH passes the read-only gate");
}

// ---- writes / DDL / multi-statement are rejected --------------------------------
for (const bad of [
  "DROP TABLE src.orders",
  "DELETE FROM src.orders",
  "INSERT INTO x VALUES (1)",
  "UPDATE src.orders SET a=1",
  "SELECT 1; SELECT 2",
  "ATTACH 'evil.db' AS x",
  "COPY (SELECT 1) TO '/tmp/x.csv'",
  "CREATE TABLE x AS SELECT 1",
  "",
]) {
  const r = guardSelect(bad);
  assert.equal(r.ok, false, `rejected: ${bad || "(empty)"}`);
}

// ---- trailing semicolon + fence combined -----------------------------------------
{
  const r = guardSelect("```sql\nSELECT name FROM src.customers;\n```");
  assert.ok(r.ok, "fence + semicolon normalized");
}

console.log("guard.test.ts: all assertions passed ✅");
