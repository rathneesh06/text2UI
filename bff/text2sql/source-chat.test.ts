// bff/text2sql/source-chat.test.ts — run with: npm run test:source-chat
// Exercises the build-chat data-question loop against a REAL published snapshot,
// with fake model runners (planner + composer) and the in-memory chat store.
import assert from "node:assert";
import { DuckDBInstance } from "@duckdb/node-api";
import { addStaged, stagingDbPath, finalizeStaged } from "../sources/workbench-store";
import { handleSourceChat } from "./handler";

const fakePlan = (obj: unknown) => async () => ({ text: JSON.stringify(obj), finishReason: "STOP" } as any);
const fakeCompose = async () => ({ text: "APAC leads with 300 in revenue, ahead of EMEA at 120.", finishReason: "STOP" } as any);

// Publish a real snapshot the handler will query.
const conv = "conv_srcchat_" + Date.now();
const dbPath = stagingDbPath(conv);
{
  const i = await DuckDBInstance.create(dbPath);
  const c = await i.connect();
  await c.run("CREATE OR REPLACE TABLE orders AS SELECT * FROM (VALUES ('EMEA', 120), ('APAC', 300)) t(region, revenue)");
  c.disconnectSync();
  i.closeSync(); // release the staging file so the handler can open it to query (Windows file lock)
}
addStaged(conv, "public", dbPath, [{
  tableName: "orders",
  profile: { source: { filename: "postgres:public.orders (full)", format: "json" }, rowCount: 2,
    columns: [{ name: "region", type: "string" } as any, { name: "revenue", type: "number" } as any], sampleRows: [] },
} as any]);
const source = finalizeStaged(conv, "srcchat test");

// ---- question -> plan -> guard -> snapshot query -> composed answer ---------------
{
  const r = await handleSourceChat(
    { projectId: source.projectId, prompt: "which region sold the most?" },
    "public",
    {
      plan: fakePlan({ intent: "query", sql: 'SELECT region, sum(revenue) AS r FROM "orders" GROUP BY 1 ORDER BY r DESC' }),
      compose: fakeCompose,
    },
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.answer.includes("APAC"), r.body.answer);
  assert.equal(r.body.rows.length, 2);
  assert.equal(r.body.rows[0].region, "APAC", "real computed rows returned");
  assert.ok(r.body.executionMeta.sourceType === "snapshot");
  assert.ok(r.body.conversationId, "turn persisted to a conversation");
}

// ---- unsafe planner SQL is stopped by the guard -------------------------------------
{
  const r = await handleSourceChat(
    { projectId: source.projectId, prompt: "drop it" },
    "public",
    { plan: fakePlan({ intent: "query", sql: 'DROP TABLE "orders"' }) },
  );
  assert.equal(r.status, 200);
  assert.ok(/safe query/i.test(r.body.answer), r.body.answer);
  assert.equal(r.body.rows, undefined, "nothing executed");
}

// ---- extract/build intents redirect conversationally ---------------------------------
{
  const r = await handleSourceChat(
    { projectId: source.projectId, prompt: "extract orders again" },
    "public",
    { plan: fakePlan({ intent: "extract", tables: ["orders"] }) },
  );
  assert.ok(/describe a change|answer questions/i.test(r.body.answer), r.body.answer);
}

// ---- unknown / foreign source ----------------------------------------------------------
{
  const r = await handleSourceChat({ projectId: "wb_nope", prompt: "hi" }, "public", {});
  assert.equal(r.status, 404);
  const r2 = await handleSourceChat({ projectId: source.projectId, prompt: "hi" }, "other-tenant", {});
  assert.equal(r2.status, 404, "tenant scoping enforced");
}

console.log("source-chat.test.ts: all assertions passed ✅");
