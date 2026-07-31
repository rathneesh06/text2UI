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
import { randomUUID } from "node:crypto";
import { getChatStore, InMemoryChatStore, type ChatStore } from "../chat-store";
import { describeError } from "../sources/describe-error";
import { getConnection, getHandle, memberIdForCatalog, soloMemberId, type ConnRecord } from "../sources/connection-registry";
import { nativeTableDetail, nativeQuery } from "../sources/native-catalog";
import { guardSelect } from "./guard";
import {
  getSelection, setSelection, setDependencies, undoSelection, canUndo, dropSelection,
} from "../sources/selection-store";
import { finalizeStaged, projectStagedColumns, stagingDbPath, releaseInstance } from "../sources/workbench-store";
import { buildJoinGraph, viewDdl, describeCombinedSchema, type StagedTable } from "./combined-schema";
import { stageSnapshot } from "./handler";
import {
  answerFromRows, applyOps, correctionNote, describeRows, offlineFallback,
  planSelectionTurn, summarizeApply, type PlanSelectionRun, type SelOp,
} from "./selection";
import {
  planDependencyTurn, applyTurn, validateAgainstCatalog, probeOverlap, captureVerbatim,
  type DependencyCatalogTable,
} from "./dependency-chat";
import { mergeDependencies, type Dependency, type MemberId } from "../../shared/dependencies";
import { callGemini, ORCHESTRATE_OPTS } from "../aiflow";
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

// ---- ephemeral vs durable chat storage -------------------------------------------
//
// PRIVACY: a /select answer is composed out of live row values read from whatever
// production database the user pasted a connection string for. Persisting those
// turns copied that data into text2ui_messages on the shared flowops box, in
// plaintext, permanently. Selection turns therefore live in memory only.
//
// But the /select conversation is not only a chat: handleSelectionCommit creates
// the conversation id that BECOMES the main text2UI conversation, and its final
// "Extracted … Opening the builder…" breadcrumb is the main chat's first message.
// So "stop persisting" cannot mean "write nothing" — exactly one write survives,
// and it is authored by us, not by the database.
const CHAT_TTL_MS = () => Math.max(60_000, Number(process.env.T2SQL_SELECT_CHAT_TTL_MS ?? 3_600_000));

/** In-memory transcripts, one InMemoryChatStore per conversation so an idle one
 *  can actually be dropped (ChatStore has no delete). Swept on access, the same
 *  shape as sweep() in ../sources/connection-registry. */
class EphemeralChatStore implements ChatStore {
  private convs = new Map<string, { s: InMemoryChatStore; last: number }>();
  /** Project state is not row data; keep one shared store for it. */
  private projects = new InMemoryChatStore();

  private sweep(now = Date.now()): void {
    const ttl = CHAT_TTL_MS();
    for (const [id, e] of this.convs) if (now - e.last > ttl) this.convs.delete(id);
  }
  private For(id: string): InMemoryChatStore {
    this.sweep();
    let e = this.convs.get(id);
    if (!e) { e = { s: new InMemoryChatStore(), last: Date.now() }; this.convs.set(id, e); }
    else e.last = Date.now();
    return e.s;
  }

  async createConversation(title?: string, id?: string): Promise<string> {
    // Mint the id ourselves when the caller has none, so the per-conversation
    // store can be keyed before InMemoryChatStore would have generated one.
    const cid = id || randomUUID();
    return this.For(cid).createConversation(title, cid);
  }
  async appendMessage(conversationId: string, msg: Parameters<ChatStore["appendMessage"]>[1]): Promise<void> {
    return this.For(conversationId).appendMessage(conversationId, msg);
  }
  async getHistory(conversationId: string, limit?: number): ReturnType<ChatStore["getHistory"]> {
    return this.For(conversationId).getHistory(conversationId, limit);
  }
  async listConversations(limit?: number): ReturnType<ChatStore["listConversations"]> {
    this.sweep();
    const all = (await Promise.all([...this.convs.values()].map((e) => e.s.listConversations(limit)))).flat();
    all.sort((a: any, b: any) => Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0));
    return (limit ? all.slice(0, limit) : all) as any;
  }
  async saveProjectState(projectId: string, state: Parameters<ChatStore["saveProjectState"]>[1]): Promise<void> {
    return this.projects.saveProjectState(projectId, state);
  }
  async getProjectState(projectId: string): ReturnType<ChatStore["getProjectState"]> {
    return this.projects.getProjectState(projectId);
  }
  /** Test seam. */
  _clear(): void { this.convs.clear(); }
}

const ephemeral = new EphemeralChatStore();

/** Selection turns: in memory, never written to Postgres. Used by
 *  handleSelectionChat / Get / Set. */
const ephemeralStore = (deps: SelectionDeps): ChatStore => deps.chatStore ?? ephemeral;

/** The commit breadcrumb only: this one conversation and its single closing
 *  message become the main chat, so they must survive. Still wrapped so a
 *  storage outage degrades instead of 500ing. */
const durableStore = (deps: SelectionDeps): ChatStore => deps.chatStore ?? resilientStore(getChatStore());

/** Test seam: forget every in-memory selection transcript. */
export function _resetEphemeralChatForTest(): void { ephemeral._clear(); }

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
  /** Streaming seam: called with each guarded query as it is about to run, so the
   *  SSE route can emit a `query` event. Additive — omit it and nothing changes. */
  onQuery?: (sql: string) => void;
}

/** Max tables a single /profile call will introspect (each one is a query). */
const PROFILE_BATCH = Number(process.env.T2SQL_PROFILE_BATCH ?? 12);

/** The catalog as the client renders it: display order, 1-based numbers, and a
 *  `profiled` flag so the UI knows whether clicking needs a round-trip. */
function catalogView(rec: ConnRecord) {
  const profiled = new Set(rec.datasets.map((d) => d.tableName));
  const parts = rec.groupParts;
  const solo = !parts?.length;
  return rec.allTables.map((t, i) => ({
    index: i + 1,
    name: t.name,
    approxRows: t.approxRows,
    profiled: profiled.has(t.name),
    columnCount: rec.datasets.find((d) => d.tableName === t.name)?.profile.columns.length ?? null,
    // Which database this table came from. Resolved SERVER-SIDE from the ref, so
    // the UI never parses `src{i}` — that index is attach-scoped and shifts when
    // a member is removed.
    memberId: solo ? soloMemberId(rec) : (memberIdForCatalog(parts!, String(t.ref ?? "").split(".")[0]) ?? null),
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

  const store = ephemeralStore(deps);
  const conversationId = await store.createConversation(`Select tables: ${rec.conn.database}`, b.conversationId || undefined);
  const history = await store.getHistory(conversationId, 24);
  const prompt = b.prompt.trim();
  await store.appendMessage(conversationId, { role: "user", content: prompt });

  // ---- dependency capture --------------------------------------------------------
  // This chat no longer selects tables (checkboxes and tabs do that) and no longer
  // answers data questions (the build chat does that). Its one job is to record how
  // the connected databases relate, because that is the only thing here that no
  // other surface can recover: a planner looking at two staged tables cannot know
  // which column joins them, or that one row explains forty.
  const parts = rec.groupParts ?? [];
  const idAt = (i: number): string | null => parts[i]?.id ?? null;
  const state = await getSelection(conversationId, tenantId, idAt);
  const memberOf = (name: string): MemberId =>
    (parts.length
      ? memberIdForCatalog(parts, String(rec.allTables.find((t) => t.name === name)?.ref ?? "").split(".")[0])
      : soloMemberId(rec)) ?? soloMemberId(rec);

  const depCatalog: DependencyCatalogTable[] = rec.allTables.map((t) => ({
    member: memberOf(t.name),
    memberLabel: parts.find((p) => p.id === memberOf(t.name))?.label ?? rec.label,
    table: t.name,
    columns: rec.datasets.find((d) => d.tableName === t.name)?.profile.columns.map((c: any) => String(c.name)) ?? [],
  }));

  const turn = await planDependencyTurn(
    { prompt, catalog: depCatalog, captured: state.dependencies ?? [], history },
    deps.plan as any,
  );

  let captured: Dependency[];
  let reply: string;
  if (!turn) {
    // The model is unreachable. Keep the statement anyway — losing what the user
    // said is the one outcome this feature must never produce.
    captured = mergeDependencies(state.dependencies ?? [], [captureVerbatim(prompt)]);
    reply = "I couldn't reach the assistant, so I've saved that exactly as you wrote it and will structure it when the model is back.";
  } else {
    const merged = applyTurn(state.dependencies ?? [], turn);
    // Validation is CODE, not prompt: check the columns exist, then (best-effort)
    // that the values actually overlap. A dependency that fails either is KEPT and
    // marked, because a rejected dependency is feedback the user can correct.
    const columnsOf = (member: MemberId, table: string): string[] | null => {
      const hit = depCatalog.find((c) => c.member === member && c.table.toLowerCase() === table.toLowerCase())
        ?? depCatalog.find((c) => c.table.toLowerCase() === table.toLowerCase());
      if (!hit) return null;
      return hit.columns.length ? hit.columns : null;
    };
    let validated = validateAgainstCatalog(merged, columnsOf);

    // Probe only what this turn touched, and never let a probe failure cost the turn.
    const touched = new Set(turn.dependencies.map((d) => d.id));
    if (touched.size) {
      try {
        const h = await getHandle(rec);
        const refOf = (member: MemberId, table: string): string | null => {
          const t = rec.allTables.find((x) => x.name.toLowerCase() === table.toLowerCase()
            && (!parts.length || memberOf(x.name) === member));
          return t?.ref ?? null;
        };
        const probed = await probeOverlap(
          validated.filter((d) => touched.has(d.id)),
          refOf,
          async (sql) => ({ rows: await h.readAll(sql, "dependency overlap probe") }),
        );
        validated = mergeDependencies(validated, probed);
      } catch (err: any) {
        console.warn(`[dependency] probe unavailable: ${describeError(err)}`);
      }
    }
    captured = validated;
    reply = turn.reply || "Noted.";
  }

  await setDependencies(conversationId, tenantId, captured);
  console.log(`[dependency] ${captured.length} captured (${captured.filter((d) => d.confidence === "rejected").length} rejected)`);

  await store.appendMessage(conversationId, { role: "assistant", content: reply });
  return {
    status: 200,
    body: {
      conversationId,
      reply,
      dependencies: captured,
      // Selection is untouched by this chat now — returned so the page keeps one
      // shape and the rail doesn't have to guess.
      selection: state.tables,
      columns: state.columns,
      added: [], removed: [],
      canUndo: canUndo(conversationId),
      understood: !!turn,
      source: turn ? "model" : "offline",
    },
  };
}

/** Retired with Stage 3: the chat used to plan selection ops and answer data
 *  questions. Kept only so the old code path is obviously gone rather than
 *  half-present. */

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
    // Ephemeral: after a BFF restart this is legitimately empty. The SELECTION
    // still loads from Postgres below — an empty transcript is correct here,
    // not a failure, so this must not throw.
    const store = ephemeralStore(deps);
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
      // Durable across reloads: the dependency list is the user's only view of
      // what the system believes, so it must come back with the selection.
      dependencies: state.dependencies ?? [],
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

  const store = ephemeralStore(deps);
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
      // One entry per database, in attach order. Always present — a single
      // connection reports one synthetic member so the UI has no special case.
      members: rec.groupParts?.length
        ? rec.groupParts.map((p) => ({ id: p.id, label: p.label }))
        : [{ id: soloMemberId(rec), label: rec.label }],
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
  // DURABLE — the only persisted path. This conversation id becomes the main
  // text2UI conversation and its closing breadcrumb is that chat's first message.
  const store = durableStore(deps);
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

    // ---- the combined schema layer -------------------------------------------------
    // Tables stay staged AS-IS. This adds a SECOND layer beside them: views over
    // the declared joins, plus a prose directive for the planner. Without it a
    // planner sees `orders` and `customers` side by side with no way to know which
    // column relates them, or that one row of one explains forty of the other.
    //
    // Entirely best-effort. A view that fails to build is a warning, never a
    // failed commit — the raw tables are the valuable part and they are already
    // extracted by this point.
    let combinedSchema: string | undefined;
    const viewWarnings: string[] = [];
    try {
      const captured = (await getSelection(conversationId, tenantId)).dependencies ?? [];
      if (captured.length) {
        // member comes from origin.memberId — the STABLE id stamped at snapshot
        // time. Never origin.catalog: that is `src{i}`, positional, and shifts
        // the moment a database is removed from the group.
        const stagedTables: StagedTable[] = staged.tables
          .map((t: any) => (t.origin?.memberId
            ? { member: String(t.origin.memberId), sourceTable: String(t.origin.table), localName: t.tableName }
            : null))
          .filter(Boolean) as StagedTable[];

        const graph = buildJoinGraph(captured, stagedTables);
        viewWarnings.push(...graph.warnings);

        const columnsOf = (localName: string): string[] =>
          staged.tables.find((t) => t.tableName === localName)?.profile.columns.map((c: any) => String(c.name)) ?? [];
        const ddl = viewDdl(graph, columnsOf);

        if (ddl.length) {
          onPhase(`building ${ddl.length} combined view(s)`);
          const { DuckDBInstance } = await import("@duckdb/node-api");
          await releaseInstance(stagingDbPath(conversationId));
          const inst = await DuckDBInstance.create(stagingDbPath(conversationId));
          const c = await inst.connect();
          try {
            for (const sql of ddl) {
              try { await c.run(sql); }
              catch (e: any) {
                // One broken view must not cost the user tables that extracted fine.
                const msg = `combined view skipped: ${(e?.message ?? e).toString().slice(0, 200)}`;
                console.warn(`[combined-schema] ${msg}`);
                viewWarnings.push(msg);
              }
            }
          } finally {
            c.disconnectSync();
            inst.closeSync();
          }
        }
        combinedSchema = describeCombinedSchema(graph, captured);
        console.log(`[combined-schema] ${graph.components.length} component(s), ${ddl.length} view(s), ${graph.isolated.length} isolated`);
      }
    } catch (err: any) {
      // Never fail a commit over the extra layer.
      const msg = `combined schema unavailable: ${describeError(err)}`;
      console.warn(`[combined-schema] ${msg}`);
      viewWarnings.push(msg);
    }

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
        // Sibling to `evidence`, never a replacement: a build can legitimately
        // have analyst findings AND join semantics, and they are spent
        // differently (see ChatPage — evidence is first-build-only, this is not).
        ...(combinedSchema ? { combinedSchema } : {}),
        warnings: [...warnings, ...skipped, ...colWarnings, ...viewWarnings],
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
