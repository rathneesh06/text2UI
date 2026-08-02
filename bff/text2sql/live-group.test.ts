// bff/text2sql/live-group.test.ts — run with: npm run test:group
// Covers the al3 multi-database groups: schema merging with collision suffixes
// and alias-rewritten refs, CROSS-DB JOINs through a group handle (two real
// local DuckDB files attached as src0/src1 — the interdependent-DBs case:
// tickets in DB-A only resolve to user names through DB-B), analyst finding
// views materialized live so widgets can render the joined numbers, versioned
// view re-application, and the build handoff staying zero-storage.
import assert from "node:assert";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_WB_DIR = mkdtempSync(join(tmpdir(), "t2ui-grouptest-"));
process.env.WB_DIR = TEST_WB_DIR;
process.env.T2SQL_LIVE_SOURCE = "1";
process.env.T2SQL_ANALYST = "1";
process.on("exit", () => { try { rmSync(TEST_WB_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

import { DuckDBInstance } from "@duckdb/node-api";
import { registerConnection, mergeGroupParts, type ConnRecord, type GroupPart } from "../sources/connection-registry";
import type { AttachHandle } from "../sources/db-conn";
import { liveQuery, handleSqlChat } from "./handler";
import type { EvidencePack } from "./analyst";

// ---- two real "databases": tickets in A, users in B (the dependency) ----------------
const dir = mkdtempSync(join(tmpdir(), "t2sql-group-"));
const dbA = join(dir, "tickets_db.duckdb");
const dbB = join(dir, "users_db.duckdb");
{
  const a = await DuckDBInstance.create(dbA);
  const ca = await a.connect();
  await ca.run(`CREATE TABLE tickets (id INTEGER, user_id INTEGER, ticket_type VARCHAR)`);
  // SOS on even i, user_id cycling 1..3: SOS tickets spread over ALL users →
  // EMEA (users 1 & 3) gets 10 SOS, APAC (user 2) gets 5 — a real 2-region join.
  await ca.run(`INSERT INTO tickets SELECT i, (i % 3) + 1, CASE WHEN i % 2 = 0 THEN 'SOS' ELSE 'GENERAL' END FROM range(1, 31) t(i)`);
  ca.disconnectSync(); a.closeSync();
  const b = await DuckDBInstance.create(dbB);
  const cb = await b.connect();
  await cb.run(`CREATE TABLE users (id INTEGER, name VARCHAR, region VARCHAR)`);
  await cb.run(`INSERT INTO users VALUES (1,'ana','EMEA'), (2,'bo','APAC'), (3,'cy','EMEA')`);
  // collision on purpose: BOTH DBs have a "tickets" table; B's must become tickets_2
  await cb.run(`CREATE TABLE tickets (id INTEGER)`);
  cb.disconnectSync(); b.closeSync();
}

// ---- mergeGroupParts: aliases, refs, collision suffixes ------------------------------
const profileOf = (tableName: string, cols: { name: string; type: string }[]): any => ({
  tableName,
  profile: { source: { filename: "x", format: "json" }, rowCount: 30, columns: cols, sampleRows: [] },
});
const partA: GroupPart = {
  id: "mem_a",
  conn: { dialect: "mysql", host: "a", port: 3306, user: "u", password: "p", database: "ticketsdb" } as any,
  label: "u@a/ticketsdb",
  allTables: [{ name: "tickets", schema: "main", table: "tickets", ref: `src."main"."tickets"`, approxRows: 30 }],
  datasets: [profileOf("tickets", [{ name: "id", type: "integer" }, { name: "user_id", type: "integer" }, { name: "ticket_type", type: "varchar" }])],
};
const partB: GroupPart = {
  id: "mem_b",
  conn: { dialect: "postgres", host: "b", port: 5432, user: "u", password: "p", database: "usersdb" } as any,
  label: "u@b/usersdb",
  allTables: [
    { name: "users", schema: "main", table: "users", ref: `src."main"."users"`, approxRows: 3 },
    { name: "tickets", schema: "main", table: "tickets", ref: `src."main"."tickets"`, approxRows: 0 },
  ],
  datasets: [
    profileOf("users", [{ name: "id", type: "integer" }, { name: "name", type: "varchar" }, { name: "region", type: "varchar" }]),
    profileOf("tickets", [{ name: "id", type: "integer" }]),
  ],
};
{
  const m = mergeGroupParts([partA, partB]);
  assert.deepEqual(m.allTables.map((t) => t.name), ["tickets", "users", "tickets_2"], "collision suffixed");
  assert.equal(m.allTables[0].ref, `src0."main"."tickets"`, "alias rewritten (src0)");
  assert.equal(m.allTables[1].ref, `src1."main"."users"`, "alias rewritten (src1)");
  assert.equal(m.datasets[2].tableName, "tickets_2", "dataset renamed in lockstep");
}
console.log("mergeGroupParts (aliases, collisions) ✅");

// ---- a group record whose handle attaches BOTH files as src0/src1 -------------------
const mem = await DuckDBInstance.create(":memory:");
const memConn = await mem.connect();
await memConn.run(`ATTACH '${dbA.replace(/'/g, "''")}' AS src0 (READ_ONLY)`);
await memConn.run(`ATTACH '${dbB.replace(/'/g, "''")}' AS src1 (READ_ONLY)`);
const handle: AttachHandle = {
  instance: mem as any,
  c: memConn as any,
  readAll: async (sql: string) => {
    const reader = await memConn.runAndReadUntil(sql, 100_000);
    return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((row) => {
      for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
      return row;
    });
  },
  run: async (sql: string) => { await memConn.run(sql); },
  close: () => { /* test owns teardown */ },
} as any;

const merged = mergeGroupParts([partA, partB]);
const rec: ConnRecord = {
  id: "grp_test01", tenantId: "public",
  conn: partA.conn, label: "u@a/ticketsdb + u@b/usersdb",
  createdAt: Date.now(), lastUsed: Date.now(),
  allTables: merged.allTables, datasets: merged.datasets,
  warnings: [], status: "active", consecutiveFailures: 0,
  groupParts: [partA, partB], handle,
};
registerConnection(rec);

// ---- cross-DB widget SQL through the union views -------------------------------------
{
  const r = await liveQuery("public", "live_grp_test01", `SELECT count(*) AS n FROM "tickets"`);
  assert.equal(Number(r.rows[0].n), 30, "DB-A table via view");
  const u = await liveQuery("public", "live_grp_test01", `SELECT count(*) AS n FROM "users"`);
  assert.equal(Number(u.rows[0].n), 3, "DB-B table via view");
  const c = await liveQuery("public", "live_grp_test01", `SELECT count(*) AS n FROM "tickets_2"`);
  assert.equal(Number(c.rows[0].n), 0, "collision-suffixed view resolves to DB-B's table");
}
console.log("group union views (both DBs, collision names) ✅");

// ---- the whole point: a build whose analysis JOINS across the two databases ----------
{
  const joinSql = `SELECT u."region", count(*) AS sos_tickets FROM src0."main"."tickets" t JOIN src1."main"."users" u ON t."user_id" = u."id" WHERE t."ticket_type" = 'SOS' GROUP BY 1 ORDER BY 2 DESC`;
  const fakeAnalyst = async (): Promise<EvidencePack> => ({
    findings: [
      { id: "q1", role: "ranking", question: "SOS tickets by user region", sql: joinSql, ok: true, rowCount: 2, summary: "EMEA 10, APAC 5" },
      { id: "q2", role: "kpi", question: "broken one", sql: "SELECT 1", ok: false, error: "nope" },
    ],
    warnings: [],
  } as any);
  const plan = async () => ({ text: JSON.stringify({ intent: "build", tables: ["tickets", "users"], artifact: "dashboard", buildPrompt: "SOS by region" }), finishReason: "STOP" } as any);
  const { status, body } = await handleSqlChat(
    { connectionId: "grp_test01", prompt: "build SOS by user region" },
    "public",
    { plan: plan as any, analyst: fakeAnalyst as any },
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.handoff.projectId, "live_grp_test01");
  const names = body.handoff.tables.map((t: any) => t.tableName);
  assert.ok(names.includes("sos_tickets_by_user_region"), `finding view in handoff: ${names}`);
  assert.ok(String(body.handoff.evidence).includes("LIVE FINDING TABLES"), "directive names the live finding tables");

  // The finding view answers a WIDGET query with the cross-DB joined numbers, live.
  const w = await liveQuery("public", "live_grp_test01", `SELECT * FROM "sos_tickets_by_user_region"`);
  assert.equal(w.rows.length, 2, JSON.stringify(w.rows));
  const emea = w.rows.find((r) => r.region === "EMEA") as any;
  assert.equal(Number(emea.sos_tickets), 10, "cross-DB join computed live (EMEA: users 1&3 own 10 SOS tickets)");

  // zero storage, as always
  const wbDir = join(TEST_WB_DIR, "workbench");
  const leaked = existsSync(wbDir) ? readdirSync(wbDir).filter((f) => f.endsWith(".duckdb") || f === "manifest.json" || f === "stages.json") : [];
  assert.deepEqual(leaked, [], `group build must store NOTHING, found: ${leaked.join(", ")}`);
}
console.log("cross-DB analyst build → live finding views → widget query ✅");

// ---- versioned views: a second build REPLACES the finding views ----------------------
{
  const fakeAnalyst = async (): Promise<EvidencePack> => ({
    findings: [{ id: "q1", role: "kpi", question: "total tickets overall", sql: `SELECT count(*) AS n FROM src0."main"."tickets"`, ok: true, rowCount: 1, summary: "30" }],
    warnings: [],
  } as any);
  const plan = async () => ({ text: JSON.stringify({ intent: "build", tables: ["tickets"], artifact: "dashboard", buildPrompt: "totals" }), finishReason: "STOP" } as any);
  await handleSqlChat({ connectionId: "grp_test01", prompt: "totals dashboard" }, "public", { plan: plan as any, analyst: fakeAnalyst as any });
  const r = await liveQuery("public", "live_grp_test01", `SELECT * FROM "total_tickets_overall"`);
  assert.equal(Number((r.rows[0] as any).n), 30, "new finding view applied after re-build (version bump)");
}
console.log("versioned finding views across builds ✅");

// ---- teardown -------------------------------------------------------------------------
memConn.disconnectSync();
mem.closeSync();
rmSync(dir, { recursive: true, force: true });
console.log("live-group.test.ts: all assertions passed ✅");
