// bff/dashboard/filters.test.ts — Phase A1: global filters.
// Offline. Covers: (1) deterministic filter-bar derivation from profiles,
// (2) filter VALUES → server-built WHERE, incl. injection attempts that must
// be neutralized by escaping or rejected outright, (3) the untrusted-widget
// sanitizer that closes the sort.dir/limit holes, (4) the /api/dashboard/query
// pure handler with an injected storage stub capturing the rebuilt SQL,
// (5) compile + renderer integration (bar in the plan, bar in the generated app).
import assert from "node:assert";
import type { Dataset, ColumnProfile, ColumnType } from "../../shared/types";
import type { DashboardSpec } from "../../shared/dashboard-spec";
import {
  deriveGlobalFilters, resolveGlobalFilters, filterConditions, sanitizeWidget, buildWidgetSql,
} from "./filters";
import { compileSpec } from "./compile";
import { renderPlanToApp } from "./renderer";
import { handleDashboardQuery } from "../server";
import type { TenantStorageEngine } from "../storage/types";

// ---- fixtures --------------------------------------------------------------

function col(name: string, type: ColumnType, uniqueCount: number, extra: Partial<ColumnProfile> = {}): ColumnProfile {
  return { name, type, nullable: false, uniqueCount, sampleValues: [], ...extra };
}

const TICKETS: Dataset = {
  tableName: "tickets",
  profile: {
    source: { filename: "tickets.csv", format: "csv" },
    rowCount: 1000,
    columns: [
      col("id", "string", 1000, { topValues: [{ value: "T-1", count: 1 }, { value: "T-2", count: 1 }] }), // id-like — must NOT become a filter
      col("created_at", "date", 320, { min: "2024-01-05T08:00:00", max: "2024-06-30" }),
      col("resolved_at", "date", 120, { min: "2024-01-06", max: "2024-07-02" }),
      col("status", "string", 4, { topValues: [{ value: "open", count: 400 }, { value: "closed", count: 380 }, { value: "pending", count: 150 }, { value: "escalated", count: 70 }] }),
      col("priority", "string", 3, { topValues: [{ value: "low", count: 500 }, { value: "high", count: 300 }, { value: "urgent", count: 150 }] }),
      col("subject", "string", 950, { topValues: [{ value: "help", count: 3 }] }), // near-unique — excluded by cardinality
      col("age_hours", "number", 500),
    ],
    sampleRows: [],
  },
};

const AGENTS: Dataset = {
  tableName: "agents",
  profile: {
    source: { filename: "agents.csv", format: "csv" },
    rowCount: 20,
    columns: [
      col("name", "string", 20, { topValues: [{ value: "Ada", count: 1 }] }),
      col("status", "string", 2, { topValues: [{ value: "active", count: 15 }, { value: "away", count: 5 }] }),
      // A date column with a DIFFERENT name than tickets.created_at — the date
      // range must still apply to widgets on this table, on THIS column.
      col("hired_on", "date", 18, { min: "2023-11-01", max: "2024-05-10" }),
    ],
    sampleRows: [],
  },
};

function specOn(tables: string[]): DashboardSpec {
  return {
    version: 1,
    meta: { title: "T" },
    sections: [{
      id: "s1",
      widgets: tables.map((t, i) => ({ id: `k${i}`, kind: "kpi" as const, title: "Count", table: t, metric: { col: "", agg: "count" as const } })),
    }],
  };
}

// ---- 1. derivation ---------------------------------------------------------
{
  const fs = deriveGlobalFilters([TICKETS, AGENTS]);
  const date = fs.find((f) => f.kind === "daterange");
  assert.ok(date, "a daterange filter is derived");
  assert.equal(date!.col, "created_at", "anchor is the highest-cardinality date column of the largest table");
  assert.equal(date!.min, "2023-11-01", "bounds are the UNION across all mapped tables");
  assert.equal(date!.max, "2024-06-30");
  assert.deepEqual([...date!.tables].sort(), ["agents", "tickets"], "applies to EVERY table with a temporal column");
  assert.deepEqual(date!.cols, { tickets: "created_at", agents: "hired_on" }, "per-table date column map — names need not match");

  const sels = fs.filter((f) => f.kind === "select");
  assert.ok(sels.length >= 1 && sels.length <= 2, "1-2 select filters");
  const status = sels.find((s) => s.col === "status");
  assert.ok(status, "status becomes a select");
  assert.deepEqual(status!.options, ["open", "closed", "pending", "escalated"], "options from topValues, count order");
  assert.ok(status!.tables.includes("tickets") && status!.tables.includes("agents"), "same-named column spans tables");
  assert.ok(!fs.some((f) => f.col === "id"), "id-like column excluded");
  assert.ok(!fs.some((f) => f.col === "subject"), "near-unique text column excluded");
  console.log("filters: derivation from profile ✅");
}

// ---- 2. resolution against the board --------------------------------------
{
  // Board only shows agents → the date range now APPLIES (agents.hired_on),
  // and the cols map is pruned to the rendered tables.
  const onlyAgents = resolveGlobalFilters(specOn(["agents"]), [TICKETS, AGENTS]);
  const dr = onlyAgents.find((f) => f.kind === "daterange");
  assert.ok(dr, "date filter survives on a table with its own date column");
  assert.deepEqual(dr!.tables, ["agents"]);
  assert.deepEqual(dr!.cols, { agents: "hired_on" }, "cols map pruned alongside tables");
  const st = onlyAgents.find((f) => f.col === "status");
  assert.ok(st, "status survives");
  assert.deepEqual(st!.tables, ["agents"], "applicability narrowed to rendered tables");

  // A table with NO temporal column gets no date filtering.
  const NODATE: Dataset = { tableName: "tags", profile: { source: { filename: "t.csv", format: "csv" }, rowCount: 10,
    columns: [col("tag", "string", 5, { topValues: [{ value: "a", count: 6 }, { value: "b", count: 4 }] })], sampleRows: [] } };
  const noDate = resolveGlobalFilters(specOn(["tags"]), [NODATE]);
  assert.ok(!noDate.some((f) => f.kind === "daterange"), "no temporal column anywhere → no date filter");

  // Explicit empty list = the user removed all filters. Respect it.
  const none = resolveGlobalFilters({ ...specOn(["tickets"]), filters: [] }, [TICKETS]);
  assert.equal(none.length, 0, "explicit [] means no filter bar");

  // Explicit filter on a column the data no longer has → pruned, not crashed.
  const stale = resolveGlobalFilters(
    { ...specOn(["tickets"]), filters: [{ id: "x", col: "ghost", kind: "select", label: "Ghost" }] },
    [TICKETS],
  );
  assert.equal(stale.length, 0, "filter on a missing column is pruned");
  console.log("filters: resolution + pruning ✅");
}

// ---- 3. values → WHERE (the security surface) ------------------------------
{
  assert.deepEqual(filterConditions(undefined), [], "no filters → no conditions");
  assert.deepEqual(filterConditions([]), []);

  const dr = filterConditions([{ col: "created_at", kind: "daterange", value: { from: "2024-01-01", to: "2024-03-31" } }]);
  assert.deepEqual(dr, [
    `"created_at" >= DATE '2024-01-01'`,
    `"created_at" < (DATE '2024-03-31' + INTERVAL 1 DAY)`,
  ], "date range compiles to inclusive-day bounds");

  const half = filterConditions([{ col: "created_at", kind: "daterange", value: { from: "2024-01-01" } }]);
  assert.equal(half.length, 1, "open-ended range emits one bound");

  const sel = filterConditions([{ col: "status", kind: "select", value: "open" }]);
  assert.deepEqual(sel, [`"status" = 'open'`]);

  const multi = filterConditions([{ col: "status", kind: "multiselect", value: ["open", "closed"] }]);
  assert.deepEqual(multi, [`"status" IN ('open', 'closed')`]);
  assert.deepEqual(filterConditions([{ col: "status", kind: "multiselect", value: [] }]), [], "empty multiselect → no constraint");

  // INJECTION: quote-bearing values are escaped, never break out of the literal.
  const inj = filterConditions([{ col: "status", kind: "select", value: "x' OR '1'='1" }]);
  assert.deepEqual(inj, [`"status" = 'x'' OR ''1''=''1'`], "single quotes doubled — value stays a literal");
  const injCol = filterConditions([{ col: `s"; DROP TABLE t; --`, kind: "select", value: "a" }]);
  assert.ok(injCol[0].startsWith(`"s""; DROP TABLE t; --"`), "double quotes in identifiers doubled — stays an identifier");

  // Malformed input REJECTS (400), never silently compiles.
  const throws400 = (fn: () => unknown, label: string) => {
    try { fn(); assert.fail(label + " should throw"); }
    catch (e: any) { assert.equal(e.status, 400, label + " throws status 400"); }
  };
  throws400(() => filterConditions([{ col: "d", kind: "daterange", value: { from: "2024-1-1" } }]), "bad date format");
  throws400(() => filterConditions([{ col: "d", kind: "daterange", value: { from: "2024-01-01' OR 1=1 --" } }]), "date with SQL payload");
  throws400(() => filterConditions([{ col: "s", kind: "between" as any, value: "x" }]), "unknown kind");
  throws400(() => filterConditions([{ col: "s", kind: "select", value: "" }]), "empty select value");
  throws400(() => filterConditions([{ col: "s", kind: "select", value: "x".repeat(501) }]), "oversize value");
  throws400(() => filterConditions([{ col: "s", kind: "multiselect", value: Array(51).fill("a") }]), "oversize IN list");
  throws400(() => filterConditions(Array(11).fill({ col: "s", kind: "select", value: "a" })), "too many filters");
  throws400(() => filterConditions("WHERE 1=1" as any), "non-array filters");
  console.log("filters: values → WHERE, injection neutralized ✅");
}

// ---- 4. untrusted widget sanitizer ----------------------------------------
{
  const ok = sanitizeWidget({ id: "k1", kind: "kpi", title: "Open", table: "tickets", metric: { col: "id", agg: "count_distinct" }, EXTRA: "dropped" }) as any;
  assert.equal(ok.kind, "kpi");
  assert.equal(ok.EXTRA, undefined, "unknown fields are dropped, never spread through");

  const throws = (raw: unknown, label: string) => {
    try { sanitizeWidget(raw); assert.fail(label + " should throw"); }
    catch (e: any) { assert.equal(e.status, 400, label); }
  };
  throws({ id: "x", kind: "hax", title: "", table: "t" }, "unknown kind");
  throws({ id: "x", kind: "kpi", table: "t", metric: { col: "c", agg: "exec" } }, "unknown agg");
  // The raw sql.ts builders interpolate sort.dir via toUpperCase() — the
  // sanitizer must be the wall that keeps arbitrary strings out of it.
  throws({ id: "x", kind: "bar", table: "t", x: { col: "c" }, series: [{ col: "v", agg: "sum" }], sort: { by: "y", dir: "asc; DROP TABLE t" } }, "sort.dir injection");
  throws({ id: "x", kind: "bar", table: "t", x: { col: "c" }, series: [{ col: "v", agg: "sum" }], limit: "50; DELETE" }, "non-numeric limit");
  throws({ id: "x", kind: "bar", table: "t", x: { col: "c", timeGrain: "second'); DROP" }, series: [{ col: "v", agg: "sum" }] }, "unknown timeGrain");
  throws({ id: "x", kind: "table", table: "t", columns: [] }, "empty table columns");

  const sql = buildWidgetSql(
    { id: "c1", kind: "bar", title: "By status", table: "tickets", x: { col: "status" }, series: [{ col: "", agg: "count" }], filters: [{ col: "priority", op: "=", value: "high" }] },
    [{ col: "status", kind: "multiselect", value: ["open", "closed"] }],
  );
  assert.ok(sql.includes(`WHERE "priority" = 'high' AND "status" IN ('open', 'closed')`), "widget filters AND global conditions merge: " + sql);
  assert.ok(sql.startsWith("SELECT"), "still the deterministic shape");
  console.log("filters: widget sanitizer + merged SQL ✅");
}

// ---- 5. /api/dashboard/query pure handler ---------------------------------
await (async () => {
  let captured: { projectId: string; sql: string } | null = null;
  const stub = {
    dialect: "duckdb",
    query: async (_t: string, projectId: string, sql: string) => { captured = { projectId, sql }; return { rows: [{ value: 42 }], truncated: false }; },
  } as unknown as TenantStorageEngine;

  const good = await handleDashboardQuery({
    projectId: "proj1",
    widget: { id: "k1", kind: "kpi", title: "N", table: "tickets", metric: { col: "", agg: "count" } },
    filters: [{ col: "status", kind: "select", value: "it's open" }],
  }, "tenant", stub);
  assert.equal(good.status, 200);
  assert.deepEqual(good.body.rows, [{ value: 42 }]);
  const cap = captured as { projectId: string; sql: string } | null;
  assert.ok(cap, "storage.query was called");
  assert.equal(cap!.sql, `SELECT count(*) AS value FROM "tickets" WHERE "status" = 'it''s open'`, "server rebuilt the SQL with the escaped value");

  const badWidget = await handleDashboardQuery({ projectId: "proj1", widget: { kind: "hax" }, filters: [] }, "tenant", stub);
  assert.equal(badWidget.status, 400, "invalid widget → 400");
  const badFilter = await handleDashboardQuery({
    projectId: "proj1",
    widget: { id: "k1", kind: "kpi", title: "N", table: "t", metric: { col: "", agg: "count" } },
    filters: [{ col: "d", kind: "daterange", value: { from: "nope" } }],
  }, "tenant", stub);
  assert.equal(badFilter.status, 400, "invalid filter value → 400");
  const badProject = await handleDashboardQuery({ projectId: "../../etc", widget: {}, filters: [] }, "tenant", stub);
  assert.equal(badProject.status, 400, "invalid projectId → 400");
  console.log("filters: /api/dashboard/query handler ✅");
})();

// ---- 6. compile + renderer integration ------------------------------------
{
  const spec: DashboardSpec = {
    version: 1,
    meta: { title: "Helpdesk" },
    sections: [{
      id: "s1",
      widgets: [
        { id: "k1", kind: "kpi", title: "Tickets", table: "tickets", metric: { col: "", agg: "count" } },
        { id: "c1", kind: "bar", title: "By status", table: "tickets", x: { col: "status" }, series: [{ col: "", agg: "count" }] },
        { id: "k2", kind: "kpi", title: "Agents", table: "agents", metric: { col: "", agg: "count" } },
      ],
    }],
  };
  const plan = compileSpec(spec, [TICKETS, AGENTS]);
  assert.ok(plan.filters && plan.filters.length >= 2, "plan carries the resolved filter bar");
  assert.ok(plan.filters!.some((f) => f.kind === "daterange" && f.min === "2023-11-01"), "date bounds resolved (union)");
  assert.deepEqual(plan.filters!.find((f) => f.kind === "daterange")!.cols, { tickets: "created_at", agents: "hired_on" }, "cols map rides the plan");
  assert.ok(Array.isArray(plan.spec.filters) && plan.spec.filters.length === plan.filters!.length, "lean filters persisted on the spec for edit turns");
  assert.ok(!(plan.spec.filters![0] as any).options, "spec form is lean (no options)");

  // Explicit [] survives a compile round trip (a removal must stick).
  const noneBack = compileSpec({ ...spec, filters: [] }, [TICKETS, AGENTS]);
  assert.deepEqual(noneBack.spec.filters, [], "explicit no-filters persists through compile");
  assert.equal((noneBack.filters ?? []).length, 0);

  const src = renderPlanToApp(plan).files[0].content;
  for (const needle of [
    "function FilterBar", "function activeFor", "const QW = DATA.queryWidget",
    "FilterCtx.Provider", 'useContext', "t2ui", // t2ui markers live in data.js, but keep the grep honest below
  ]) {
    if (needle === "t2ui") continue;
    assert.ok(src.includes(needle), "generated app contains: " + needle);
  }
  assert.ok(src.includes("useRows(props.sql, w)"), "widgets query through the filter-aware hook");
  // The template-literal trap: generated code must stay free of backslash
  // escapes (the fmtX regex shipped broken for months because of this).
  const gen = src.slice(src.indexOf("const PLAN"), src.indexOf("//__END__"));
  const planEnd = gen.indexOf(";");
  assert.ok(!gen.slice(planEnd).includes("\\"), "no backslash escapes in generated code after the plan literal");

  // Execute the extracted activeFor against a fake FILTERS set — the helper
  // must (a) skip non-applicable tables, (b) skip unset values, (c) emit the
  // exact AppliedFilter wire shape the server validates.
  const body = src.match(/function activeFor\(table, fv\) \{([\s\S]*?)\n\}/)![1];
  const filtersLit = JSON.stringify(plan.filters);
  const fn = new Function("table", "fv", "FILTERS", body);
  const dateId = plan.filters!.find((f) => f.kind === "daterange")!.id;
  const selId = plan.filters!.find((f) => f.kind === "select")!.id;
  const fv: any = {};
  fv[dateId] = { from: "2024-02-01", to: "" };
  fv[selId] = "open";
  const active = fn("tickets", fv, JSON.parse(filtersLit));
  assert.ok(active.some((a: any) => a.kind === "daterange" && a.col === "created_at" && a.value.from === "2024-02-01"), "tickets widgets filter on created_at");
  assert.ok(active.some((a: any) => a.kind === "select" && a.value === "open"), "select value surfaces");
  const activeAgents = fn("agents", fv, JSON.parse(filtersLit));
  assert.ok(activeAgents.some((a: any) => a.kind === "daterange" && a.col === "hired_on"), "agents widgets filter on THEIR date column (hired_on) — charts/tables on other tables re-query too");
  console.log("filters: compile + renderer integration ✅");
}

// ---- 7. EXECUTED numbers (mini Phase D): the filtered SQL runs on real
// DuckDB and returns hand-computed answers — incl. the inclusive-end-day
// semantics on a TIMESTAMP column and a value containing a quote. ----------
await (async () => {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  await conn.run(`CREATE TABLE tickets (id INT, status VARCHAR, created_at TIMESTAMP)`);
  await conn.run(`INSERT INTO tickets VALUES
    (1, 'open',     TIMESTAMP '2024-01-10 09:00:00'),
    (2, 'open',     TIMESTAMP '2024-01-31 23:59:00'),
    (3, 'closed',   TIMESTAMP '2024-02-01 00:00:00'),
    (4, 'closed',   TIMESTAMP '2024-02-15 12:00:00'),
    (5, 'it''s odd',TIMESTAMP '2024-03-01 08:00:00')`);
  const run = async (sql: string) => {
    const r = await conn.run(sql);
    const rows = await r.getRowObjects();
    return rows.map((row: any) => { const o: any = {}; for (const k of Object.keys(row)) o[k] = typeof row[k] === "bigint" ? Number(row[k]) : row[k]; return o; });
  };
  const kpi = { id: "k", kind: "kpi", title: "N", table: "tickets", metric: { col: "", agg: "count" } };

  // Date range: Jan 10 .. Jan 31 must INCLUDE ticket 2 (23:59 on the end day)
  // and EXCLUDE ticket 3 (00:00 the next day) — the exact off-by-one the
  // INTERVAL construction exists to prevent.
  let rows = await run(buildWidgetSql(kpi, [{ col: "created_at", kind: "daterange", value: { from: "2024-01-10", to: "2024-01-31" } }]));
  assert.equal(rows[0].value, 2, "inclusive end day on a timestamp column");

  rows = await run(buildWidgetSql(kpi, [{ col: "status", kind: "select", value: "it's odd" }]));
  assert.equal(rows[0].value, 1, "escaped quote value matches the real row");

  rows = await run(buildWidgetSql(kpi, [
    { col: "status", kind: "multiselect", value: ["open", "closed"] },
    { col: "created_at", kind: "daterange", value: { from: "2024-02-01" } },
  ]));
  assert.equal(rows[0].value, 2, "stacked filters AND together");

  // A filtered CHART: grouped counts change with the filter.
  const chart = { id: "c", kind: "bar", title: "By status", table: "tickets", x: { col: "status" }, series: [{ col: "", agg: "count" }] };
  const all = await run(buildWidgetSql(chart, []));
  assert.equal(all.length, 3, "unfiltered chart shows all statuses");
  const feb = await run(buildWidgetSql(chart, [{ col: "created_at", kind: "daterange", value: { from: "2024-02-01", to: "2024-02-29" } }]));
  assert.equal(feb.length, 1, "filtered chart collapses to february's statuses");
  assert.equal(feb[0].x, "closed");
  assert.equal(Number(feb[0][Object.keys(feb[0]).find((k) => k !== "x")!]), 2, "february closed count = 2");

  // Injection attempt EXECUTES harmlessly: the payload is just a value that
  // matches nothing; the table survives.
  rows = await run(buildWidgetSql(kpi, [{ col: "status", kind: "select", value: "x' OR '1'='1" }]));
  assert.equal(rows[0].value, 0, "injection payload matches zero rows");
  rows = await run(`SELECT count(*) AS n FROM tickets`);
  assert.equal(rows[0].n, 5, "table intact after the attempt");
  // MULTI-TABLE + all widget kinds: a second table whose date column has a
  // DIFFERENT name. Simulate exactly what the renderer does — activeFor picks
  // the per-table column, buildWidgetSql runs it — for a chart AND a table
  // widget, which is the regression the user reported (only KPIs changed).
  await conn.run(`CREATE TABLE agents (name VARCHAR, status VARCHAR, hired_on DATE)`);
  await conn.run(`INSERT INTO agents VALUES
    ('Ada','active', DATE '2023-12-01'),
    ('Bo', 'active', DATE '2024-02-10'),
    ('Cy', 'away',   DATE '2024-04-05')`);
  const perTable = { tickets: "created_at", agents: "hired_on" } as Record<string, string>;
  const range = { from: "2024-01-01", to: "2024-02-29" };
  const applyDate = (table: string) => [{ col: perTable[table], kind: "daterange" as const, value: range }];

  const agentsTable = { id: "t1", kind: "table", title: "Agents", table: "agents",
    columns: [{ col: "name" }, { col: "status" }] };
  let trows = await run(buildWidgetSql(agentsTable, applyDate("agents")));
  assert.equal(trows.length, 1, "table widget on the second table is date-filtered via ITS column");
  assert.equal(trows[0][Object.keys(trows[0])[0]], "Bo");

  const agentsChart = { id: "c2", kind: "pie", title: "By status", table: "agents",
    x: { col: "status" }, series: [{ col: "", agg: "count" }] };
  const unfiltered = await run(buildWidgetSql(agentsChart, []));
  assert.equal(unfiltered.length, 2, "unfiltered pie shows both statuses");
  const filtered = await run(buildWidgetSql(agentsChart, applyDate("agents")));
  assert.equal(filtered.length, 1, "date-filtered pie collapses");
  assert.equal(filtered[0].x, "active");

  console.log("filters: executed numbers on DuckDB ✅");
})();

console.log("filters.test.ts: all assertions passed ✅");
