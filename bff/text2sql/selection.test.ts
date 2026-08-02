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




// Clicking a checkbox edits the same selection AND lands in the transcript, so
// the next typed turn can refer to it.
// Seeded explicitly: selection used to arrive via a chat turn, but as of Stage 3
// the chat captures dependencies and never touches the selection.
{
  await handleSelectionSet(
    { connectionId: rec.id, conversationId: CONV, tables: ["orders", "order_items", "payments"] },
    TENANT,
    { chatStore: store },
  );
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





// Rehydration after a reload returns the selection AND the transcript.
{
  const r = await handleSelectionGet(CONV, TENANT, { chatStore: store });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.selection, (await getSelection(CONV, TENANT)).tables);
  // Was >6 when the chat drove selection and every turn added two messages. As of
  // Stage 3 the transcript here is the two checkbox edits above.
  assert.ok(r.body.turns.length >= 2, "conversation memory survives");
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

// ---- STAGE 3: the chat captures DEPENDENCIES, it no longer selects tables --------
// The contract under test is the one that matters most for this feature: whatever
// the user says, something is captured. A statement that cannot be structured into
// a join must survive as `semantic` rather than being silently dropped.
{
  const dep = (obj: unknown) => async () => ({ text: JSON.stringify(obj), finishReason: "STOP" } as any);
  const CONV_D = "conv_deps";
  const MEM = "solo_conn_seltest"; // single connection -> one synthetic member

  // A join both ends of which exist in the profiled catalog (orders.id / orders.region).
  const joined = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV_D, prompt: "orders.id points at customers.id" },
    TENANT,
    {
      chatStore: store,
      plan: dep({
        reply: "Captured: orders.id -> customers.id.",
        dependencies: [{
          kind: "join",
          from: { member: MEM, table: "orders", column: "id" },
          to: { member: MEM, table: "orders", column: "region" },
          cardinality: "N:1",
          statement: "orders.id points at customers.id",
        }],
      }),
    },
  );
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.dependencies.length, 1, "the join was captured");
  assert.equal(joined.body.dependencies[0].kind, "join");
  assert.equal(joined.body.dependencies[0].confidence, "validated", "columns exist -> validated");
  assert.deepEqual(joined.body.selection, [], "the chat no longer changes the selection");

  // Unstructurable input MUST be kept verbatim as semantic, never discarded.
  const semantic = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV_D, prompt: "all amounts are in GBP" },
    TENANT,
    {
      chatStore: store,
      plan: dep({
        reply: "Noted.",
        dependencies: [{ kind: "semantic", scope: [], statement: "all amounts are in GBP" }],
      }),
    },
  );
  const sem = semantic.body.dependencies.find((d: any) => d.kind === "semantic");
  assert.ok(sem, "a statement with no join form is still captured");
  assert.equal(sem.statement, "all amounts are in GBP", "kept VERBATIM");
  assert.equal(semantic.body.dependencies.length, 2, "and it did not replace the join");

  // A column that does not exist is REJECTED but KEPT — feedback, not garbage —
  // and the turn still succeeds.
  const wrong = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV_D, prompt: "orders.nonexistent links to customers.id" },
    TENANT,
    {
      chatStore: store,
      plan: dep({
        reply: "I could not find that column.",
        dependencies: [{
          kind: "join",
          from: { member: MEM, table: "orders", column: "nonexistent" },
          to: { member: MEM, table: "orders", column: "region" },
          cardinality: "N:1",
          statement: "orders.nonexistent links to customers.id",
        }],
      }),
    },
  );
  assert.equal(wrong.status, 200, "a bad dependency must NOT fail the turn");
  const bad = wrong.body.dependencies.find((d: any) => d.confidence === "rejected");
  assert.ok(bad, "kept and marked rejected rather than dropped");
  assert.match(bad.note ?? "", /nonexistent/i, "the note names what was not found");

  // Restating the same pair UPDATES rather than duplicating (ids are content-derived).
  const before = wrong.body.dependencies.length;
  const restated = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV_D, prompt: "actually orders.id to orders.region is one-to-one" },
    TENANT,
    {
      chatStore: store,
      plan: dep({
        reply: "Updated.",
        dependencies: [{
          kind: "join",
          from: { member: MEM, table: "orders", column: "id" },
          to: { member: MEM, table: "orders", column: "region" },
          cardinality: "1:1",
          statement: "actually orders.id to orders.region is one-to-one",
        }],
      }),
    },
  );
  assert.equal(restated.body.dependencies.length, before, "restating updates in place");
  const j = restated.body.dependencies.find((d: any) => d.kind === "join" && d.confidence !== "rejected");
  assert.equal(j.cardinality, "1:1", "the correction won");

  // Deletion by id.
  const removed = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV_D, prompt: "forget that link" },
    TENANT,
    { chatStore: store, plan: dep({ reply: "Removed.", dependencies: [], removeIds: [j.id] }) },
  );
  assert.ok(!removed.body.dependencies.some((d: any) => d.id === j.id), "deleted");

  // Durable across turns: the semantic one is still there at the end.
  assert.ok(
    removed.body.dependencies.some((d: any) => d.statement === "all amounts are in GBP"),
    "dependencies persist for the whole conversation",
  );

  // A dead model must not lose what the user said.
  const offline = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV_D, prompt: "shipments belong to orders somehow" },
    TENANT,
    { chatStore: store, plan: (async () => { throw new Error("model down"); }) as any },
  );
  assert.equal(offline.status, 200, "an outage must not fail the turn");
  assert.ok(
    offline.body.dependencies.some((d: any) => d.statement === "shipments belong to orders somehow"),
    "the statement is saved verbatim even with no model",
  );
}

// ---- TASK 2: context builds up ACROSS turns, and several per SINGLE turn ---------
// Two different things get called "multi": a user stating one relationship per
// message over five messages, and a user stating three in one message. Both must
// work, and they exercise different code (the merge into the stored set vs. the
// per-turn array).
{
  const dep = (obj: unknown) => async () => ({ text: JSON.stringify(obj), finishReason: "STOP" } as any);
  const MEM = "solo_conn_seltest";
  const j = (col: string, statement: string) => ({
    kind: "join",
    from: { member: MEM, table: "orders", column: col },
    to: { member: MEM, table: "orders", column: "region" },
    cardinality: "N:1",
    statement,
  });

  // (a) FIVE separate messages, one dependency each, accumulate to five.
  const CONV_M = "conv_multiturn";
  const cols = ["id", "region"];
  let last: any;
  for (let i = 0; i < cols.length; i++) {
    last = await handleSelectionChat(
      { connectionId: rec.id, conversationId: CONV_M, prompt: `turn ${i}` },
      TENANT,
      { chatStore: store, plan: dep({ reply: "ok", dependencies: [j(cols[i], `statement ${i}`)] }) },
    );
  }
  // Two distinct joins from two messages, both still present.
  assert.equal(last.body.dependencies.length, 2, "each turn MERGES into the stored set rather than replacing it");
  assert.ok(last.body.dependencies.every((d: any) => d.kind === "join"));

  // A semantic statement in a later message joins them rather than evicting them.
  const after = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV_M, prompt: "and everything is UTC" },
    TENANT,
    { chatStore: store, plan: dep({ reply: "ok", dependencies: [{ kind: "semantic", scope: [], statement: "everything is UTC" }] }) },
  );
  assert.equal(after.body.dependencies.length, 3, "context accumulates across turns");

  // And it is DURABLE, not just echoed back in the response.
  const stored = await getSelection(CONV_M, TENANT);
  assert.equal(stored.dependencies.length, 3, "persisted, so a reload keeps the accumulated context");

  // The model is given what has been captured so far, or it cannot correct itself.
  let sawCaptured = false;
  await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV_M, prompt: "what have you got?" },
    TENANT,
    {
      chatStore: store,
      plan: (async (_s: string, user: string) => {
        sawCaptured = user.includes("Captured so far:") && user.includes("everything is UTC");
        return { text: JSON.stringify({ reply: "Three so far.", dependencies: [] }), finishReason: "STOP" } as any;
      }) as any,
    },
  );
  assert.ok(sawCaptured, "the prompt carries the captured list, so state questions and corrections work");

  // (b) ONE message containing THREE dependencies -> three entries, validated
  // independently: a good join, a bad join, and a semantic statement.
  const CONV_S = "conv_multisingle";
  const three = await handleSelectionChat(
    { connectionId: rec.id, conversationId: CONV_S, prompt: "orders.id joins region, orders.nope joins region, and all amounts are GBP" },
    TENANT,
    {
      chatStore: store,
      plan: dep({
        reply: "Captured three.",
        dependencies: [
          j("id", "orders.id joins region"),
          j("nope", "orders.nope joins region"),
          { kind: "semantic", scope: [], statement: "all amounts are GBP" },
        ],
      }),
    },
  );
  assert.equal(three.body.dependencies.length, 3, "three in one message yields three entries");
  const byStatement = (s: string) => three.body.dependencies.find((d: any) => d.statement === s);
  assert.equal(byStatement("orders.id joins region").confidence, "validated", "the good join validates");
  assert.equal(byStatement("orders.nope joins region").confidence, "rejected", "the bad one is rejected INDEPENDENTLY");
  assert.match(byStatement("orders.nope joins region").note ?? "", /nope/i, "and says which column was missing");
  assert.equal(byStatement("all amounts are GBP").kind, "semantic", "the unstructurable one is kept as semantic");
  // The bad one must not have poisoned the others.
  assert.equal(three.body.dependencies.filter((d: any) => d.confidence === "rejected").length, 1, "one bad entry does not reject the rest");
}

console.log("selection.test.ts: all assertions passed ✅");
