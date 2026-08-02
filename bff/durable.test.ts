// bff/durable.test.ts — run with: npm run test:durable
// DURABLE PROJECTS, Docker-free: the DuckDB chat store persists conversations,
// messages, and project state (spec + profiles + conversation link) across
// PROCESS RESTARTS — proven by closing the store and reopening the same file
// with a fresh instance. Plus the factory contract: no PG_URL → embedded
// DuckDB (never in-memory), so nothing depends on a database server existing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(tmpdir(), "t2ui-durable-"));
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } });
delete process.env.PG_URL;
delete process.env.STORAGE;
process.env.T2UI_CHAT_DB = path.join(DIR, "chat.duckdb");

const { DuckDbChatStore, getChatStore } = await import("./chat-store");

const FILE = path.join(DIR, "roundtrip.duckdb");
const SPEC = { version: 1, meta: { title: "Saved Board" }, sections: [{ id: "s1", widgets: [
  { id: "k1", kind: "kpi", title: "Total", table: "t", metric: { col: "", agg: "count" } }] }] };
const PROFILES = [{ tableName: "t", profile: { source: { filename: "t", format: "csv" }, rowCount: 9,
  columns: [{ name: "x", type: "string", uniqueCount: 3, nullCount: 0, sampleValues: [] }], sampleRows: [] } }];

// ---- 1. conversation + message round-trip -------------------------------------------
{
  const store = new DuckDbChatStore(FILE);
  const cid = await store.createConversation("Helpdesk build", "conv_1");
  assert.equal(cid, "conv_1", "explicit id honored");
  await store.appendMessage(cid, { role: "user", content: "build a dashboard" });
  await store.appendMessage(cid, { role: "assistant", content: "Built it.", briefJson: null, outputMode: null });
  const h = await store.getHistory(cid);
  assert.deepEqual(h, [{ role: "user", content: "build a dashboard" }, { role: "assistant", content: "Built it." }], "history in order");
  const convos = await store.listConversations();
  assert.equal(convos[0]?.id, "conv_1", "conversation listed");
  // sql-injection posture: a quote-laden message survives verbatim
  await store.appendMessage(cid, { role: "user", content: "it's '); DROP TABLE _messages; --" });
  const h2 = await store.getHistory(cid);
  assert.equal(h2[2].content, "it's '); DROP TABLE _messages; --", "quotes escaped, content verbatim");
  await store.close(); // release the file lock before the next instance opens it (Windows: exclusive lock)
}
console.log("durable: chat round-trip (+ escaping) ✅");

// ---- 2. project state: spec + profiles + link ---------------------------------------
{
  const store = new DuckDbChatStore(FILE);
  await store.saveProjectState("proj_a", { spec: SPEC, datasets: PROFILES, conversationId: "conv_1" });
  const st = await store.getProjectState("proj_a");
  assert.deepEqual(st?.spec, SPEC, "spec round-trips exactly");
  assert.deepEqual(st?.datasets, PROFILES, "profiles round-trip (deterministic recompile depends on them)");
  assert.equal(st?.conversationId, "conv_1", "the chat↔dashboard link");
  assert.ok(typeof st?.savedAt === "number" && st.savedAt > 0, "savedAt present");
  // upsert semantics: a rebuild replaces, never duplicates
  const SPEC2 = { ...SPEC, meta: { title: "Edited Board" } };
  await store.saveProjectState("proj_a", { spec: SPEC2, datasets: PROFILES, conversationId: "conv_1" });
  assert.equal(((await store.getProjectState("proj_a"))?.spec as any).meta.title, "Edited Board", "upsert replaced");
  assert.equal(await store.getProjectState("proj_missing"), null, "unknown project → null");
  await store.close(); // = process exit; group 3 reopens the same file = a restart
}
console.log("durable: project state round-trip + upsert ✅");

// ---- 3. THE POINT: everything survives a process restart ----------------------------
{
  // A brand-new store instance on the same file = a restarted BFF/MCP process.
  const reopened = new DuckDbChatStore(FILE);
  const h = await reopened.getHistory("conv_1");
  assert.equal(h.length, 3, "chat survived the restart");
  const st = await reopened.getProjectState("proj_a");
  assert.equal((st?.spec as any).meta.title, "Edited Board", "dashboard survived the restart");
  assert.equal(st?.conversationId, "conv_1", "the link survived the restart");
  await reopened.close();
}
console.log("durable: restart survival (the Docker-free durability claim) ✅");

// ---- 4. factory: no PG_URL → embedded DuckDB, never in-memory -----------------------
{
  const store = getChatStore();
  assert.equal(store.constructor.name, "DuckDbChatStore", "default store is the embedded durable one");
  const cid = await store.createConversation("factory check");
  await store.appendMessage(cid, { role: "user", content: "hello" });
  assert.equal((await store.getHistory(cid)).length, 1, "factory store functional");
}
console.log("durable: factory defaults to embedded durability ✅");

console.log("durable.test.ts: all assertions passed ✅");
