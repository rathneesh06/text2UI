// bff/text2sql/selection-handler.ts — the routes behind the table-selection page.
//
//   POST /api/sql/select              handleSelectionChat    one conversational turn
//   GET  /api/sql/selection/:convId   handleSelectionGet     rehydrate after a reload
//   POST /api/sql/selection           handleSelectionSet     the rail's checkboxes
//   POST /api/sql/selection/commit    handleSelectionCommit  → a text2UI source
//   POST /api/sql/:connectionId/profile  handleTableProfile  columns on demand
//
// The point of the page: a 400-table production database makes text2SQL guess.
// Narrowing to the six tables the user actually cares about — by clicking OR by
// typing — makes every downstream stage (planner, dashboard build, deck) work
// against a small, deliberate catalog.
//
// Memory: every turn (typed or clicked) is appended to the same ChatStore the
// rest of the app uses, with the resulting selection recorded in briefJson. So
// "put back the two you dropped" has something real to read, and the transcript
// survives a page reload.
//
// Every typed turn is planned by the MODEL (see selection.ts). The only thing
// the server decides for itself is whether the names the model emitted exist —
// resolution and the correction note, never the intent.
import { getChatStore, InMemoryChatStore, type ChatStore } from "../chat-store";
import { describeError } from "../sources/describe-error";
import { getConnection } from "../sources/connection-registry";
import { nativeTableDetail, nativeQuery } from "../sources/native-catalog";
import { guardSelect } from "./guard";
import {
  getSelection, setSelection, undoSelection, canUndo, dropSelection,
} from "../sources/selection-store";
import { finalizeStaged, projectStagedColumns } from "../sources/workbench-store";
import { stageSnapshot } from "./handler";
import {
  answerFromRows, applyOps, correctionNote, describeRows, offlineFallback,
  planSelectionTurn, summarizeApply, type PlanSelectionRun, type SelOp,
} from "./selection";
import type { Dataset } from "../../shared/types";

type Out = { status: number; body: any };
const bad = (error: string): Out => ({ status: 400, body: { error } });

/**
 * Every selection route runs inside this.
 *
 * Without it, anything that throws — a chat-store connection, a bad env path, a
 * driver error — reaches Express's default handler, which replies with an HTML
 * body. The client can't parse that, so the user sees a bare
 * "Request failed (HTTP 500)" and the server log says nothing. That is a dead
 * end for whoever has to debug it, which turned out to be me.
 *
 * Now: the stack goes to the server log with the route that produced it, and the
 * user gets a JSON message they can quote back.
 */
// Re-exported so existing importers (server.ts's global error handler) keep
// working; the implementation moved once it gained a second consumer.
export { describeError } from "../sources/describe-error";

/** The chat store is MEMORY — valuable, but not the point of this page. When it
 *  is unreachable (Postgres down, container not up), ticking a checkbox must
 *  still work. `getChatStore()` can't protect us: pg's Pool constructs lazily,
 *  so its own try/catch fallback never fires and the failure lands on the first
 *  awaited query, deep inside a handler.
 *
 *  So: first failure swaps this process over to an in-memory store and logs once.
 *  The user keeps their selection and loses only the persisted transcript. */
let memoryFallback: ChatStore | null = null;
let warnedDegraded = false;
/** Test seam: forget that we degraded. */
export function _resetChatFallbackForTest(): void { memoryFallback = null; warnedDegraded = false; }

/** Read-only: has chat persistence fallen back to memory in this process?
 *  Surfaced by /health. Reports the degrade, never causes it. */
export function chatStoreDegraded(): boolean {
  return warnedDegraded;
}

export function resilientStore(real: ChatStore): ChatStore {
  const useFallback = (err: unknown): ChatStore => {
    if (!warnedDegraded) {
      warnedDegraded = true;
      console.warn(`[selection] chat persistence unavailable (${describeError(err)}) — continuing in memory for this process. Selections still work; the transcript won't survive a restart.`);
    }
    memoryFallback ??= new InMemoryChatStore();
    return memoryFallback;
  };
  const call = async <T>(pick: (s: ChatStore) => Promise<T>): Promise<T> => {
    if (memoryFallback) return pick(memoryFallback);
    try { return await pick(real); }
    catch (err) { return pick(useFallback(err)); }
  };
  return new Proxy(real, {
    get(target, prop: string) {
      const orig = (target as any)[prop];
      if (typeof orig !== "function") return orig;
      return (...args: unknown[]) => call((s) => (s as any)[prop](...args));
    },
  }) as ChatStore;
}

/** The store a handler should use: the caller's (tests inject one), else the
 *  real one wrapped so an outage degrades instead of 500ing. */
const storeFor = (deps: SelectionDeps): ChatStore => deps.chatStore ?? resilientStore(getChatStore());

async function guarded(route: string, fn: () => Promise<Out> | Out): Promise<Out> {
  try {
    return await fn();
  } catch (err: any) {
    const detail = describeError(err);
    console.error(`[selection] ${route} FAILED:`, err?.stack ?? err);
    return {
      status: 500,
      body: {
        error: detail
          ? `${route} failed: ${detail}`
          : `${route} failed with no error message — check the BFF log for the stack.`,
        route,
      },
    };
  }
}

export interface SelectionDeps {
  plan?: PlanSelectionRun;
  chatStore?: ChatStore;
  /** Test seam for the analyst pass: run SQL / compose the answer. */
  runQuery?: typeof nativeQuery;
  answer?: PlanSelectionRun;
}

/** Max tables a single /profile call will introspect (each one is a query). */
const PROFILE_BATCH = Number(process.env.T2SQL_PROFILE_BATCH ?? 12);

/** The catalog as the client renders it: display order, 1-based numbers, and a
 *  `profiled` flag so the UI knows whether clicking needs a round-trip. */
function catalogView(rec: { allTables: { name: string; approxRows: number }[]; datasets: Dataset[] }) {
  const profiled = new Set(rec.datasets.map((d) => d.tableName));
  return rec.allTables.map((t, i) => ({
    index: i + 1,
    name: t.name,
    approxRows: t.approxRows,
    profiled: profiled.has(t.name),
    columnCount: rec.datasets.find((d) => d.tableName === t.name)?.profile.columns.length ?? null,
  }));
}

// ---- POST /api/sql/select — one conversational selection turn ---------------------
export async function handleSelectionChat(body: unknown, tenantId: string, deps: SelectionDeps = {}): Promise<Out> {
  return guarded("/api/sql/select", () => handleSelectionChatInner(body, tenantId, deps));
}

async function handleSelectionChatInner(body: unknown, tenantId: string, deps: SelectionDeps = {}): Promise<Out> {
  const b = body as any;
  if (!b || typeof b !== "object") return bad("body must be a JSON object");
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return bad("prompt is required");
  const rec = getConnection(tenantId, String(b.connectionId ?? ""));
  if (!rec) return { status: 404, body: { error: "unknown or expired connection — reconnect" } };

  const store = storeFor(deps);
  const conversationId = await store.createConversation(`Select tables: ${rec.conn.database}`, b.conversationId || undefined);
  const history = await store.getHistory(conversationId, 24);
  const prompt = b.prompt.trim();
  await store.appendMessage(conversationId, { role: "user", content: prompt });

  const catalog = rec.allTables.map((t) => t.name);
  const state = await getSelection(conversationId, tenantId);
  const current = state.tables;

  // The model plans EVERY turn. It sees the catalog (with columns where they've
  // been profiled), the live selection, and the conversation so far, and it
  // writes both the ops and the words the user reads.
  const planned = await planSelectionTurn(
    {
      prompt,
      catalog: rec.allTables.map((t) => ({
        name: t.name,
        approxRows: t.approxRows,
        columns: rec.datasets.find((d) => d.tableName === t.name)?.profile.columns.map((c: any) => String(c.name)),
      })),
      selection: current,
      history,
      dialect: rec.conn.dialect,
    },
    deps.plan,
  );

  let ops: SelOp[] | null = planned?.ops ?? null;
  let modelReply: string | undefined = planned?.reply;
  let source: "model" | "offline" = "model";

  // planSelectionTurn returns null only for an outage (unreachable, timed out,
  // unparseable). Bare "1, 4, 9" still works in that state; anything with intent
  // in it does not, and the user is told why rather than half-obeyed.
  if (!planned) {
    const offline = offlineFallback(prompt, catalog);
    if (!offline) {
      const answer = `I can't reach the model right now, so I can't work out what you meant. You can still tick tables in the list on the left — or send just the numbers (“1, 4, 9”) and I'll add those.`;
      await store.appendMessage(conversationId, { role: "assistant", content: answer });
      return { status: 200, body: { conversationId, reply: answer, selection: current, added: [], removed: [], canUndo: canUndo(conversationId), understood: false, source: "offline" } };
    }
    ops = offline;
    source = "offline";
  }

  // ---- analyst pass: the model asked to read the data ----
  // Runs BEFORE selection ops are applied so a turn can do both ("add orders and
  // tell me how many are open"). The query is guarded statically, then executed
  // inside a READ ONLY transaction against the source database.
  let dataAnswer: string | undefined;
  let queryNote: string | undefined;
  if (planned?.sql) {
    const guard = guardSelect(planned.sql, Number(process.env.DB_ANALYSIS_ROW_CAP ?? 200));
    if (!guard.ok) {
      // The model wrote something the guard won't run. Say so rather than
      // silently dropping the question — and never echo the rejected SQL as if
      // it were an answer.
      queryNote = `I couldn't run that safely (${guard.error}).`;
      console.warn(`[selection] query rejected: ${guard.error} — ${planned.sql.slice(0, 200)}`);
    } else {
      try {
        console.log(`[selection] query: ${guard.sql.replace(/\s+/g, " ").slice(0, 300)}`);
        const rows = await (deps.runQuery ?? nativeQuery)(rec.conn, guard.sql);
        console.log(`[selection] query returned ${rows.rows.length} row(s) in ${rows.elapsedMs}ms`);
        dataAnswer = (await answerFromRows(
          { prompt, sql: guard.sql, columns: rows.columns, rows: rows.rows, truncated: rows.truncated, history },
          deps.answer,
        )) ?? describeRows(rows);
      } catch (err: any) {
        // A failed query is information: usually a wrong column or a permission
        // gap, both of which the user can act on.
        queryNote = `That query failed: ${describeError(err)}`;
        console.warn(`[selection] query failed:`, err?.stack ?? err);
      }
    }
  }

  const result = applyOps(current, ops ?? [], catalog, state.columns);

  // "undo" rewinds the store rather than computing a new set.
  if (result.undo) {
    const undone = await undoSelection(conversationId, tenantId);
    const answer = modelReply?.trim() || (undone
      ? `Undone — back to ${undone.tables.length} selected table${undone.tables.length === 1 ? "" : "s"}${undone.tables.length ? `: ${undone.tables.slice(0, 12).join(", ")}${undone.tables.length > 12 ? ", …" : ""}` : ""}.`
      : "There's nothing to undo yet.");
    await store.appendMessage(conversationId, {
      role: "assistant", content: answer,
      briefJson: JSON.stringify({ intent: "selection", op: "undo", selection: undone?.tables ?? current }),
    });
    return { status: 200, body: { conversationId, reply: answer, selection: undone?.tables ?? current, added: [], removed: [], canUndo: canUndo(conversationId), understood: true, source } };
  }

  // Persist only when the set actually moved, so the undo stack stays meaningful.
  const colsChanged = JSON.stringify(result.columns) !== JSON.stringify(state.columns);
  const changed = result.added.length > 0 || result.removed.length > 0 || colsChanged;
  if (changed) {
    await setSelection(conversationId, tenantId, result.selection, {
      connectionId: rec.id, connectionLabel: rec.label, columns: result.columns,
    });
  }

  // The model's words are the reply — this is a conversation, not a form. The
  // server only appends what the model can actually be wrong about: names that
  // don't exist and names that matched several tables.
  // The data answer leads when there is one — it's what was asked. Selection
  // changes and corrections follow, so nothing happens silently.
  let reply = dataAnswer || modelReply?.trim() || summarizeApply(result, catalog.length);
  if (dataAnswer && (result.added.length || result.removed.length)) {
    reply = `${reply}\n\n${summarizeApply(result, catalog.length)}`;
  }
  if (queryNote) reply = `${queryNote}${reply === queryNote ? "" : `\n\n${reply}`}`;
  if (!dataAnswer && modelReply?.trim()) {
    const note = correctionNote(result);
    if (note) reply = `${reply}\n\n${note}`;
  }

  await store.appendMessage(conversationId, {
    role: "assistant",
    content: reply,
    briefJson: JSON.stringify({ intent: "selection", ops, selection: result.selection, source }),
  });

  return {
    status: 200,
    body: {
      conversationId,
      reply,
      selection: result.selection,
      columns: result.columns,
      added: result.added,
      removed: result.removed,
      unresolved: result.unresolved,
      ambiguous: result.ambiguous,
      ...(result.focus ? { focus: result.focus } : {}),
      canUndo: canUndo(conversationId),
      understood: true,
      source,
    },
  };
}

// ---- GET /api/sql/selection/:conversationId — rehydrate after a reload -------------
export async function handleSelectionGet(conversationId: string, tenantId: string, deps: SelectionDeps = {}): Promise<Out> {
  return guarded("/api/sql/selection/:id", () => handleSelectionGetInner(conversationId, tenantId, deps));
}

async function handleSelectionGetInner(conversationId: string, tenantId: string, deps: SelectionDeps = {}): Promise<Out> {
  const id = String(conversationId ?? "");
  if (!id) return bad("conversationId is required");
  const state = await getSelection(id, tenantId);
  let turns: { role: string; content: string }[] = [];
  try {
    const store = storeFor(deps);
    turns = await store.getHistory(id, 40);
  } catch { /* memory is best-effort; the selection itself is the payload */ }
  return {
    status: 200,
    body: {
      conversationId: id,
      selection: state.tables,
      columns: state.columns,
      connectionId: state.connectionId || null,
      connectionLabel: state.connectionLabel ?? null,
      canUndo: canUndo(id),
      turns,
    },
  };
}

// ---- POST /api/sql/selection — the rail's checkboxes ---------------------------------
// Clicking and typing edit ONE selection. A click is also written into the
// transcript (as a user turn), so the next typed message — "actually drop the
// last one" — has the click in its history to refer to.
export async function handleSelectionSet(body: unknown, tenantId: string, deps: SelectionDeps = {}): Promise<Out> {
  return guarded("/api/sql/selection", () => handleSelectionSetInner(body, tenantId, deps));
}

async function handleSelectionSetInner(body: unknown, tenantId: string, deps: SelectionDeps = {}): Promise<Out> {
  const b = body as any;
  if (!b || typeof b !== "object") return bad("body must be a JSON object");
  if (!Array.isArray(b.tables)) return bad("tables[] is required");
  const rec = getConnection(tenantId, String(b.connectionId ?? ""));
  if (!rec) return { status: 404, body: { error: "unknown or expired connection — reconnect" } };

  const store = storeFor(deps);
  const conversationId = await store.createConversation(`Select tables: ${rec.conn.database}`, b.conversationId || undefined);

  const catalog = new Set(rec.allTables.map((t) => t.name));
  const wanted: string[] = [...new Set((b.tables as unknown[]).map((t) => String(t)))];
  const unknown = wanted.filter((t) => !catalog.has(t));
  const tables = rec.allTables.map((t) => t.name).filter((n) => wanted.includes(n)); // catalog order

  // columns: { table: [col, ...] } — narrowing which columns of a table get
  // stored. Sent by the middle panel's checkboxes; absent means "unchanged".
  const columns: Record<string, string[]> | undefined =
    b.columns && typeof b.columns === "object" && !Array.isArray(b.columns)
      ? Object.fromEntries(
          Object.entries(b.columns as Record<string, unknown>)
            .filter(([t]) => catalog.has(t))
            .map(([t, cols]) => [t, Array.isArray(cols) ? cols.map(String) : []]),
        )
      : undefined;

  const prev = await getSelection(conversationId, tenantId);
  const before = prev.tables;
  const added = tables.filter((t) => !before.includes(t));
  const removed = before.filter((t) => !tables.includes(t));
  // Compare the WHOLE projection, not just the keys that arrived. The old check
  // only looked at incoming entries, so `columns: {}` — the client saying "no
  // table is narrowed any more" — registered as no change at all, and the
  // widened selection was never saved.
  const sameProjection = (a: Record<string, string[]>, b: Record<string, string[]>) => {
    const norm = (m: Record<string, string[]>) =>
      JSON.stringify(Object.keys(m).filter((k) => m[k]?.length).sort().map((k) => [k, [...m[k]].sort()]));
    return norm(a) === norm(b);
  };
  const colsChanged = columns ? !sameProjection(columns, prev.columns) : false;
  if (added.length || removed.length || colsChanged) {
    await setSelection(conversationId, tenantId, tables, { connectionId: rec.id, connectionLabel: rec.label, ...(columns ? { columns } : {}) });
    if (b.note !== false) {
      const bits = [
        added.length ? `selected ${added.join(", ")}` : "",
        removed.length ? `deselected ${removed.join(", ")}` : "",
        colsChanged && columns
          ? `narrowed columns: ${Object.entries(columns).filter(([, c]) => c.length).map(([t, c]) => `${t} -> ${c.join(", ")}`).join("; ")}`
          : "",
      ].filter(Boolean).join("; ");
      try {
        await store.appendMessage(conversationId, { role: "user", content: `(clicked in the table list: ${bits})` });
      } catch { /* memory best-effort */ }
    }
  }
  return {
    status: 200,
    body: {
      conversationId,
      selection: tables,
      columns: (await getSelection(conversationId, tenantId)).columns,
      added, removed,
      canUndo: canUndo(conversationId),
      ...(unknown.length ? { unknown } : {}),
    },
  };
}

// ---- POST /api/sql/:connectionId/profile — columns on demand -------------------------
// Native, per table, the way a GUI client expands a tree node: one protocol
// connection, one columns query, one 5-row sample, one row estimate. It does NOT
// go through DuckDB's ATTACH, which would materialise the whole remote catalog
// just to describe one table.
export async function handleTableProfile(connectionId: string, body: unknown, tenantId: string): Promise<Out> {
  return guarded("/api/sql/:id/profile", () => handleTableProfileInner(connectionId, body, tenantId));
}

async function handleTableProfileInner(connectionId: string, body: unknown, tenantId: string): Promise<Out> {
  const rec = getConnection(tenantId, String(connectionId ?? ""));
  if (!rec) return { status: 404, body: { error: "unknown or expired connection — reconnect" } };
  const b = (body ?? {}) as any;
  const known = new Set(rec.allTables.map((t) => t.name));
  const wanted = (Array.isArray(b.tables) ? b.tables : [b.table])
    .map((t: unknown) => String(t ?? "").trim())
    .filter((t: string) => t && known.has(t))
    .slice(0, PROFILE_BATCH);
  if (!wanted.length) return bad("tables[] must name at least one table from this connection");
  try {
    const details = await nativeTableDetail(rec.conn, wanted);
    // Cache what we learned on the record so the selection planner can see real
    // column names when it reasons about "the ones with an email address".
    for (const d of details) {
      if (rec.datasets.some((x) => x.tableName === d.tableName)) continue;
      rec.datasets.push({
        tableName: d.tableName,
        profile: {
          source: { filename: `${rec.conn.dialect}:${rec.conn.database}.${d.tableName}`, format: "json" },
          rowCount: d.rowCount ?? 0,
          columns: d.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable })),
          sampleRows: d.sampleRows,
        },
      } as any);
    }
    return {
      status: 200,
      body: {
        tables: details.map((d) => ({
          tableName: d.tableName,
          rowCount: d.rowCount ?? 0,
          columns: d.columns.map((c) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            uniqueCount: null,
            // A column's first few values, read off the sample we already have —
            // no extra query per column.
            sampleValues: d.sampleRows.map((r) => r[c.name]).filter((v) => v !== undefined).slice(0, 4),
          })),
          sampleRows: d.sampleRows.slice(0, 5),
        })),
        warnings: rec.warnings.slice(-3),
      },
    };
  } catch (err: any) {
    return { status: 502, body: { error: `couldn't read the schema for ${wanted.join(", ")}: ${(err?.message || String(err)).trim() || "no error message reported"}` } };
  }
}

// ---- GET /api/sql/:connectionId/catalog — the rail's list -----------------------------
export function handleCatalog(connectionId: string, tenantId: string): Out {
  const rec = getConnection(tenantId, String(connectionId ?? ""));
  if (!rec) return { status: 404, body: { error: "unknown or expired connection — reconnect" } };
  return {
    status: 200,
    body: {
      connectionId: rec.id,
      label: rec.label,
      mode: rec.mode ?? null,
      status: rec.status,
      tables: catalogView(rec),
      warnings: rec.warnings,
    },
  };
}

// ---- POST /api/sql/selection/commit — "Continue to text2UI" -----------------------------
// Turns the selection into exactly what the build page already understands: a
// named source (snapshot) or a live source. Nothing new downstream — the
// dashboard/deck pipelines see the same shape they see from "Extract DB".
export async function handleSelectionCommit(body: unknown, tenantId: string, deps: SelectionDeps = {}): Promise<Out> {
  return guarded("/api/sql/selection/commit", () => handleSelectionCommitInner(body, tenantId, deps));
}

async function handleSelectionCommitInner(body: unknown, tenantId: string, deps: SelectionDeps = {}): Promise<Out> {
  const b = body as any;
  if (!b || typeof b !== "object") return bad("body must be a JSON object");
  const rec = getConnection(tenantId, String(b.connectionId ?? ""));
  if (!rec) return { status: 404, body: { error: "unknown or expired connection — reconnect" } };
  const store = storeFor(deps);
  const conversationId = await store.createConversation(`Select tables: ${rec.conn.database}`, b.conversationId || undefined);

  // The client may pass the tables explicitly (belt and braces); the stored
  // selection is authoritative when it doesn't.
  const known = new Set(rec.allTables.map((t) => t.name));
  const fromBody: string[] = Array.isArray(b.tables)
    ? (b.tables as unknown[]).map((t) => String(t)).filter((t) => known.has(t))
    : [];
  const tables: string[] = fromBody.length
    ? fromBody
    : (await getSelection(conversationId, tenantId)).tables.filter((t) => known.has(t));
  if (!tables.length) {
    return bad("nothing selected yet — pick at least one table (click it, or say \"select 1, 2, 3\") before continuing");
  }

  const label = typeof b.label === "string" && b.label.trim()
    ? b.label.trim()
    : `${rec.conn.database} (${tables.slice(0, 3).join(", ")}${tables.length > 3 ? `, +${tables.length - 3}` : ""})`;

  // This page always STORES the data: the selected tables are read once into a
  // snapshot and published as a source. (There used to be a "query live" option
  // here — removed, because a selection the user curated should not silently
  // depend on the database still being reachable at render time.)
  // Extraction is the slowest thing this page does and the most likely to fail
  // on a big server. Record where it got to, so a failure names the step it died
  // on rather than surfacing an empty message.
  const started = Date.now();
  const phases: string[] = [];
  const onPhase = (msg: string) => {
    phases.push(msg);
    console.log(`[selection-commit] ${rec.id}: ${msg}`);
  };

  try {
    // Snapshot: read the selected tables once into this conversation's staging
    // file, then publish that file as one source (the "Extract DB" mechanics,
    // driven by the selection instead of by chat intent).
    onPhase(`extracting ${tables.length} table(s): ${tables.join(", ")}`);
    const { staged, warnings, skipped } = await stageSnapshot(rec, tables, tenantId, conversationId, onPhase);

    // Narrow to the chosen columns. The user picked them against the DISPLAY
    // name they saw ("sales.orders"); the stage stores the physical name the
    // snapshot writer produced — the bare table name, sanitised, with a numeric
    // suffix if two schemas collided. Rebuild that mapping rather than relying
    // on array order, which addStaged is free to change when it merges.
    const chosenCols = (await getSelection(conversationId, tenantId)).columns;
    let colWarnings: string[] = [];
    if (Object.keys(chosenCols).length) {
      const sanitise = (t: string) =>
        t.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "t";
      const physical: Record<string, string[]> = {};
      const missingTables: string[] = [];
      for (const [display, cols] of Object.entries(chosenCols)) {
        if (!cols?.length) continue;
        const bare = display.includes(".") ? display.slice(display.lastIndexOf(".") + 1) : display;
        const want = sanitise(bare);
        const hit = staged.tables.find((t) => t.tableName === want)
          ?? staged.tables.find((t) => new RegExp(`^${want}(?:_\\d+)?$`).test(t.tableName));
        if (hit) physical[hit.tableName] = cols;
        else missingTables.push(`${display}: extracted table not found, kept all columns`);
      }
      colWarnings = [...missingTables, ...(await projectStagedColumns(conversationId, physical))];
    }
    // Keep only what was asked for: a stage reused across several commits could
    // still hold tables the user has since deselected.
    const wanted = new Set(tables);
    staged.tables = staged.tables.filter((t) => wanted.has(t.tableName));
    const source = finalizeStaged(conversationId, label);
    await dropSelection(conversationId, tenantId); // published — the stage is now a source
    await store.appendMessage(conversationId, {
      role: "assistant",
      content: `Extracted ${source.tables.map((t) => t.tableName).join(", ")} as “${source.label}”. Opening the builder…`,
      briefJson: JSON.stringify({ intent: "selection-commit", mode: "snapshot", tables }),
    });
    return {
      status: 200,
      body: {
        conversationId,
        projectId: source.projectId,
        label: source.label,
        tables: source.tables,
        mode: "snapshot" as const,
        warnings: [...warnings, ...skipped, ...colWarnings],
      },
    };
  } catch (err: any) {
    // `??` would let an Error with an empty message through as "" — which is
    // how a failure reaches the user as a bare "Extraction failed:" with nothing
    // after it. `||` falls through to something the user can act on, and the
    // last phase says which step actually died.
    const detail = (err?.message || "").trim();
    const secs = Math.round((Date.now() - started) / 1000);
    const where = phases.length ? phases[phases.length - 1] : "starting up";
    const msg = detail
      ? `${detail} (failed after ${secs}s, during: ${where})`
      : `extraction failed after ${secs}s during: ${where}. No error message was reported — check the BFF log for the full trace.`;
    console.error(`[selection-commit] ${rec.id}: FAILED after ${secs}s during "${where}"`, err);
    return { status: 500, body: { error: msg, phases, elapsedSeconds: secs } };
  }
}
