// bff/text2sql/live-source.test.ts — run with: npm run test:live
// Covers the al2 fully-live source path: view auto-creation on the attach,
// guarded/capped live widget queries, expired-connection behavior, the build
// handoff producing a live_ source WITHOUT writing anything to disk, and
// data questions answered through the live branch of source/chat.
// Hermetic: WB_DIR redirected to a temp dir (and asserted EMPTY at the end —
// that assertion IS the "nothing stored" contract), fake model runners, and a
// real local DuckDB attached as `src` standing in for the live database.
import assert from "node:assert";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_WB_DIR = mkdtempSync(join(tmpdir(), "t2ui-livetest-"));
process.env.WB_DIR = TEST_WB_DIR;
process.env.T2SQL_LIVE_SOURCE = "1";
process.env.T2SQL_ANALYST = "0"; // analyst has its own suite; keep this one focused
process.on("exit", () => { try { rmSync(TEST_WB_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

import { DuckDBInstance } from "@duckdb/node-api";
import { registerConnection, type ConnRecord } from "../sources/connection-registry";
import type { AttachHandle } from "../sources/db-conn";
import { liveQuery, handleSqlChat, handleSourceChat } from "./handler";

const fake = (obj: unknown) => async () => ({ text: JSON.stringify(obj), finishReason: "STOP" } as any);

// ---- a real local DB standing in for the live MySQL/Postgres ------------------------
const dir = mkdtempSync(join(tmpdir(), "t2sql-live-"));
const dbFile = join(dir, "livedb.duckdb");
{
  const inst = await DuckDBInstance.create(dbFile);
  const c = await inst.connect();
  await c.run(`CREATE TABLE tickets (id INTEGER, ticket_type VARCHAR, region VARCHAR)`);
  await c.run(`INSERT INTO tickets SELECT i, CASE WHEN i % 3 = 0 THEN 'SOS' ELSE 'GENERAL' END, CASE WHEN i % 2 = 0 THEN 'EMEA' ELSE 'APAC' END FROM range(1, 91) t(i)`);
  c.disconnectSync();
  inst.closeSync();
}

// The "live attach": an in-memory instance with the file ATTACHed READ_ONLY as
// `src` — byte-for-byte the shape a real MySQL/Postgres attach handle presents.
const mem = await DuckDBInstance.create(":memory:");
const memConn = await mem.connect();
await memConn.run(`ATTACH '${dbFile.replace(/'/g, "''")}' AS src (READ_ONLY)`);
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
  close: () => { /* the test owns teardown */ },
} as any;

const rec: ConnRecord = {
  id: "conn_livetest01",
  tenantId: "public",
  conn: { dialect: "mysql", host: "x", port: 3306, user: "u", password: "p", database: "testdb" } as any,
  label: "u@x:3306/testdb",
  createdAt: Date.now(),
  lastUsed: Date.now(),
  allTables: [{ name: "tickets", approxRows: 90, schema: "main", table: "tickets", ref: `src."main"."tickets"` } as any],
  datasets: [{
    tableName: "tickets",
    profile: {
      source: { filename: "mysql:main.tickets", format: "json" }, rowCount: 90,
      columns: [
        { name: "id", type: "integer" }, { name: "ticket_type", type: "varchar" }, { name: "region", type: "varchar" },
      ],
      sampleRows: [{ id: 1, ticket_type: "GENERAL", region: "APAC" }],
    },
  } as any],
  warnings: [],
  status: "active",
  consecutiveFailures: 0,
  handle,
};
registerConnection(rec);

// ---- liveQuery: views auto-created, compiled-style SQL just works -------------------
{
  const r = await liveQuery("public", "live_conn_livetest01", `SELECT count(*) AS n FROM "tickets"`);
  assert.equal(r.rows.length, 1);
  assert.equal(Number(r.rows[0].n), 90, JSON.stringify(r.rows));
  const grouped = await liveQuery("public", "live_conn_livetest01", `SELECT "region", count(*) AS n FROM "tickets" GROUP BY 1 ORDER BY 1`);
  assert.equal(grouped.rows.length, 2, "views satisfy grouped widget SQL");
}
// ---- liveQuery: guard + cap ----------------------------------------------------------
{
  await assert.rejects(() => liveQuery("public", "live_conn_livetest01", `DROP TABLE tickets`), /read-only|SELECT|not allowed/i);
  const capped = await liveQuery("public", "live_conn_livetest01", `SELECT * FROM "tickets"`, { rowCap: 10 });
  assert.equal(capped.rows.length, 10, "row cap enforced by the guard wrap");
}
// ---- liveQuery: expired/unknown connection -------------------------------------------
{
  await assert.rejects(() => liveQuery("public", "live_conn_gone", `SELECT 1`), /expired/i);
  await assert.rejects(() => liveQuery("someone_else", "live_conn_livetest01", `SELECT 1`), /expired/i, "tenant-scoped");
}
console.log("liveQuery (views, guard, cap, expiry) ✅");

// ---- build intent: live handoff, NOTHING stored --------------------------------------
{
  const plan = fake({ intent: "build", tables: ["tickets"], artifact: "dashboard", buildPrompt: "SOS dashboard" });
  const { status, body } = await handleSqlChat(
    { connectionId: "conn_livetest01", prompt: "build me an SOS dashboard" },
    "public",
    { plan: plan as any },
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.intent, "build");
  assert.ok(body.handoff, "handoff present");
  assert.equal(body.handoff.projectId, "live_conn_livetest01", body.handoff.projectId);
  assert.ok(body.handoff.label.includes("(live)"), body.handoff.label);
  assert.equal(body.handoff.tables[0].tableName, "tickets");
  assert.ok(/LIVE source/.test(body.answer) && /nothing is stored/.test(body.answer), body.answer);
  // THE contract: no snapshot, no stage, no manifest — the workbench dir must
  // hold nothing but chat-store artifacts (no *.duckdb, no manifest/stages).
  const wbDir = join(TEST_WB_DIR, "workbench");
  const leaked = existsSync(wbDir) ? readdirSync(wbDir).filter((f) => f.endsWith(".duckdb") || f === "manifest.json" || f === "stages.json") : [];
  assert.deepEqual(leaked, [], `live build must store NOTHING, found: ${leaked.join(", ")}`);
}
console.log("live build handoff (zero storage) ✅");

// ---- source/chat on a live source ----------------------------------------------------
{
  const plan = fake({ intent: "query", sql: `SELECT "region", count(*) AS n FROM "tickets" GROUP BY 1 ORDER BY n DESC` });
  const compose = async () => ({ text: "EMEA leads with 45 tickets, just ahead of APAC at 45.", finishReason: "STOP" } as any);
  const { status, body } = await handleSourceChat(
    { projectId: "live_conn_livetest01", prompt: "which region has the most tickets?" },
    "public",
    { plan: plan as any, compose: compose as any },
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(typeof body.answer === "string" && body.answer.length > 0, "answered");
  assert.ok(body.sql, "sql surfaced");
}
// ---- source/chat on an expired live source -------------------------------------------
{
  const { status, body } = await handleSourceChat({ projectId: "live_conn_gone", prompt: "hi" }, "public", {});
  assert.equal(status, 410, JSON.stringify(body));
  assert.ok(/expired/i.test(body.error));
}
console.log("live source/chat (answers + 410 on expiry) ✅");

// ---- teardown -------------------------------------------------------------------------
memConn.disconnectSync();
mem.closeSync();
rmSync(dir, { recursive: true, force: true });
console.log("live-source.test.ts: all assertions passed ✅");
