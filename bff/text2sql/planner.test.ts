// bff/text2sql/planner.test.ts — run with: npm run test:t2sql-planner
// Fakes the Gemini runner (same approach as orchestrator.test.ts): the tests
// verify the plan's shape validation and never call the live model.
import assert from "node:assert";
import { planSqlTurn, type PlanSqlInput } from "./planner";

const input: PlanSqlInput = {
  prompt: "which region sold the most?",
  allTables: [{ name: "orders", approxRows: 1200 }],
  datasets: [{
    tableName: "orders",
    profile: {
      source: { filename: "mysql:shop.orders", format: "json" },
      rowCount: 1200,
      columns: [
        { name: "region", type: "string", uniqueCount: 4, nullCount: 0 } as any,
        { name: "revenue", type: "number", uniqueCount: 900, nullCount: 0 } as any,
      ],
      sampleRows: [{ region: "EMEA", revenue: 120 }],
    },
  } as any],
};

const fake = (text: string) => async () => ({ text, finishReason: "STOP" } as any);

// ---- valid query plan passes ---------------------------------------------------
{
  const plan = await planSqlTurn(input, fake(JSON.stringify({
    intent: "query",
    sql: "SELECT region, sum(revenue) AS r FROM src.orders GROUP BY 1 ORDER BY r DESC LIMIT 5",
  })));
  assert.ok(plan, "plan returned");
  assert.equal(plan!.intent, "query");
  assert.ok(plan!.sql!.includes("src.orders"));
}

// ---- fenced JSON is tolerated ----------------------------------------------------
{
  const plan = await planSqlTurn(input, fake("```json\n" + JSON.stringify({ intent: "chat", reply: "hi" }) + "\n```"));
  assert.equal(plan?.intent, "chat");
  assert.equal(plan?.reply, "hi");
}

// ---- query intent without sql -> null (handler falls back) -----------------------
{
  const plan = await planSqlTurn(input, fake(JSON.stringify({ intent: "query" })));
  assert.equal(plan, null, "query without sql rejected");
}

// ---- extract intent without tables -> null ----------------------------------------
{
  const plan = await planSqlTurn(input, fake(JSON.stringify({ intent: "extract" })));
  assert.equal(plan, null, "extract without tables rejected");
}

// ---- unknown intent -> null --------------------------------------------------------
{
  const plan = await planSqlTurn(input, fake(JSON.stringify({ intent: "destroy" })));
  assert.equal(plan, null, "unknown intent rejected");
}

// ---- malformed JSON -> null (never throws) ------------------------------------------
{
  const plan = await planSqlTurn(input, fake("not json at all"));
  assert.equal(plan, null, "garbage tolerated");
}

// ---- runner throwing -> null ---------------------------------------------------------
{
  const plan = await planSqlTurn(input, async () => { throw new Error("model down"); });
  assert.equal(plan, null, "runner failure tolerated");
}

console.log("planner.test.ts: all assertions passed ✅");
