// bff/dashboard/joins.test.ts — Phase A3: FK-verified joins.
//
// The rule: widget.join compiles ONLY against VERIFIED edges — "constraint"
// (read from a live catalog) or "measured" (uniqueness + containment PROVEN by
// executing queries against the data). Name-heuristic candidates are advisory
// and never compile. Built producer→pixel with the contracts asserted before
// behavior: producer (measurement), emitter (3 schemas + coercer), validator
// (edge check + column resolution), consumer (aliased SQL), round-trip
// (sanitizer parity), plus executed golden numbers for the acceptance case:
// "tickets by status name" via a lookup join.
import assert from "node:assert/strict";
import { validateSpec } from "./validate";
import { buildChartSql, buildKpiSql } from "./sql";
import { buildWidgetSql } from "./filters";
import { widgetSignature } from "./merge";
import { measureCandidate, attachMeasuredForeignKeys } from "../sources/relationships";
import type { DashboardSpec, ChartWidget, KpiWidget } from "../../shared/dashboard-spec";
import type { Dataset, ColumnProfile } from "../../shared/types";

const col = (name: string, type: ColumnProfile["type"], uniqueCount = 3, extra: Partial<ColumnProfile> = {}): ColumnProfile =>
  ({ name, type, nullable: false, uniqueCount, sampleValues: [], ...extra });

const TICKETS: Dataset = {
  tableName: "tickets",
  profile: {
    source: { filename: "t.csv", format: "csv" }, rowCount: 10,
    columns: [col("id", "integer", 10), col("status_id", "integer", 3), col("age_hours", "number", 9, { min: 0, max: 100 })],
    sampleRows: [],
    foreignKeys: [{ col: "status_id", refTable: "statuses", refCol: "id", verified: "measured" }],
  },
};
const STATUSES: Dataset = {
  tableName: "statuses",
  profile: {
    source: { filename: "s.csv", format: "csv" }, rowCount: 3,
    columns: [col("id", "integer", 3), col("name", "string", 3, { topValues: [
      { value: "Open", count: 1 }, { value: "Closed", count: 1 }, { value: "PIR", count: 1 }], statsExact: true })],
    sampleRows: [],
  },
};

// ---- 1. CONTRACTS: three-surface symmetry + coercer preservation ------------
await (async () => {
  const fs = await import("node:fs");
  const patch = await import("./patch");
  const planner = await import("./planner");
  const agentsSrc = fs.readFileSync(new URL("./agents.ts", import.meta.url), "utf8");
  const surfaces: Record<string, string> = {
    patch: JSON.stringify((patch as any).EDIT_OPS_SCHEMA),
    planner: JSON.stringify((planner as any).DASHBOARD_SCHEMA),
    agents: agentsSrc,
  };
  for (const [name, s] of Object.entries(surfaces)) {
    assert.ok(/"join"|join:/.test(s), `${name}: widgets must expose join`);
  }
  assert.ok(/coerceJoin/.test(agentsSrc), "agents: coercer preserves join");
  // Prompts teach the verified-only rule on every surface.
  for (const f of ["./agents.ts", "./planner.ts", "./patch.ts"]) {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(/VERIFIED/.test(src), `${f} prompt references VERIFIED relationships`);
  }
  console.log("joins: schema/coercer/prompt symmetry ✅");
})();

// ---- 2. VALIDATION: verified edge required; columns resolved ----------------
{
  const mkChart = (join: any): DashboardSpec => ({
    version: 1, meta: { title: "T" },
    sections: [{ id: "s", widgets: [{
      id: "c1", kind: "bar", title: "Tickets by status", table: "tickets",
      x: { col: "name" }, series: [{ col: "", agg: "count" }], ...(join ? { join } : {}),
    } as ChartWidget] }],
  });

  // Verified join: survives, and validation fills join.cols with the
  // join-only columns (name, and the ref key id is shared → base wins).
  let r = validateSpec(mkChart({ table: "statuses", on: ["status_id", "id"] }), [TICKETS, STATUSES]);
  assert.equal(r.spec.sections.length, 1, "verified join survives");
  const jw: any = r.spec.sections[0].widgets[0];
  assert.ok(jw.join.cols.includes("name"), "join-only column recorded: " + JSON.stringify(jw.join.cols));
  assert.ok(!jw.join.cols.includes("id"), "shared column resolves to base (not join-only)");

  // Unverified join (no matching edge): dropped, warning names the available edges.
  r = validateSpec(mkChart({ table: "statuses", on: ["id", "id"] }), [TICKETS, STATUSES]);
  assert.equal(r.spec.sections.length, 0, "unverified join drops the widget");
  assert.ok(r.warnings.some((w) => w.includes("not a VERIFIED relationship") && w.includes("status_id -> statuses.id")),
    "warning names the verified edges: " + r.warnings.join(" | "));

  // Join to a missing table / missing columns: dropped with the reason.
  r = validateSpec(mkChart({ table: "nope", on: ["status_id", "id"] }), [TICKETS, STATUSES]);
  assert.equal(r.spec.sections.length, 0, "unknown join table drops");
  // Without the join, x=name doesn't exist on tickets → also dropped (no silent guess).
  r = validateSpec(mkChart(undefined), [TICKETS, STATUSES]);
  assert.equal(r.spec.sections.length, 0, "joined column without the join is not resolvable");
  console.log("joins: validation (verified-edge gate + resolution) ✅");
}

// ---- 3. COMPILE: aliased SQL, filters qualified, sanitizer parity -----------
{
  const chart: ChartWidget = {
    id: "c1", kind: "bar", title: "Tickets by status", table: "tickets",
    x: { col: "name" }, series: [{ col: "", agg: "count" }],
    filters: [{ col: "age_hours", op: ">", value: 0 }],
    join: { table: "statuses", on: ["status_id", "id"], cols: ["name"] },
  } as any;
  const { sql } = buildChartSql(chart);
  assert.ok(/FROM "tickets" b LEFT JOIN "statuses" j ON b\."status_id" = j\."id"/.test(sql), "join clause: " + sql);
  assert.ok(/j\."name" AS x/.test(sql), "join-only column qualified with the join alias");
  assert.ok(/b\."age_hours" > 0/.test(sql), "base column in widget filter qualified with the base alias");

  // Sanitizer parity: identical SQL from the query path; global daterange
  // filters resolve to the base alias.
  assert.equal(buildWidgetSql(chart, []), sql, "build and query paths agree on joined SQL");
  const withGlobal = buildWidgetSql(chart, [{ col: "created", kind: "daterange", value: { from: "2026-01-01", to: "" } }]);
  assert.ok(/b\."created" >= /.test(withGlobal), "global filter base-qualified: " + withGlobal);

  // A KPI without a join compiles exactly as before (no alias leakage).
  const plain: KpiWidget = { id: "k", kind: "kpi", title: "N", table: "tickets", metric: { col: "", agg: "count" } } as any;
  assert.equal(buildKpiSql(plain), 'SELECT count(*) AS value FROM "tickets"', "unjoined SQL unchanged");

  // Dedupe identity: same analytics with vs without the join are different questions.
  const noJoin = { ...chart, join: undefined } as any;
  assert.notEqual(widgetSignature(chart), widgetSignature(noJoin), "join is part of the analytical signature");
  console.log("joins: compile + sanitizer parity ✅");
}

// ---- 4. EXECUTED GOLDENS: measurement proves/refutes; joined numbers exact --
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
  await conn.run(`CREATE TABLE statuses AS SELECT * FROM (VALUES (1, 'Open'), (2, 'Closed'), (3, 'PIR')) t(id, name)`);
  // 6 Open, 3 Closed, 1 PIR — hand-computed goldens.
  await conn.run(`CREATE TABLE tickets AS
    SELECT i AS id, CASE WHEN i <= 6 THEN 1 WHEN i <= 9 THEN 2 ELSE 3 END AS status_id, i * 10 AS age_hours
    FROM range(1, 11) t(i)`);

  // (a) Measurement PROVES the real edge…
  const edge = await measureCandidate(readAll,
    { leftTable: "tickets", leftCol: "status_id", rightTable: "statuses", rightCol: "id", confidence: "high", reason: "" }, 3);
  assert.deepEqual(edge, { col: "status_id", refTable: "statuses", refCol: "id", verified: "measured" }, "real FK measures as verified");
  // …and REFUTES a non-key right side (tickets.status_id is not unique).
  const bogus = await measureCandidate(readAll,
    { leftTable: "statuses", leftCol: "id", rightTable: "tickets", rightCol: "status_id", confidence: "high", reason: "" }, 10);
  assert.equal(bogus, null, "non-unique right side refuses to verify");
  // …and REFUTES orphans beyond tolerance.
  await conn.run(`INSERT INTO tickets VALUES (99, 42, 990)`); // status_id 42 doesn't exist
  const orphaned = await measureCandidate(readAll,
    { leftTable: "tickets", leftCol: "status_id", rightTable: "statuses", rightCol: "id", confidence: "high", reason: "" }, 3);
  assert.equal(orphaned, null, "9% orphans refuse to verify");
  await conn.run(`DELETE FROM tickets WHERE id = 99`);

  // (b) attachMeasuredForeignKeys turns the semantic candidate into a real edge.
  const ds: Dataset[] = [
    { ...TICKETS, profile: { ...TICKETS.profile, foreignKeys: undefined } },
    STATUSES,
  ];
  await attachMeasuredForeignKeys(readAll, ds);
  assert.ok(ds[0].profile.foreignKeys?.some((e) => e.col === "status_id" && e.refTable === "statuses" && e.verified === "measured"),
    "candidate measured into a verified edge: " + JSON.stringify(ds[0].profile.foreignKeys));

  // (c) THE ACCEPTANCE CASE, executed end-to-end: validate → compile → run.
  const spec: DashboardSpec = { version: 1, meta: { title: "T" }, sections: [{ id: "s", widgets: [{
    id: "c1", kind: "bar", title: "Tickets by status", table: "tickets",
    x: { col: "name" }, series: [{ col: "", agg: "count" }],
    join: { table: "statuses", on: ["status_id", "id"] },
  } as ChartWidget] }] };
  const v = validateSpec(spec, ds);
  assert.equal(v.spec.sections.length, 1, "acceptance widget validates: " + v.warnings.join(" | "));
  const { sql } = buildChartSql(v.spec.sections[0].widgets[0] as ChartWidget);
  const rows = await readAll(sql);
  const byName = Object.fromEntries(rows.map((r) => [r.x, Number(r[Object.keys(r).find((k) => k !== "x")!])]));
  assert.deepEqual(byName, { Open: 6, Closed: 3, PIR: 1 }, "tickets by status NAME — hand-computed goldens: " + JSON.stringify(byName));

  // (d) A joined KPI with a conditional-rate expr also executes correctly:
  // share of tickets whose status NAME is 'Open' = 6/10 = 60%.
  const kpiSpec: DashboardSpec = { version: 1, meta: { title: "T" }, sections: [{ id: "s", widgets: [{
    id: "k1", kind: "kpi", title: "Open share", table: "tickets",
    metric: { col: "", agg: "count", format: "percent", expr: { op: "pct",
      num: { col: "", agg: "count", where: [{ col: "name", op: "=", value: "Open" }] },
      den: { col: "", agg: "count" } } },
    join: { table: "statuses", on: ["status_id", "id"] },
  } as KpiWidget] }] };
  const v2 = validateSpec(kpiSpec, ds);
  assert.equal(v2.spec.sections.length, 1, "joined rate KPI validates: " + v2.warnings.join(" | "));
  const kpiSql = buildKpiSql(v2.spec.sections[0].widgets[0] as KpiWidget);
  const [row] = await readAll(kpiSql);
  assert.equal(Number(row.value), 60, "joined conditional rate executes to the hand-computed 60%: " + kpiSql);

  conn.disconnectSync();
  console.log("joins: executed goldens (measurement + acceptance case + joined rate) ✅");
})();

console.log("joins.test.ts: all assertions passed ✅");
