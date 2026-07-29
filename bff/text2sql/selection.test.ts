// bff/text2sql/selection.test.ts — run with: npm run test:selection
//
// The selection chat is MODEL-driven: every turn is planned by the model. These
// tests inject a fake planner, so what they actually pin down is the contract
// around the model — that its ops are applied faithfully, that names it invents
// are rejected, that the conversation and the checkboxes stay in sync, and that
// an outage degrades honestly instead of half-obeying.
import assert from "node:assert";
// HERMETIC: the selection store writes next to the workbench manifest, so point
// WB_DIR at a throwaway directory BEFORE anything imports it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const TEST_WB_DIR = mkdtempSync(join(tmpdir(), "t2ui-seltest-"));
process.env.WB_DIR = TEST_WB_DIR;
process.on("exit", () => { try { rmSync(TEST_WB_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

import { InMemoryChatStore } from "../chat-store";
import { registerConnection, type ConnRecord } from "../sources/connection-registry";
import { getSelection } from "../sources/selection-store";
import { applyOps, correctionNote, offlineFallback, planSelectionTurn, resolveRef, resolveRefs } from "./selection";
import { handleSelectionChat, handleSelectionGet, handleSelectionSet, handleSelectionCommit } from "./selection-handler";

const CATALOG = [
  "orders", "order_items", "customers", "payments", "products",
  "sales.regions", "audit_log", "audit_events", "sessions", "shipments",
];

// ---- resolution: the layer that keeps the model honest ----------------------------
{
  assert.deepEqual(resolveRef("1", CATALOG).matches, ["orders"], "1-based index");
  assert.deepEqual(resolveRef("#3", CATALOG).matches, ["customers"], "# prefix tolerated");
  assert.deepEqual(resolveRef("99", CATALOG).matches, [], "out-of-range index resolves to nothing");
  assert.deepEqual(resolveRef("2-4", CATALOG).matches, ["order_items", "customers", "payments"], "range");
  assert.deepEqual(resolveRef("4 to 2", CATALOG).matches, ["order_items", "customers", "payments"], "reversed range normalizes");
  assert.deepEqual(resolveRef("Order Items", CATALOG).matches, ["order_items"], "punctuation + case insensitive");
  assert.deepEqual(resolveRef("regions", CATALOG).matches, ["sales.regions"], "schema-qualified name found by its bare name");
  assert.deepEqual(resolveRef("customer", CATALOG).matches, ["customers"], "singular finds plural");
  assert.deepEqual(resolveRef("audit_*", CATALOG).matches, ["audit_log", "audit_events"], "glob");
  assert.deepEqual(resolveRef("nope_at_all", CATALOG).matches, [], "unknown name");

  // A partial name fitting several tables is a question, never a silent guess.
  const amb = resolveRef("audit", CATALOG);
  assert.deepEqual(amb.matches, []);
  assert.deepEqual(amb.ambiguous, ["audit_log", "audit_events"]);

  const r = resolveRefs(["3", "orders", "ghost"], CATALOG);
  assert.deepEqual(r.tables, ["orders", "customers"], "catalog order, deduped");
  assert.deepEqual(r.unresolved, ["ghost"]);
}

// ---- applying the model's ops -------------------------------------------------------
{
  const a = applyOps([], [{ op: "add", refs: ["1", "2"] }], CATALOG);
  assert.deepEqual(a.selection, ["orders", "order_items"]);
  assert.deepEqual(a.added, ["orders", "order_items"]);

  const b = applyOps(a.selection, [{ op: "remove", refs: ["orders"] }], CATALOG);
  assert.deepEqual(b.selection, ["order_items"]);
  assert.deepEqual(b.removed, ["orders"]);

  const c = applyOps(["payments"], [{ op: "replace", refs: ["orders", "customers"] }], CATALOG);
  assert.deepEqual(c.selection, ["orders", "customers"]);
  assert.deepEqual(c.removed, ["payments"]);

  const d = applyOps(["orders"], [{ op: "all" }, { op: "remove", refs: ["audit_*"] }], CATALOG);
  assert.equal(d.selection.length, CATALOG.length - 2, "compound ops fold in order");
  assert.ok(!d.selection.includes("audit_log"));

  // Selection order always follows the catalog, whatever order the model used.
  const e = applyOps([], [{ op: "add", refs: ["customers", "orders"] }], CATALOG);
  assert.deepEqual(e.selection, ["orders", "customers"]);

  // Ambiguity surfaces as a correction instead of mutating.
  const f = applyOps([], [{ op: "add", refs: ["audit"] }], CATALOG);
  assert.deepEqual(f.selection, []);
  assert.ok(correctionNote(f).includes("which did you want?"));
  assert.equal(correctionNote(applyOps([], [{ op: "add", refs: ["orders"] }], CATALOG)), "", "clean turns add no noise");
}

// ---- column narrowing --------------------------------------------------------------
{
  // A "columns" op narrows one table and implies selecting it.
  const a = applyOps([], [{ op: "columns", table: "orders", refs: ["id", "total"] }], CATALOG);
  assert.deepEqual(a.selection, ["orders"], "narrowing a table selects it");
  assert.deepEqual(a.columns, { orders: ["id", "total"] });

  // Existing narrowing carries forward across turns.
  const b = applyOps(["orders"], [{ op: "add", refs: ["customers"] }], CATALOG, { orders: ["id"] });
  assert.deepEqual(b.columns, { orders: ["id"] }, "a later turn doesn't lose the projection");

  // Deselecting a table forgets how it was narrowed.
  const c = applyOps(["orders", "customers"], [{ op: "remove", refs: ["orders"] }], CATALOG, { orders: ["id"] });
  assert.deepEqual(c.columns, {}, "projection dies with its table");

  // A columns op naming an unknown table is dropped, not applied to something else.
  const d = applyOps(["orders"], [{ op: "columns", table: "ghost_table", refs: ["x"] }], CATALOG, {});
  assert.deepEqual(d.columns, {});
  assert.deepEqual(d.selection, ["orders"]);
}

// ---- the planner's own guards ----------------------------------------------------------
{
  const run = (obj: unknown) => async () => ({ text: JSON.stringify(obj), finishReason: "STOP" } as any);
  const input = { prompt: "x", catalog: CATALOG.map((name) => ({ name })), selection: [] as string[] };

  const ok = await planSelectionTurn(input, run({ reply: "Added orders.", ops: [{ op: "add", refs: ["orders"] }] }));
  assert.deepEqual(ok?.ops, [{ op: "add", refs: ["orders"] }]);
  assert.equal(ok?.reply, "Added orders.");

  // A malformed "replace" with no refs would wipe the selection — drop it.
  const stripped = await planSelectionTurn(input, run({ reply: "hm", ops: [{ op: "replace" }, { op: "nonsense", refs: ["orders"] }] }));
  assert.deepEqual(stripped?.ops, [], "refs-less replace and unknown ops are dropped");
  assert.equal(stripped?.reply, "hm", "the reply still reaches the user");

  // Reply-only turns are legitimate (questions, clarifications).
  const chat = await planSelectionTurn(input, run({ reply: "orders has an email column.", ops: [] }));
  assert.equal(chat?.ops.length, 0);

  // Silence and garbage are outages, not answers.
  assert.equal(await planSelectionTurn(input, run({ reply: "", ops: [] })), null);
  assert.equal(await planSelectionTurn(input, async () => ({ text: "not json", finishReason: "STOP" } as any)), null);
  assert.equal(await planSelectionTurn(input, async () => { throw new Error("503"); }), null);
  assert.equal(await planSelectionTurn(input, () => new Promise(() => {}), 40), null, "a hung model times out");
}

// ---- the outage path is deliberately narrow ------------------------------------------
{
  assert.deepEqual(offlineFallback("1, 4, 9", CATALOG), [{ op: "add", refs: ["1", "4", "9"] }], "bare numbers still work");
  assert.deepEqual(offlineFallback("orders", CATALOG), [{ op: "add", refs: ["orders"] }], "an exact name still works");
  assert.equal(offlineFallback("remove everything except orders", CATALOG), null, "anything with intent is declined");
  assert.equal(offlineFallback("the ones about payments", CATALOG), null);
  assert.equal(offlineFallback("42", CATALOG), null, "an out-of-range number is not silently ignored");
}

// ---- the handler loop -------------------------------------------------------------------
const TENANT = "public";
const rec: ConnRecord = {
  id: "conn_seltest",
  tenantId: TENANT,
  conn: { dialect: "postgres", host: "localhost", port: 5432, user: "u", password: "p", database: "shop" },
  label: "u@localhost:5432/shop",
  createdAt: Date.now(),
  lastUsed: Date.now(),
  allTables: CATALOG.map((name) => ({ name, schema: "public", table: name, ref: `src."public"."${name}"`, approxRows: 100 })),
  datasets: [{
    tableName: "orders",
    profile: {
      source: { filename: "postgres:public.orders", format: "json" },
      rowCount: 100,
      columns: [{ name: "id", type: "number" }, { name: "region", type: "string" }] as any,
      sampleRows: [],
    },
  } as any],
  warnings: [],
  status: "active",
  consecutiveFailures: 0,
};
registerConnection(rec);

const store = new InMemoryChatStore();
const CONV = "conv_seltest";
const plan = (obj: unknown) => async () => ({ text: JSON.stringify(obj), finishReason: "STOP" } as any);

// The model's ops are applied and the selection is persisted server-side.
{
  const r = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV, prompt: "select tables 1, 2 and 4" },
    TENANT,
    { chatStore: store, plan: plan({ reply: "Added orders, order_items and payments.", ops: [{ op: "add", refs: ["1", "2", "4"] }] }) },
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.selection, ["orders", "order_items", "payments"]);
  assert.equal(r.body.reply, "Added orders, order_items and payments.", "the model's words are the reply");
  assert.equal(r.body.source, "model");
  assert.deepEqual(getSelection(CONV, TENANT).tables, ["orders", "order_items", "payments"], "persisted server-side");
}

// The model is given the live selection and the history to reason over.
{
  let sawSelection = "";
  let sawHistory = false;
  const spy = async (_s: string, user: string) => {
    sawSelection = (user.match(/Currently selected \(\d+\): (.*)/) ?? [])[1] ?? "";
    sawHistory = user.includes("Conversation so far:");
    return { text: JSON.stringify({ reply: "Added customers.", ops: [{ op: "add", refs: ["customers"] }] }), finishReason: "STOP" } as any;
  };
  const r = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV, prompt: "also the customer one" },
    TENANT,
    { chatStore: store, plan: spy },
  );
  assert.equal(sawSelection, "orders, order_items, payments", "the model sees what's already selected");
  assert.ok(sawHistory, "the model sees the conversation so far");
  assert.deepEqual(r.body.selection, ["orders", "order_items", "customers", "payments"], "catalog order preserved");
  assert.deepEqual(r.body.added, ["customers"]);
}

// A table the model invented is reported, not selected — and the correction is
// appended to its reply rather than replacing it.
{
  const r = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV, prompt: "add whatever covers money movement" },
    TENANT,
    { chatStore: store, plan: plan({ reply: "Pulled in the payment tables.", ops: [{ op: "add", refs: ["payments", "payment_ledger"] }] }) },
  );
  assert.ok(!r.body.selection.includes("payment_ledger"), "hallucinated names never enter the selection");
  assert.deepEqual(r.body.unresolved, ["payment_ledger"]);
  assert.ok(r.body.reply.startsWith("Pulled in the payment tables."), "the model still speaks first");
  assert.ok(/couldn't find payment_ledger/i.test(r.body.reply), "…but the user is told what didn't exist");
}

// Clicking a checkbox edits the same selection AND lands in the transcript, so
// the next typed turn can refer to it.
{
  const r = await handleSelectionSet(
    { connectionId: rec.id, conversationId: CONV, tables: ["orders", "customers", "shipments"] },
    TENANT,
    { chatStore: store },
  );
  assert.deepEqual(r.body.selection, ["orders", "customers", "shipments"]);
  assert.deepEqual(r.body.removed, ["order_items", "payments"]);
  const history = await store.getHistory(CONV, 50);
  assert.ok(history.some((m) => m.content.includes("clicked in the table list")), "click recorded as memory");
}

// Undo rewinds one step, and the model's phrasing is kept when it sent any.
{
  const r = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV, prompt: "no wait, go back" },
    TENANT,
    { chatStore: store, plan: plan({ reply: "Reverted.", ops: [{ op: "undo" }] }) },
  );
  assert.deepEqual(r.body.selection, ["orders", "order_items", "customers", "payments"], "back to the pre-click set");
  assert.equal(r.body.reply, "Reverted.");
}

// A question changes nothing and still gets answered.
{
  const before = getSelection(CONV, TENANT).tables;
  const r = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV, prompt: "which of these has a region column?" },
    TENANT,
    { chatStore: store, plan: plan({ reply: "orders has region.", ops: [] }) },
  );
  assert.equal(r.body.reply, "orders has region.");
  assert.deepEqual(r.body.selection, before, "a question is not a mutation");
}

// "focus" opens a table's columns without touching the selection.
{
  const before = getSelection(CONV, TENANT).tables;
  const r = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV, prompt: "what's in shipments?" },
    TENANT,
    { chatStore: store, plan: plan({ reply: "Opening shipments.", ops: [{ op: "focus", refs: ["shipments"] }] }) },
  );
  assert.equal(r.body.focus, "shipments");
  assert.deepEqual(r.body.selection, before);
}

// Model outage: bare numbers still land, anything else degrades honestly.
{
  const before = getSelection(CONV, TENANT).tables;
  const dead = async () => { throw new Error("model down"); };

  const r = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV, prompt: "drop everything except orders" },
    TENANT,
    { chatStore: store, plan: dead },
  );
  assert.equal(r.body.understood, false);
  assert.ok(/can't reach the model/i.test(r.body.reply), r.body.reply);
  assert.deepEqual(r.body.selection, before, "an outage never mutates the selection");

  const r2 = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV, prompt: "10" },
    TENANT,
    { chatStore: store, plan: dead },
  );
  assert.equal(r2.body.source, "offline");
  assert.ok(r2.body.selection.includes("shipments"), "a bare number still works offline");
}

// Rehydration after a reload returns the selection AND the transcript.
{
  const r = await handleSelectionGet(CONV, TENANT, { chatStore: store });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.selection, getSelection(CONV, TENANT).tables);
  assert.ok(r.body.turns.length > 6, "conversation memory survives");
  assert.equal(r.body.connectionLabel, rec.label);
}

// Tenancy + the empty-selection guard on the handoff.
{
  const foreign = await handleSelectionChat({ connectionId: rec.id, prompt: "select 1" }, "other-tenant", { chatStore: store });
  assert.equal(foreign.status, 404, "connections are tenant-scoped");

  const empty = await handleSelectionCommit(
    { connectionId: rec.id, conversationId: "conv_empty_seltest" },
    TENANT,
    { chatStore: store },
  );
  assert.equal(empty.status, 400);
  assert.ok(/nothing selected/i.test(empty.body.error), empty.body.error);
}

// The model can narrow columns, and the narrowing is persisted server-side.
{
  const r = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV, prompt: "from shipments keep only the id and status" },
    TENANT,
    { chatStore: store, plan: plan({ reply: "Narrowed shipments to id and status.", ops: [{ op: "columns", table: "shipments", refs: ["id", "status"] }] }) },
  );
  assert.deepEqual(r.body.columns.shipments, ["id", "status"]);
  assert.ok(r.body.selection.includes("shipments"));
  assert.deepEqual(getSelection(CONV, TENANT).columns.shipments, ["id", "status"], "persisted");

  // A checkbox change to the same table goes through the same state.
  const set = await handleSelectionSet(
    { connectionId: rec.id, conversationId: CONV, tables: r.body.selection, columns: { shipments: ["id"] } },
    TENANT,
    { chatStore: store },
  );
  assert.deepEqual(set.body.columns.shipments, ["id"], "clicking and chatting edit one projection");
}

console.log("selection.test.ts: all assertions passed ✅");
