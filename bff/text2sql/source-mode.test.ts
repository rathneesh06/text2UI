// bff/text2sql/source-mode.test.ts — run with: npm run test:sourcemode
// The per-source data-plane choice (goal 3 surfaced): rec.mode overrides the
// T2SQL_LIVE_SOURCE env default in BOTH directions, is settable at connect
// time and via the mode route, and the live choice stores NOTHING while the
// snapshot choice visibly stages. Hermetic: temp WB_DIR, fake model runners,
// a local DuckDB attach standing in for the live database.
import assert from "node:assert";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_WB_DIR = mkdtempSync(join(tmpdir(), "t2ui-sourcemode-"));
process.env.WB_DIR = TEST_WB_DIR;
delete process.env.T2SQL_LIVE_SOURCE;      // env default = snapshot
process.env.T2SQL_ANALYST = "0";
process.on("exit", () => { try { rmSync(TEST_WB_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

import { DuckDBInstance } from "@duckdb/node-api";
import { registerConnection, getConnection, type ConnRecord } from "../sources/connection-registry";
import type { AttachHandle } from "../sources/db-conn";
import { handleSqlChat, handleSqlMode } from "./handler";

const fake = (obj: unknown) => async () => ({ text: JSON.stringify(obj), finishReason: "STOP" } as any);
const buildPlan = fake({ intent: "build", tables: ["tickets"], artifact: "dashboard", buildPrompt: "dash" });

// A real local DB attached READ_ONLY as `src` — the live-attach shape.
const dir = mkdtempSync(join(tmpdir(), "t2ui-sourcemode-db-"));
const dbFile = join(dir, "db.duckdb");
{
  const inst = await DuckDBInstance.create(dbFile);
  const c = await inst.connect();
  await c.run(`CREATE TABLE tickets (id INTEGER, region VARCHAR)`);
  await c.run(`INSERT INTO tickets SELECT i, CASE WHEN i % 2 = 0 THEN 'EMEA' ELSE 'APAC' END FROM range(1, 31) t(i)`);
  c.disconnectSync();
  inst.closeSync();
}
const mem = await DuckDBInstance.create(":memory:");
const memConn = await mem.connect();
await memConn.run(`ATTACH '${dbFile.replace(/'/g, "''")}' AS src (READ_ONLY)`);
const handle: AttachHandle = {
  instance: mem as any, c: memConn as any,
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

const mkRec = (id: string, mode?: "live" | "snapshot"): ConnRecord => registerConnection({
  id, tenantId: "public",
  conn: { dialect: "mysql", host: "x", port: 3306, user: "u", password: "p", database: "testdb" } as any,
  label: "u@x:3306/testdb",
  createdAt: Date.now(), lastUsed: Date.now(),
  allTables: [{ name: "tickets", approxRows: 30, schema: "main", table: "tickets", ref: `src."main"."tickets"` } as any],
  datasets: [{ tableName: "tickets", profile: {
    source: { filename: "mysql:main.tickets", format: "json" }, rowCount: 30,
    columns: [{ name: "id", type: "integer" }, { name: "region", type: "varchar" }],
    sampleRows: [{ id: 1, region: "APAC" }],
  } } as any],
  warnings: [], status: "active", consecutiveFailures: 0, handle,
  ...(mode ? { mode } : {}),
} as any);

const wbFiles = () => readdirSync(TEST_WB_DIR).filter((f) => /\.duckdb|manifest|stage/i.test(f));

// ---- 1. mode="live" overrides an OFF env flag: live handoff, nothing stored ---------
{
  mkRec("conn_mode_live", "live");
  const { status, body } = await handleSqlChat(
    { connectionId: "conn_mode_live", prompt: "build a dashboard" }, "public", { plan: buildPlan as any });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.handoff?.projectId, "live_conn_mode_live", "live handoff despite env default snapshot");
  assert.deepEqual(wbFiles(), [], "live mode stores nothing");
}
console.log("source-mode: live overrides env-off ✅");

// ---- 2. mode="snapshot" overrides an ON env flag: snapshot path stages -------------
{
  process.env.T2SQL_LIVE_SOURCE = "1";
  mkRec("conn_mode_snap", "snapshot");
  const { status, body } = await handleSqlChat(
    { connectionId: "conn_mode_snap", prompt: "build a dashboard" }, "public", { plan: buildPlan as any });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(!String(body.handoff?.projectId ?? "").startsWith("live_"),
    "snapshot mode never hands off live: " + body.handoff?.projectId);
  assert.ok(wbFiles().length > 0, "snapshot mode visibly stages");
  delete process.env.T2SQL_LIVE_SOURCE;
}
console.log("source-mode: snapshot overrides env-on ✅");

// ---- 3. unset mode follows the env default (both directions) ------------------------
{
  mkRec("conn_mode_default1");
  let r = await handleSqlChat({ connectionId: "conn_mode_default1", prompt: "build a dashboard" }, "public", { plan: buildPlan as any });
  assert.ok(!String(r.body.handoff?.projectId ?? "").startsWith("live_"), "env unset → snapshot default");

  process.env.T2SQL_LIVE_SOURCE = "1";
  mkRec("conn_mode_default2");
  r = await handleSqlChat({ connectionId: "conn_mode_default2", prompt: "build a dashboard" }, "public", { plan: buildPlan as any });
  assert.equal(r.body.handoff?.projectId, "live_conn_mode_default2", "env=1 → live default");
  delete process.env.T2SQL_LIVE_SOURCE;
}
console.log("source-mode: unset follows the env default ✅");

// ---- 4. the mode route: validated, tenant-scoped, takes effect next build ----------
{
  mkRec("conn_mode_route");
  assert.equal(handleSqlMode("conn_mode_route", { mode: "sideways" }, "public").status, 400, "bad mode rejected");
  assert.equal(handleSqlMode("conn_mode_route", { mode: "live" }, "someone_else").status, 404, "tenant-scoped");
  const ok = handleSqlMode("conn_mode_route", { mode: "live" }, "public");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mode, "live", "publicView discloses the mode");
  assert.equal(getConnection("public", "conn_mode_route")?.mode, "live");
  const r = await handleSqlChat({ connectionId: "conn_mode_route", prompt: "build a dashboard" }, "public", { plan: buildPlan as any });
  assert.equal(r.body.handoff?.projectId, "live_conn_mode_route", "toggle takes effect on the next build");
}
console.log("source-mode: toggle route (validate, tenant, effect) ✅");

console.log("source-mode.test.ts: all assertions passed ✅");
memConn.disconnectSync();
mem.closeSync();
