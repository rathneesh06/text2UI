import assert from "node:assert";
process.env.GEMINI_PRICE_INPUT_PER_M = "1";   // deterministic rates for the cost math
process.env.GEMINI_PRICE_OUTPUT_PER_M = "2";
import { estimateCost, summarize, runWithMetrics, recordCall, setPhase, ZERO_USAGE, type CallRecord } from "./metrics";
import { parseUsage } from "./aiflow";

// ---- estimateCost ----------------------------------------------------------
{
  assert.equal(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }), 3, "1M in @ $1 + 1M out @ $2 = $3");
  assert.equal(estimateCost(ZERO_USAGE), 0, "zero usage -> $0");
}

// ---- summarize -------------------------------------------------------------
{
  const records: CallRecord[] = [
    { phase: "plan", model: "m", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, ms: 10 },
    { phase: "build", model: "m", usage: { inputTokens: 200, outputTokens: 300, totalTokens: 500 }, ms: 20 },
    { phase: "build", model: "m", usage: { inputTokens: 50, outputTokens: 80, totalTokens: 130 }, ms: 5 },
  ];
  const s = summarize(records);
  assert.equal(s.calls, 3);
  assert.equal(s.ms, 35);
  assert.equal(s.inputTokens, 350);
  assert.equal(s.outputTokens, 430);
  assert.equal(s.totalTokens, 780);
  assert.equal(s.model, "m");
  assert.equal(s.byPhase.build.calls, 2, "two build calls aggregated");
  assert.equal(s.byPhase.build.outputTokens, 380);
  assert.equal(s.byPhase.plan.ms, 10);
  // cost = 350/1e6*1 + 430/1e6*2 = 0.00035 + 0.00086 = 0.00121
  assert.equal(s.costUsd, 0.00121);
  assert.deepEqual(summarize([]), { calls: 0, ms: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, model: "", byPhase: {} });
}

// ---- collector (AsyncLocalStorage) -----------------------------------------
{
  const { result, metrics } = await runWithMetrics(async () => {
    setPhase("plan");
    recordCall({ model: "m", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, ms: 10 });
    setPhase("build");
    recordCall({ model: "m", usage: { inputTokens: 200, outputTokens: 300, totalTokens: 500 }, ms: 20 });
    return "ok";
  });
  assert.equal(result, "ok", "passes through the fn result");
  assert.equal(metrics.calls, 2);
  assert.equal(metrics.ms, 30);
  assert.equal(metrics.inputTokens, 300);
  assert.equal(metrics.outputTokens, 350);
  assert.equal(metrics.byPhase.plan.calls, 1);
  assert.equal(metrics.byPhase.build.inputTokens, 200);
  // explicit phase override on the record wins over the ambient phase
  const { metrics: m2 } = await runWithMetrics(async () => {
    recordCall({ model: "m", usage: ZERO_USAGE, ms: 1, phase: "classify" });
  });
  assert.equal(m2.byPhase.classify.calls, 1, "explicit phase respected");
}

// ---- recordCall outside a context is a harmless no-op ----------------------
{
  assert.doesNotThrow(() => recordCall({ model: "m", usage: ZERO_USAGE, ms: 1 }), "no-op outside metrics context");
}

// ---- parseUsage (aiflow) ---------------------------------------------------
{
  const u = parseUsage({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35 } });
  assert.deepEqual(u, { inputTokens: 10, outputTokens: 25, totalTokens: 35 }, "thinking tokens counted as output");
  const empty = parseUsage({});
  assert.deepEqual(empty, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, "missing usage -> zeros");
}

console.log("metrics.test.ts: all assertions passed");
