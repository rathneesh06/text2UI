// edit-planner.test.ts — targeted-edit planning with an injected runner (no network).
// Covers the schema→schemaless retry path and coerce() sanitization.
// Run: npm run test:deck-edit
import assert from "node:assert/strict";
import { planEdits, EDIT_SCHEMA, type Run } from "./edit-planner";
import type { DeckSpec } from "../../shared/deck-spec";
import type { GenResult, GenOptions } from "../aiflow";

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

const usedSchema = (opts?: GenOptions) => !!(opts as any)?.responseSchema;
const always = (text: string): Run => async () => ({ text, finishReason: "STOP" } as GenResult);

// ---- happy path: schema call returns valid ops -----------------------------
{
  const run = always('{"ops":[{"op":"setChartType","slideId":"s2","blockId":"s2-c1","chartType":"pie"}]}');
  const ops = await planEdits(spec, "make the revenue chart a pie", "", run);
  assert.ok(ops && ops.length === 1, "one op planned");
  assert.equal(ops![0].op, "setChartType");
}

// ---- schema rejected → schemaless retry recovers ---------------------------
{
  // The model returns junk under the structured-schema call but clean JSON without it.
  const run: Run = async (_s, _u, opts) =>
    ({ text: usedSchema(opts) ? "<<not json>>" : '{"ops":[{"op":"setTheme","theme":"dark"}]}', finishReason: "STOP" } as GenResult);
  const ops = await planEdits(spec, "dark theme", "", run);
  assert.ok(ops && ops.length === 1, "schemaless retry produced ops");
  assert.equal(ops![0].op, "setTheme");
}

// ---- both attempts fail → null (caller falls back to full replan) ----------
{
  const ops = await planEdits(spec, "x", "", always("<<not json at all>>"));
  assert.equal(ops, null, "unparseable in both modes → null");
}

// ---- coerce() drops malformed/incomplete ops, keeps valid ones -------------
{
  const run = always(JSON.stringify({
    ops: [
      { op: "setChartType", slideId: "s2", chartType: "pie" },   // missing blockId → dropped
      { op: "bogusOp", slideId: "s2" },                          // unknown op → dropped
      { op: "setTheme", theme: "dark" },                          // valid → kept
      { op: "setBullets", slideId: "s2", blockId: "s2-c1", items: ["a", "b"] }, // valid → kept
    ],
  }));
  const ops = await planEdits(spec, "several edits", "", run);
  assert.ok(ops, "returns ops");
  assert.deepEqual(ops!.map((o) => o.op), ["setTheme", "setBullets"], "only well-formed ops survive coerce()");
}

// ---- never throws on a completely empty response ---------------------------
{
  const ops = await planEdits(spec, "x", "", always(""));
  assert.equal(ops, null, "empty text → null, no throw");
}

// ---- EDIT_SCHEMA shape ------------------------------------------------------
{
  assert.equal((EDIT_SCHEMA as any).type, "object");
  assert.equal((EDIT_SCHEMA as any).properties.ops.type, "array", "schema constrains an ops array");
}

console.log("edit-planner: all assertions passed");
