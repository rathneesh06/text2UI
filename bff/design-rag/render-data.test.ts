// bff/design-rag/render-data.test.ts — offline. Loads the shipped JS module.
import assert from "node:assert";
import { DATA_MODULE_JS } from "./render-data";

// Import the EXACT source the browser runs, as a data: URL ES module.
const mod: any = await import("data:text/javascript;base64," + Buffer.from(DATA_MODULE_JS).toString("base64"));

// ---- __columnsOf: names + kinds -------------------------------------------
{
  const c = mod.__columnsOf("SELECT month, SUM(revenue) AS revenue FROM data GROUP BY month");
  assert.deepEqual(c.map((x: any) => x.name), ["month", "revenue"]);
  assert.equal(c[0].kind, "date");
  assert.equal(c[1].kind, "num");
}
{
  const c = mod.__columnsOf("SELECT DISTINCT country FROM data ORDER BY country");
  assert.equal(c[0].name, "country");
  assert.equal(c[0].distinct, true);
}
{
  const c = mod.__columnsOf("SELECT SUM(budget) AS total FROM data");
  assert.equal(c[0].name, "total");
  assert.equal(c[0].kind, "num");
}
{
  const c = mod.__columnsOf("SELECT * FROM data");
  assert.ok(c.length >= 4, "star expands to several generic columns");
}

// ---- query: shapes populate charts ----------------------------------------
{
  const trend = await mod.query("SELECT month, SUM(revenue) AS revenue FROM data GROUP BY month");
  assert.equal(trend.length, 8, "series");
  assert.ok("month" in trend[0] && "revenue" in trend[0]);
  assert.equal(typeof trend[0].revenue, "number");
  assert.equal(typeof trend[0].month, "string");
}
{
  const kpi = await mod.query("SELECT SUM(budget) AS total FROM data");
  assert.equal(kpi.length, 1, "single-row aggregate (KPI)");
  assert.equal(typeof kpi[0].total, "number");
}
{
  const distinct = await mod.query("SELECT DISTINCT department FROM data");
  assert.equal(distinct.length, 6);
  assert.equal(typeof distinct[0].department, "string");
}

// ---- deterministic (stable screenshots) + garbage-safe ---------------------
{
  const a = await mod.query("SELECT category, COUNT(*) AS n FROM data GROUP BY category");
  const b = await mod.query("SELECT category, COUNT(*) AS n FROM data GROUP BY category");
  assert.deepEqual(a, b, "same SQL -> same rows");
  assert.deepEqual(await mod.query("not sql at all"), [], "no SELECT -> []");
}

console.log("ok design-rag/render-data");
