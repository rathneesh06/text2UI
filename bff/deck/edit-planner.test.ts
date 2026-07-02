// edit-planner.test.ts — targeted-edit planning + resilience to runaway/truncated
// model output (the "Expected double-quoted property name in JSON" failure mode).
// Run: npm run test:deck-edit
import assert from "node:assert/strict";
import { planEdits, salvageOps, EDIT_SCHEMA, MAX_EDIT_OPS, type Run } from "./edit-planner";
import type { DeckSpec } from "../../shared/deck-spec";
import type { GenResult } from "../aiflow";

// Minimal 2-slide deck to edit against.
const spec: DeckSpec = {
  version: 1,
  meta: { title: "Q3 Review", audience: "board", theme: "light" },
  outline: [],
  slides: [
    { id: "s1", role: "title", title: "Q3 Review", blocks: [{ type: "heading", id: "s1-h1", text: "Q3 Review" }] },
    { id: "s2", role: "trend", title: "Revenue", blocks: [{ type: "chart", id: "s2-c1", chartType: "line", table: "sales", x: { field: "month" } as any, series: [] }] },
  ],
};

const ok = (text: string, finishReason = "STOP"): Run => async () => ({ text, finishReason } as GenResult);

// ---- salvageOps: recover complete ops from truncated JSON -------------------
{
  // Cut off mid-object right after a comma — the exact shape that throws
  // "Expected double-quoted property name". Two ops finished before the cut.
  // Cut off right after an object-level comma — reproduces the exact production error.
  const truncated =
    '{"ops":[' +
    '{"op":"setChartType","slideId":"s2","blockId":"s2-c1","chartType":"pie"},' +
    '{"op":"setSlideText","slideId":"s2","title":"Revenue Growth"},' +
    '{"op":"setBullets","slideId":"s2","blockId":"s2-c1","items":["a","b"],';
  assert.throws(() => JSON.parse(truncated), /double-quoted property name/, "precondition: reproduces the reported error");

  const salvaged = salvageOps(truncated);
  assert.ok(salvaged, "salvage recovers something");
  assert.equal(salvaged!.ops.length, 2, "keeps the two complete ops, drops the truncated third");
  assert.equal((salvaged!.ops[0] as any).op, "setChartType");
}
{
  // Nested braces (updateChart.patch) must not fool the brace tracker.
  const t = '{"ops":[{"op":"updateChart","slideId":"s2","blockId":"s2-c1","patch":{"limit":5,"title":"x"}},{"op":"setThe';
  const s = salvageOps(t);
  assert.equal(s!.ops.length, 1, "one complete nested op survives, the partial next op is dropped");
}
{
  // A quoted brace inside a string value must not be counted as structure.
  const t = '{"ops":[{"op":"setMeta","title":"a } weird { title"},{"op":"broke';
  const s = salvageOps(t);
  assert.equal(s!.ops.length, 1, "braces inside strings are ignored");
  assert.equal((s!.ops[0] as any).title, "a } weird { title");
}
{
  // Nothing recoverable → null (caller then falls back to a full replan).
  assert.equal(salvageOps('{"ops":[{"op":"setThe'), null, "no complete op → null");
  assert.equal(salvageOps("not json at all"), null, "no ops key → null");
}
console.log("salvageOps: all assertions passed");

// ---- planEdits: happy path parses ops --------------------------------------
{
  const text = '{"ops":[{"op":"setChartType","slideId":"s2","blockId":"s2-c1","chartType":"pie"}]}';
  const ops = await planEdits(spec, "make the revenue chart a pie", "", ok(text));
  assert.ok(ops && ops.length === 1, "one op planned");
  assert.equal(ops![0].op, "setChartType");
}

// ---- planEdits: truncated response is salvaged, not thrown away -------------
{
  const truncated =
    '{"ops":[' +
    '{"op":"setChartType","slideId":"s2","blockId":"s2-c1","chartType":"pie"},' +
    '{"op":"setSlideText","slideId":"s2","title":"Revenue Growth"},' +
    '{"op":"setBullets","slideId":"s2","blockId":"s2-c1","items":["a",';
  const ops = await planEdits(spec, "rewrite everything", "", ok(truncated, "MAX_TOKENS"));
  assert.ok(ops, "truncated response does not return null when ops are salvageable");
  assert.equal(ops!.length, 2, "salvaged ops flow through coerce()");
  assert.equal(ops![0].op, "setChartType");
}

// ---- planEdits: unrecoverable truncation → null (caller does full replan) ---
{
  const ops = await planEdits(spec, "x", "", ok('{"ops":[{"op":"setChart', "MAX_TOKENS"));
  assert.equal(ops, null, "nothing salvageable → null so the handler replans");
}

// ---- planEdits: never throws, even on total garbage ------------------------
{
  const ops = await planEdits(spec, "x", "", ok("<<<not json>>>"));
  assert.equal(ops, null, "garbage → null, no throw");
}

// ---- schema is bounded so the model can't run away -------------------------
{
  assert.equal((EDIT_SCHEMA.properties.ops as any).maxItems, MAX_EDIT_OPS, "ops array is capped");
  assert.ok(MAX_EDIT_OPS > 0 && MAX_EDIT_OPS <= 100, "cap is sane");
}
console.log("planEdits: all assertions passed");
