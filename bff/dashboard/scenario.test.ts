// bff/dashboard/scenario.test.ts — run with: npm run test:scenario
// Phase D: the scripted-conversation suite + the replay harness proving itself.
//   1. build → edit → undo, asserting spec INVARIANTS after every turn
//   2. every turn is CAPTURED (T2UI_REPLAY_CAPTURE) and then REPLAYED offline;
//      zero normalized-spec diffs = the pipeline reproduces its own turns
//   3. the negative-average-age acceptance case: the anomaly probe flags a
//      duration metric that executes to a negative number (real DuckDB)
// Hermetic: temp audit dir, scripted runners, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(tmpdir(), "t2ui-scenario-"));
process.env.T2UI_AUDIT_DIR = DIR;
process.env.T2UI_REPLAY_CAPTURE = "1";
process.env.T2UI_AUDIT = "0"; // keep the scenario file the only artifact
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

import { DuckDBInstance } from "@duckdb/node-api";
import type { Dataset } from "../../shared/types";
import type { DashboardSpec } from "../../shared/dashboard-spec";
import { handleDashboardBuild } from "./handler";
import { loadReplayTurns, replayTurn, diffSpecs, normalizeSpec, flagDataAnomalies } from "./harness";

const col = (name: string, type: string, uniqueCount = 5): any =>
  ({ name, type, uniqueCount, nullCount: 0, sampleValues: [] });
const orders: Dataset[] = [{ tableName: "orders", profile: {
  source: { filename: "orders.csv", format: "csv" }, rowCount: 120,
  columns: [col("id", "integer", 120), col("region", "string", 4), col("revenue", "number", 90), col("created_at", "date", 60)],
  sampleRows: [{ id: 1, region: "EMEA", revenue: 100, created_at: "2026-06-01" }],
} } as any];

// Scripted runner: decompose → one KPI task + design; the kpi agent → one real
// widget; every other agent → empty (deterministic fallbacks fill the board —
// which is exactly what makes the replay parity meaningful).
const buildRun = async (system: string) => {
  if (system.includes("task-decomposition")) return { text: JSON.stringify({
    reasoning: "Revenue overview.",
    tasks: [{ question: "Total revenue?", kind: "kpi", columns: ["revenue"], table: "orders" }],
    design: { accent: "#0EA5E9", palette: ["#0EA5E9", "#F97316", "#22C55E", "#A855F7", "#EF4444", "#14B8A6"], vibe: "clean commerce" },
  }), finishReason: "STOP" } as any;
  if (system.includes("KPI")) return { text: JSON.stringify({
    widgets: [{ title: "Total Revenue", table: "orders", metric: { col: "revenue", agg: "sum", format: "currency" } }],
  }), finishReason: "STOP" } as any;
  return { text: JSON.stringify({ widgets: [] }), finishReason: "STOP" } as any;
};

const allWidgets = (s: DashboardSpec) => (s.sections ?? []).flatMap((x: any) => x.widgets ?? []);
const invariants = (s: DashboardSpec, label: string) => {
  assert.ok(s.sections?.length, `${label}: sections exist`);
  const ws = allWidgets(s);
  assert.ok(ws.length > 0, `${label}: widgets exist`);
  assert.equal(new Set(ws.map((w: any) => w.id)).size, ws.length, `${label}: widget ids unique`);
  for (const w of ws) assert.ok(w.id && w.kind && w.table, `${label}: every widget well-formed`);
  assert.ok(s.meta?.chartPalette?.length, `${label}: palette present (vibrancy floor)`);
};

const CONV = "scenario_conv_1";

// ---- Turn 1: build ------------------------------------------------------------------
const t1 = await handleDashboardBuild(
  { datasets: orders, userPrompt: "show me a revenue overview dashboard", conversationId: CONV },
  { agentRun: buildRun as any });
assert.equal(t1.status, 200, JSON.stringify(t1.body).slice(0, 300));
const spec1: DashboardSpec = t1.body.spec;
invariants(spec1, "turn1");
const kpiId = allWidgets(spec1).find((w: any) => w.title === "Total Revenue")?.id;
assert.ok(kpiId, "the scripted KPI landed");
console.log("scenario: turn 1 build + invariants ✅");

// ---- Turn 2: patch edit (retitle) — untouched widgets keep their ids ---------------
const editRun = async (system: string) => {
  if (system.includes("minimal") || system.includes("ops")) return { text: JSON.stringify({
    ops: [{ op: "update_widget", id: kpiId, set: { title: "Order Revenue" } }],
  }), finishReason: "STOP" } as any;
  return buildRun(system);
};
const t2 = await handleDashboardBuild(
  { datasets: orders, userPrompt: "rename the total revenue KPI to Order Revenue", currentSpec: spec1, conversationId: CONV },
  { agentRun: editRun as any });
assert.equal(t2.status, 200, JSON.stringify(t2.body).slice(0, 300));
const spec2: DashboardSpec = t2.body.spec;
invariants(spec2, "turn2");
assert.equal(t2.body.pipeline, "patch", "the edit took the ops path");
assert.equal(allWidgets(spec2).find((w: any) => w.id === kpiId)?.title, "Order Revenue", "the retitle landed");
const ids1 = allWidgets(spec1).map((w: any) => w.id).sort();
const ids2 = allWidgets(spec2).map((w: any) => w.id).sort();
assert.deepEqual(ids2, ids1, "an edit never churns untouched widget ids");
console.log("scenario: turn 2 patch edit + id stability ✅");

// ---- Turn 3: undo — deterministic, restores turn 1 exactly --------------------------
const t3 = await handleDashboardBuild(
  { datasets: orders, userPrompt: "undo", currentSpec: spec2, conversationId: CONV },
  { agentRun: editRun as any });
assert.equal(t3.status, 200, JSON.stringify(t3.body).slice(0, 300));
const spec3: DashboardSpec = t3.body.spec;
assert.deepEqual(diffSpecs(spec3, spec1), [], "undo restores turn 1's spec exactly (normalized diff empty)");
console.log("scenario: turn 3 undo restores the previous version ✅");

// ---- Replay: every captured turn reproduces itself offline --------------------------
{
  const turns = loadReplayTurns();
  assert.equal(turns.length, 2, `build + edit captured (undo is a stack op): got ${turns.length}`);
  assert.ok(turns[0].model.length >= 2, "turn 1 recorded its model calls in order");
  for (const rec of turns) {
    const r = await replayTurn(rec);
    assert.ok(r.ok, `replay(${rec.pipeline}) diffs: ${r.diffs.join(" | ")}`);
  }
  // Sanity on the differ itself: a semantic change IS caught after normalization.
  const mutated = JSON.parse(JSON.stringify(turns[0].spec));
  mutated.sections[0].widgets[0].title = "TAMPERED";
  assert.ok(diffSpecs(turns[0].spec, mutated).length > 0, "the differ catches semantic changes");
  assert.deepEqual(normalizeSpec(mutated), normalizeSpec(JSON.parse(JSON.stringify(mutated))), "normalization is stable");
}
console.log("scenario: capture → offline replay parity (the migration parity tool) ✅");

// ---- The negative-average-age acceptance case (executed) ----------------------------
{
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  // The exact upstream bug: reversed timestamp subtraction → negative ages.
  await conn.run(`CREATE TABLE tickets AS SELECT (created - resolved) AS age_hours FROM (
    SELECT 10.0 + i AS created, 40.0 + i AS resolved FROM range(0, 20) t(i))`);
  const exec = async (sql: string) => {
    const reader = await conn.runAndReadUntil(sql, 10_000);
    return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((row) => {
      for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
      return row;
    });
  };
  const flags = await flagDataAnomalies([
    { id: "k_age", title: "Avg Ticket Age", sql: `SELECT avg("age_hours") AS value FROM "tickets"`, format: "hours" },
    { id: "k_cnt", title: "Total Tickets", sql: `SELECT count(*) AS value FROM "tickets"`, format: "compact" },
  ], exec);
  assert.equal(flags.length, 1, "exactly the duration metric is flagged");
  assert.equal(flags[0].id, "k_age");
  assert.ok(flags[0].value < 0, "the executed value is negative");
  assert.ok(flags[0].reason.includes("reversed timestamp"), "the flag names the likely upstream cause");
  conn.disconnectSync();
  inst.closeSync();
}
console.log("scenario: negative-average-age anomaly probe (the plan's acceptance case) ✅");

console.log("scenario.test.ts: all assertions passed ✅");
