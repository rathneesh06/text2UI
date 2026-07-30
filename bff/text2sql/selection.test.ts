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
import { getSelection, setSelection, dropSelection, canUndo, undoSelection, _resetSelectionsForTest, FileSelectionStore, type SelectionBackend } from "../sources/selection-store";
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
  assert.deepEqual((await getSelection(CONV, TENANT)).tables, ["orders", "order_items", "payments"], "persisted server-side");
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
  const before = (await getSelection(CONV, TENANT)).tables;
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
  const before = (await getSelection(CONV, TENANT)).tables;
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
  const before = (await getSelection(CONV, TENANT)).tables;
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
  assert.deepEqual(r.body.selection, (await getSelection(CONV, TENANT)).tables);
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
  assert.deepEqual((await getSelection(CONV, TENANT)).columns.shipments, ["id", "status"], "persisted");

  // A checkbox change to the same table goes through the same state.
  const set = await handleSelectionSet(
    { connectionId: rec.id, conversationId: CONV, tables: r.body.selection, columns: { shipments: ["id"] } },
    TENANT,
    { chatStore: store },
  );
  assert.deepEqual(set.body.columns.shipments, ["id"], "clicking and chatting edit one projection");
}

// An extract that throws an Error with NO message must still tell the user
// something. This is the "Extraction failed:" bug: `??` let "" through.
{
  const empty = await handleSelectionCommit(
    { connectionId: rec.id, conversationId: CONV, tables: ["orders"] },
    TENANT,
    { chatStore: store },
  );
  // No DuckDB/MySQL here, so the extract genuinely fails — what matters is that
  // the message is non-empty, names the phase, and carries the elapsed time.
  assert.equal(empty.status, 500, JSON.stringify(empty.body));
  assert.ok(empty.body.error.trim().length > 20, `error too vague: "${empty.body.error}"`);
  assert.ok(Array.isArray(empty.body.phases) && empty.body.phases.length, "phases are reported");
  assert.equal(typeof empty.body.elapsedSeconds, "number");
}

// A handler that throws must never escape as an unparseable 500. This is the
// "Request failed (HTTP 500)" bug: the route had no guard, so Express replied
// with HTML and the client had nothing to show or log.
{
  const exploding = async () => { throw new Error("chat store unreachable"); };
  const r = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV, prompt: "select 1" },
    TENANT,
    { chatStore: { createConversation: exploding } as any },
  );
  assert.equal(r.status, 500);
  assert.ok(/chat store unreachable/.test(r.body.error), `message lost: "${r.body.error}"`);
  assert.equal(r.body.route, "/api/sql/select", "the failing route is named");

  // And a throw with NO message still says something actionable.
  const silent = async () => { throw new Error(""); };
  const r2 = await handleSelectionSet(
    { connectionId: rec.id, tables: ["orders"] },
    TENANT,
    { chatStore: { createConversation: silent } as any },
  );
  assert.equal(r2.status, 500);
  assert.ok(r2.body.error.length > 20, `too vague: "${r2.body.error}"`);
}

// An unreachable chat store must NOT break selecting. This is the real-world
// failure: PG_URL pointed at a container that wasn't running, pg's Pool
// constructs lazily so getChatStore()'s own fallback never fired, and the
// rejection landed inside the handler. Ticking a checkbox shouldn't need a
// chat database.
{
  const { describeError, resilientStore, _resetChatFallbackForTest } = await import("./selection-handler");
  // AggregateError has an empty message — the cause is in .code / .errors.
  // Shaped like what a failed pg Pool throws: empty message, cause in .errors.
  const agg: any = Object.assign(new Error(""), {
    name: "AggregateError",
    errors: [Object.assign(new Error(""), { code: "ECONNREFUSED", address: "localhost", port: 5433 })],
  });
  const described = describeError(agg);
  assert.ok(/ECONNREFUSED/.test(described), `cause lost: "${described}"`);
  assert.ok(/5433/.test(described), `address lost: "${described}"`);
  assert.ok(!/^AggregateError$/.test(described), "must say more than the class name");

  // A store that always rejects must not take the page down with it.
  _resetChatFallbackForTest();
  const dead: any = {
    createConversation: async () => { throw agg; },
    getHistory: async () => { throw agg; },
    appendMessage: async () => { throw agg; },
  };
  const survivor = resilientStore(dead);
  const cid = await survivor.createConversation("x", "conv_degraded");
  assert.equal(cid, "conv_degraded", "degrades to memory instead of throwing");
  await survivor.appendMessage("conv_degraded", { role: "user", content: "still recorded" });
  const hist = await survivor.getHistory("conv_degraded", 10);
  assert.equal(hist[0]?.content, "still recorded", "the session transcript survives in memory");
  _resetChatFallbackForTest();
}

// REGRESSION: deselect one column of a table, then re-select it.
// Reported from the browser: unticking `id` on an 8-column table left "7 of 8
// columns stored", and the checkbox could never be turned back on. Two stacked
// defects — setSelection MERGED the incoming projection over the old one (so
// omitting a table could not widen it), and the handler's change-detection only
// looked at incoming keys (so `columns: {}` read as "no change" and never even
// reached the store).
{
  const CONV_C = "conv_colwiden";
  const ALL = ["id", "ci_item_name", "ci_module_id", "ci_status", "ci_created_by", "ci_created_on", "ci_updated_by", "ci_updated_on"];
  const narrowed = ALL.filter((c) => c !== "id"); // 7 of 8 — untick `id`

  const step1 = await handleSelectionSet(
    { connectionId: rec.id, conversationId: CONV_C, tables: ["orders"], columns: { orders: narrowed } },
    TENANT,
    { chatStore: store },
  );
  assert.deepEqual(step1.body.columns.orders, narrowed, "narrowing to 7 of 8 sticks");

  // Re-tick `id`: the client is back to every column, which it signals by
  // OMITTING the table from the map entirely.
  const step2 = await handleSelectionSet(
    { connectionId: rec.id, conversationId: CONV_C, tables: ["orders"], columns: {} },
    TENANT,
    { chatStore: store },
  );
  assert.deepEqual(step2.body.columns, {}, "widening back to all columns must clear the projection");
  assert.deepEqual((await getSelection(CONV_C, TENANT)).columns, {}, "…and must be persisted, not just echoed");

  // Partial widening still narrows: drop two, put one back -> 7 remain.
  const two = ALL.filter((c) => c !== "id" && c !== "ci_status");
  await handleSelectionSet(
    { connectionId: rec.id, conversationId: CONV_C, tables: ["orders"], columns: { orders: two } },
    TENANT, { chatStore: store },
  );
  const step4 = await handleSelectionSet(
    { connectionId: rec.id, conversationId: CONV_C, tables: ["orders"], columns: { orders: narrowed } },
    TENANT, { chatStore: store },
  );
  assert.deepEqual(step4.body.columns.orders, narrowed, "a smaller projection can be replaced by a larger one");

  // Omitting `columns` altogether must NOT wipe a projection — that's what a
  // plain table tick sends.
  const step5 = await handleSelectionSet(
    { connectionId: rec.id, conversationId: CONV_C, tables: ["orders", "customers"] },
    TENANT, { chatStore: store },
  );
  assert.deepEqual(step5.body.columns.orders, narrowed, "a table tick leaves column choices alone");
}

// ---- the analyst pass: answering questions about the DATA ----------------------------
{
  const ask = (sql: string) => async () => ({ text: JSON.stringify({ reply: "Let me check.", ops: [], sql }), finishReason: "STOP" } as any);
  const compose = async () => ({ text: "There are 8,423 system IPs across 190 customers.", finishReason: "STOP" } as any);

  // Happy path: SQL is guarded, executed, and the rows become a sentence.
  let ranSql = "";
  const exec: any = async (_conn: unknown, sql: string) => {
    ranSql = sql;
    return { columns: ["n"], rows: [{ n: 8423 }], truncated: false, elapsedMs: 12 };
  };
  const r = await handleSelectionChat(
    { connectionId: rec.id, conversationId: "conv_analyst", prompt: "how many system IPs are there?" },
    TENANT,
    { chatStore: store, plan: ask("SELECT count(*) AS n FROM orders"), runQuery: exec, answer: compose },
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(/8,423/.test(r.body.reply), `answer not surfaced: "${r.body.reply}"`);
  assert.ok(/LIMIT/i.test(ranSql), "the guard's row cap is applied before execution");

  // A write attempt must never reach the database.
  let touched = false;
  const blocked = await handleSelectionChat(
    { connectionId: rec.id, conversationId: "conv_analyst", prompt: "delete the old rows" },
    TENANT,
    {
      chatStore: store,
      plan: ask("DELETE FROM orders WHERE id > 0"),
      runQuery: (async () => { touched = true; throw new Error("should never run"); }) as any,
      answer: compose,
    },
  );
  assert.equal(touched, false, "a non-SELECT must be rejected before execution");
  assert.ok(/couldn't run that safely/i.test(blocked.body.reply), blocked.body.reply);

  // A failed query explains itself instead of vanishing.
  const failed = await handleSelectionChat(
    { connectionId: rec.id, conversationId: "conv_analyst", prompt: "count the widgets" },
    TENANT,
    {
      chatStore: store,
      plan: ask("SELECT count(*) FROM orders"),
      runQuery: (async () => { throw Object.assign(new Error('column "widget" does not exist'), { code: "42703" }); }) as any,
      answer: compose,
    },
  );
  assert.ok(/query failed/i.test(failed.body.reply), failed.body.reply);
  assert.ok(/does not exist/.test(failed.body.reply), "the database's own explanation reaches the user");

  // Analysis and selection in one turn: both must land.
  const both = await handleSelectionChat(
    { connectionId: rec.id, conversationId: "conv_analyst_2", prompt: "add customers and tell me the count" },
    TENANT,
    {
      chatStore: store,
      plan: async () => ({ text: JSON.stringify({ reply: "ok", ops: [{ op: "add", refs: ["customers"] }], sql: "SELECT count(*) AS n FROM customers" }), finishReason: "STOP" } as any),
      runQuery: exec,
      answer: compose,
    },
  );
  assert.ok(both.body.selection.includes("customers"), "the selection op still applies");
  assert.ok(/8,423/.test(both.body.reply) && /Added/.test(both.body.reply), `both halves missing: "${both.body.reply}"`);

  // If the composer is down, the rows are still shown rather than swallowed.
  const rawRows = await handleSelectionChat(
    { connectionId: rec.id, conversationId: "conv_analyst_3", prompt: "top customers" },
    TENANT,
    {
      chatStore: store,
      plan: ask("SELECT region, count(*) AS n FROM orders GROUP BY region"),
      runQuery: (async () => ({ columns: ["region", "n"], rows: [{ region: "APAC", n: 5 }], truncated: false, elapsedMs: 3 })) as any,
      answer: (async () => { throw new Error("model down"); }) as any,
    },
  );
  assert.ok(/APAC/.test(rawRows.body.reply), `fallback lost the rows: "${rawRows.body.reply}"`);
}

// ---- the pluggable selection backend ---------------------------------------------
// Selections now go to Postgres when STORAGE=postgres (so two BFF instances see
// each other's writes) and to a local file otherwise. What matters is that a
// backend outage degrades instead of breaking the page — the same lesson as the
// chat store, on a different table.
{
  // A backend that records what it was asked to do.
  const calls: string[] = [];
  const mem = new Map<string, any>();
  const fake: SelectionBackend = {
    async load(c, t) { calls.push(`load:${c}`); const s = mem.get(c); return s && s.tenantId === t ? s : null; },
    async save(st) { calls.push(`save:${st.conversationId}`); mem.set(st.conversationId, st); },
    async remove(c) { calls.push(`remove:${c}`); return mem.delete(c); },
  };
  _resetSelectionsForTest(fake);

  const CONV_B = "conv_backend";
  await setSelection(CONV_B, TENANT, ["orders", "customers"], { connectionId: "c1", columns: { orders: ["id"] } });
  assert.deepEqual((await getSelection(CONV_B, TENANT)).tables, ["orders", "customers"], "round-trips through the backend");
  assert.deepEqual((await getSelection(CONV_B, TENANT)).columns, { orders: ["id"] });
  assert.ok(calls.some((c) => c.startsWith("save:")), "the backend was actually written to");

  // Tenancy is enforced on read, not assumed.
  assert.deepEqual((await getSelection(CONV_B, "other-tenant")).tables, [], "another tenant sees nothing");

  // Undo is in-memory and stays synchronous. Nothing to undo until there IS a
  // previous value — the first selection on a fresh conversation has no history.
  assert.equal(canUndo(CONV_B), false, "no history before the first change");
  await setSelection(CONV_B, TENANT, ["orders"], {});
  assert.equal(canUndo(CONV_B), true, "the second change is undoable");
  const undone = await undoSelection(CONV_B, TENANT);
  assert.deepEqual(undone?.tables, ["orders", "customers"], "undo restores the previous set through the backend");

  assert.equal(await dropSelection(CONV_B, TENANT), true);
  assert.deepEqual((await getSelection(CONV_B, TENANT)).tables, [], "dropped");

  // ---- the degrade path: a failing backend must not break selecting ----
  const dead: SelectionBackend = {
    async load() { throw Object.assign(new Error(""), { code: "ECONNREFUSED", address: "10.222.0.155", port: 5432 }); },
    async save() { throw new Error("pg gone"); },
    async remove() { throw new Error("pg gone"); },
  };
  _resetSelectionsForTest(dead);
  const CONV_D = "conv_degrade";
  // Must not throw — it falls through to the local file store.
  const saved = await setSelection(CONV_D, TENANT, ["orders"], { connectionId: "c2" });
  assert.deepEqual(saved.tables, ["orders"], "a dead backend degrades instead of throwing");
  assert.deepEqual((await getSelection(CONV_D, TENANT)).tables, ["orders"], "and the selection is still readable");

  // The file backend on its own still satisfies the same contract.
  _resetSelectionsForTest(new FileSelectionStore());
  await setSelection("conv_file", TENANT, ["payments"], {});
  assert.deepEqual((await getSelection("conv_file", TENANT)).tables, ["payments"], "file backend round-trips");

  _resetSelectionsForTest();
}

console.log("selection.test.ts: all assertions passed ✅");
