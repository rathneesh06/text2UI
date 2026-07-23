// bff/sources/enrich.test.ts — profile enrichment: topValues + min/max.
//
// THE 0.0% ROOT CAUSE: no producer in the codebase ever populated topValues or
// min/max, so the A1 select filters, the A2.5 observed-value guard, and the
// avg+percent range gate were all silently inert on real sources — the model
// guessed category literals ("met") that matched zero rows, and nothing could
// correct it. These tests pin the three layers of the fix:
//   1. shared/profile-enrich — sample/full-row derivation (every producer's floor)
//   2. bff/sources/exact-stats — full-table SQL stats where we own a handle
//      (exact uniqueCounts make the guard's "provably empty" claim truthful)
//   3. the enhance digest — observed values SHOWN to the model so it emits the
//      correct literal the first time
import assert from "node:assert/strict";
import { enrichColumn, enrichColumns, TOP_VALUES_LIMIT } from "../../shared/profile-enrich";
import { exactColumnStats } from "./exact-stats";
import type { ColumnProfile, Dataset } from "../../shared/types";

const col = (name: string, type: ColumnProfile["type"], uniqueCount = 1): ColumnProfile =>
  ({ name, type, nullable: false, uniqueCount, sampleValues: [] });

// ---- 1. sample-based enrichment ---------------------------------------------
{
  // topValues: ordered by count desc, ties alphabetical, capped, null-free.
  const values = ["met", "met", "met", "breached", "breached", "at_risk", null, undefined, "met"];
  const c = enrichColumn(col("sla_status", "string"), values);
  assert.deepEqual(c.topValues, [
    { value: "met", count: 4 },
    { value: "breached", count: 2 },
    { value: "at_risk", count: 1 },
  ], "topValues ordered by count, nulls excluded");

  // High-cardinality string columns (id-like / free text) get NO topValues.
  const many = Array.from({ length: 200 }, (_, i) => `id_${i}`);
  const idc = enrichColumn(col("ticket_id", "string", 200), many);
  assert.equal(idc.topValues, undefined, "id-like columns carry no topValues");

  // The cap holds even when cardinality sits just under the tracking limit.
  const fifty = Array.from({ length: 50 }, (_, i) => `v${String(i).padStart(2, "0")}`);
  const capped = enrichColumn(col("c", "string", 50), [...fifty, ...fifty, "v01"]);
  assert.equal(capped.topValues!.length, TOP_VALUES_LIMIT, "topValues capped at the limit");
  assert.equal(capped.topValues![0].value, "v01", "highest count first");

  // numeric min/max, ignoring nulls and non-finite garbage.
  const n = enrichColumn(col("age_hours", "number"), [5, -3, null, "12", Infinity, 7]);
  assert.equal(n.min, -3); assert.equal(n.max, 12);

  // date min/max as ISO-comparable strings; Date objects normalized.
  const d = enrichColumn(col("created_at", "date"), ["2026-01-05", new Date("2026-03-01T00:00:00Z"), "2025-11-30"]);
  assert.equal(d.min, "2025-11-30");
  assert.equal(String(d.max).slice(0, 10), "2026-03-01");

  // enrichColumns maps rows → per-column values.
  const rows = [{ s: "a", n: 1 }, { s: "b", n: 9 }, { s: "a", n: 4 }];
  const [sc, nc] = enrichColumns([col("s", "string"), col("n", "number")], rows);
  assert.equal(sc.topValues![0].value, "a");
  assert.equal(nc.min, 1); assert.equal(nc.max, 9);
  console.log("enrich: sample-based topValues + min/max ✅");
}

// ---- 2. exact SQL stats against a live DuckDB -------------------------------
await (async () => {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const readAll = async (sql: string): Promise<Record<string, unknown>[]> => {
    const reader = await conn.runAndReadAll(sql);
    return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((row) => {
      for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
      return row;
    });
  };
  // 1000 rows: 600 met / 300 breached / 100 at_risk — but the SAMPLE the
  // profiler saw (5 rows, the old colo reality) contained only "met".
  await conn.run(`CREATE TABLE sla AS
    SELECT CASE WHEN i <= 600 THEN 'met' WHEN i <= 900 THEN 'breached' ELSE 'at_risk' END AS sla_status,
           (i % 200) - 50 AS age_hours,
           DATE '2026-01-01' + INTERVAL (i % 90) DAY AS created_at
    FROM range(1, 1001) t(i)`);

  const sampleBased: ColumnProfile[] = [
    { ...col("sla_status", "string", 1), topValues: [{ value: "met", count: 5 }] }, // 5-row floor: wrong + incomplete
    col("age_hours", "integer", 5),
    col("created_at", "date", 5),
  ];
  const exact = await exactColumnStats(readAll, '"sla"', sampleBased);

  const status = exact.find((c) => c.name === "sla_status")!;
  assert.deepEqual(status.topValues, [
    { value: "met", count: 600 },
    { value: "breached", count: 300 },
    { value: "at_risk", count: 100 },
  ], "full-table GROUP BY replaces the sample floor with exact counts");
  assert.equal(status.uniqueCount, 3, "uniqueCount becomes EXACT → exhaustiveness inference is truthful");

  const age = exact.find((c) => c.name === "age_hours")!;
  assert.equal(age.min, -50); assert.equal(age.max, 149);
  const dt = exact.find((c) => c.name === "created_at")!;
  assert.equal(String(dt.min).slice(0, 10), "2026-01-01", "date min from full sweep");

  // >TOP_VALUES_LIMIT distinct values: top slice kept, uniqueCount forced ABOVE
  // the list length so the observed-value guard can only warn, never falsely
  // claim exhaustiveness. (Fixture cardinality rides the limit so raising the
  // cap keeps this contract exercised.)
  await conn.run(`CREATE TABLE wide AS SELECT 'cat_' || (i % ${TOP_VALUES_LIMIT + 10}) AS c FROM range(0, 400) t(i)`);
  const wide = await exactColumnStats(readAll, '"wide"', [col("c", "string", 30)]);
  assert.equal(wide[0].topValues!.length, TOP_VALUES_LIMIT, "top slice capped");
  assert.ok(wide[0].uniqueCount > wide[0].topValues!.length, "non-exhaustive is encoded (no false 'provably empty')");

  // A failing query leaves the sample floor untouched (best-effort contract).
  const untouched = await exactColumnStats(async () => { throw new Error("boom"); }, '"sla"',
    [{ ...col("sla_status", "string", 1), topValues: [{ value: "met", count: 5 }] }]);
  assert.deepEqual(untouched[0].topValues, [{ value: "met", count: 5 }], "failure keeps the floor");

  conn.disconnectSync();
  console.log("enrich: exact SQL stats (DuckDB, executed) ✅");
})();

// ---- 3. the digest shows observed values to the model -----------------------
await (async () => {
  const { baselineInstructions } = await import("../dashboard/enhance");
  const SLA: Dataset = {
    tableName: "sla",
    profile: {
      source: { filename: "sla.csv", format: "csv" },
      rowCount: 1000,
      columns: [
        { ...col("sla_status", "string", 3), topValues: [
          { value: "met", count: 600 }, { value: "breached", count: 300 }, { value: "at_risk", count: 100 },
        ] },
        col("age_hours", "number", 500),
      ],
      sampleRows: [],
    },
  };
  const digest = baselineInstructions([SLA], "helpdesk dashboard with SLA attainment");
  assert.ok(digest.includes("OBSERVED CATEGORY VALUES"), "digest has the observed-values section");
  assert.ok(digest.includes('"met" (60%)'), "exact literal + share shown: " + digest.slice(digest.indexOf("OBSERVED"), digest.indexOf("OBSERVED") + 200));
  assert.ok(digest.includes('"breached" (30%)'), "all category literals listed");
  assert.ok(/exact literals/i.test(digest), "the digest INSTRUCTS exact-literal use");
  console.log("enrich: digest surfaces observed values to the model ✅");
})();

console.log("enrich.test.ts: all assertions passed ✅");
