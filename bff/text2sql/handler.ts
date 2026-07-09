// bff/text2sql/handler.ts — pure handlers for the SQL Workbench routes (deps
// injectable, unit-testable without a server — same pattern as dashboard/handler).
//
//   POST /api/sql/connect  → handleSqlConnect   prove creds + profile the schema
//   GET  /api/sql/:id/schema → handleSqlSchema  rehydrate the schema tree
//   POST /api/sql/chat     → handleSqlChat      the conversational loop
//   POST /api/sql/extract  → handleSqlExtract   snapshot tables → named source
//
// The chat loop per turn: plan (LLM) → branch on intent →
//   query/preview: guard → execute on the live attach → compose grounded answer
//   extract:       snapshot the tables → register a workbench source
//   build:         snapshot (reuse) + return a handoff the CLIENT drives through
//                  the existing /api/dashboard/build or /api/deck/build — the
//                  build pipelines are not duplicated here, only fed.
//   chat:          the planner's direct reply
// Every turn (user + assistant, with sql/intent breadcrumbs) is appended to the
// same ChatStore the orchestrator uses, so workbench history is auditable and
// threads into subsequent plans.
import { getChatStore, type ChatStore } from "../chat-store";
import {
  openConnection, openConnectionWith, getConnection, getHandle, closeConnectionHandle, publicView, profileTables,
  markExecution, type ConnRecord,
} from "../sources/connection-registry";
import { connFromParts, type DbConnParts } from "../sources/db-conn";
import {
  registerWorkbenchSource, getWorkbenchSource, wbSlug, wbDbPath,
  stagingDbPath, addStaged, getStaged, finalizeStaged, discardStaged,
  type WorkbenchSource, type StagedState,
} from "../sources/workbench-store";
import { snapshotTables } from "../sources/db-conn";
import { COLO_PROJECT_ID, coloAvailable, coloProfiles, coloQuery } from "../sources/colo";
import { isWorkbenchProject, wbQuery, combineSources } from "../sources/workbench-store";
import { qid } from "../sources/mysql";
import { guardSelect } from "./guard";
import { planSqlTurn, type PlanSqlRun, type SqlTurnPlan } from "./planner";
import { composeAnswer, composeFallback, type ComposeRun } from "./composer";
import type { Dataset } from "../../shared/types";

const QUERY_MAX_ROWS = Number(process.env.T2SQL_QUERY_MAX_ROWS ?? 500);
const ROWS_TO_CLIENT = Number(process.env.T2SQL_ROWS_TO_CLIENT ?? 200);
// Query classes get their own timeouts (blueprint): previews must feel instant.
const PREVIEW_TIMEOUT_MS = Number(process.env.T2SQL_PREVIEW_TIMEOUT_MS ?? 10_000);
const QUERY_TIMEOUT_MS = Number(process.env.T2SQL_LIVE_QUERY_TIMEOUT_MS ?? 30_000);

export interface SqlHandlerDeps {
  plan?: PlanSqlRun;        // Gemini runner for the planner (tests inject a fake)
  compose?: ComposeRun;     // Gemini runner for the composer
  chatStore?: ChatStore;
}

type Out = { status: number; body: any };
const bad = (error: string): Out => ({ status: 400, body: { error } });

// ---- POST /api/sql/connect ----------------------------------------------------
export async function handleSqlConnect(body: unknown, tenantId: string): Promise<Out> {
  const b = body as any;
  if (!b || typeof b !== "object") return bad("body must be a JSON object");
  const hasString = typeof b.connectionString === "string" && b.connectionString.trim();
  const hasParts = b.parts && typeof b.parts === "object";
  if (!hasString && !hasParts) {
    return bad("connectionString (mysql://… or postgres://…) or parts {host, database, …} is required");
  }
  try {
    // Structured parts (the dedicated Postgres page): every field taken literally.
    const rec = hasParts
      ? await openConnectionWith(tenantId, connFromParts(b.parts as DbConnParts))
      : await openConnection(tenantId, b.connectionString);
    return { status: 200, body: publicView(rec) };
  } catch (err: any) {
    // Bad input / failed handshake / timeout — user-actionable, so a 400 with the message.
    return bad(err?.message ?? "connection failed");
  }
}

// ---- GET /api/sql/:connectionId/schema -----------------------------------------
export function handleSqlSchema(connectionId: string, tenantId: string): Out {
  const rec = getConnection(tenantId, String(connectionId ?? ""));
  if (!rec) return { status: 404, body: { error: "unknown or expired connection — reconnect" } };
  return { status: 200, body: publicView(rec) };
}

// ---- staging helper (shared by chat-extract, chat-build, and the tree button) ----
// Extracts ACCUMULATE per conversation: each call appends whole-table snapshots
// into the conversation's single staging DuckDB file. Publishing to the build
// page happens only via finalizeStaged() ("Extract DB") — or implicitly on a
// build intent, which needs a queryable source immediately.
async function stageSnapshot(
  rec: ConnRecord,
  tables: string[],
  tenantId: string,
  conversationId: string,
): Promise<{ staged: StagedState; warnings: string[]; skipped: string[] }> {
  const cleaned = [...new Set(tables.map((t) => String(t).trim()).filter(Boolean))];
  if (!cleaned.length) throw new Error("no tables to extract");
  // Same file every time -> tables append (CREATE OR REPLACE dedupes re-extracts).
  const result = await snapshotTables(rec.conn, { tables: cleaned, dbPath: stagingDbPath(conversationId) });
  const skipped: string[] = result.skipped;
  if (!result.datasets.length && !getStaged(conversationId)) {
    throw new Error(`extraction produced no tables (${skipped.join("; ") || "unknown reason"})`);
  }
  const staged = addStaged(conversationId, tenantId, result.dbPath, result.datasets);
  return { staged, warnings: result.warnings, skipped };
}

/** Client-visible stage summary (tables + columns for the right panel). */
function stagedView(st: StagedState) {
  return {
    count: st.tables.length,
    tables: st.tables.map((t) => ({
      tableName: t.tableName,
      rowCount: t.profile.rowCount,
      columns: t.profile.columns.map((c) => ({ name: c.name, type: c.type })),
    })),
  };
}

// ---- POST /api/sql/extract ------------------------------------------------------
export async function handleSqlExtract(body: unknown, tenantId: string, deps: SqlHandlerDeps = {}): Promise<Out> {
  const b = body as any;
  if (!b || typeof b !== "object") return bad("body must be a JSON object");
  const rec = getConnection(tenantId, String(b.connectionId ?? ""));
  if (!rec) return { status: 404, body: { error: "unknown or expired connection — reconnect" } };
  if (!Array.isArray(b.tables) || !b.tables.length) return bad("tables[] is required");
  try {
    const store = deps.chatStore ?? getChatStore();
    const conversationId = await store.createConversation(`Workbench: ${rec.conn.database}`, b.conversationId || undefined);
    const { staged, warnings, skipped } = await stageSnapshot(rec, b.tables, tenantId, conversationId);
    return { status: 200, body: { conversationId, staged: stagedView(staged), warnings: [...warnings, ...skipped] } };
  } catch (err: any) {
    return { status: 500, body: { error: err?.message ?? "extraction failed" } };
  }
}

// ---- POST /api/source/chat — data questions INSIDE the build chat -----------------
// The pipeline join the workbench was built for: once a source is published (or
// colo is active), the main build conversation can ANSWER data questions by
// running the same plan→guard→execute→compose loop against the local snapshot.
export async function handleSourceChat(body: unknown, tenantId: string, deps: SqlHandlerDeps = {}): Promise<Out> {
  const b = body as any;
  if (!b || typeof b !== "object") return bad("body must be a JSON object");
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return bad("prompt is required");
  const projectId = String(b.projectId ?? "");

  let tables: Dataset[];
  let runQuery: (sql: string) => Promise<Record<string, unknown>[]>;
  if (projectId === COLO_PROJECT_ID && coloAvailable()) {
    tables = await coloProfiles();
    runQuery = (sql) => coloQuery(sql, { rowCap: 500, timeoutMs: 20_000 }).then((r) => r.rows);
  } else if (isWorkbenchProject(projectId)) {
    const src = getWorkbenchSource(projectId);
    if (!src || src.tenantId !== tenantId) return { status: 404, body: { error: "unknown source" } };
    tables = src.tables;
    runQuery = (sql) => wbQuery(projectId, sql, { rowCap: 500, timeoutMs: 20_000 }).then((r) => r.rows);
  } else {
    return bad("projectId must be a published workbench source or the colo snapshot");
  }

  const store = deps.chatStore ?? getChatStore();
  const conversationId = await store.createConversation(b.prompt.slice(0, 80), b.conversationId || undefined);
  const history = await store.getHistory(conversationId, 20);
  const prompt = b.prompt.trim();
  await store.appendMessage(conversationId, { role: "user", content: prompt });
  const say = async (out: any): Promise<Out> => {
    await store.appendMessage(conversationId, {
      role: "assistant", content: String(out.answer ?? ""),
      briefJson: out.sql ? JSON.stringify({ intent: "source-question", sql: out.sql, executionMeta: out.executionMeta }) : null,
    });
    return { status: 200, body: { conversationId, ...out } };
  };

  const allTables = tables.map((t) => ({
    name: t.tableName, schema: "main", table: t.tableName,
    ref: qid(t.tableName), approxRows: t.profile.rowCount,
  }));
  const plan = await planSqlTurn({ prompt, mode: "snapshot", allTables, datasets: tables, history }, deps.plan);

  if (!plan || plan.intent === "chat" || plan.intent === "extract" || plan.intent === "build") {
    const fallback = plan?.reply?.trim()
      || `I can answer questions about this data (${tables.map((t) => t.tableName).slice(0, 4).join(", ")}${tables.length > 4 ? ", …" : ""}) — or just describe a change and I'll update the artifact.`;
    return say({ answer: fallback });
  }

  const guarded = guardSelect(plan.sql ?? "", 500);
  if (!guarded.ok) return say({ answer: `I couldn't form a safe query for that (${guarded.error}). Try rephrasing.` });
  const t0 = Date.now();
  let rows: Record<string, unknown>[];
  try {
    rows = await runQuery(guarded.sql);
  } catch (err: any) {
    return say({ answer: `The lookup failed: ${err?.message ?? err}`, sql: guarded.sql });
  }
  const executionMeta = { durationMs: Date.now() - t0, rowsReturned: rows.length, sourceType: "snapshot" as const };
  const simple = rows.length === 0 || (rows.length === 1 && Object.keys(rows[0]).length === 1);
  const answer = simple
    ? composeFallback({ question: prompt, sql: guarded.sql, rows })
    : await composeAnswer({ question: prompt, sql: guarded.sql, rows }, deps.compose);
  return say({ answer, sql: guarded.sql, rows: rows.slice(0, 50), columns: rows.length ? Object.keys(rows[0]) : [], executionMeta });
}

// ---- GET /api/sql/stage/:conversationId — rehydrate the staged panel ------------
// Pairs with durable staging: after a page reload (or BFF restart) the client can
// restore the right panel and still press "Extract DB" without reconnecting.
export function handleSqlStageGet(conversationId: string, tenantId: string): Out {
  const st = getStaged(String(conversationId ?? ""));
  if (!st || st.tenantId !== tenantId) return { status: 200, body: { staged: { count: 0, tables: [] } } };
  return { status: 200, body: { conversationId: st.conversationId, staged: stagedView(st) } };
}

// ---- POST /api/sources/combine — merge published extracts into ONE source --------
// Multi-connection builds: extract from string A, build; extract from string B,
// "Build with B" while A's session is active → the app combines A+B here and the
// build continues over the union. Chains: (A+B)+C works the same way.
export async function handleCombineSources(body: unknown, tenantId: string): Promise<Out> {
  const b = body as any;
  if (!b || typeof b !== "object") return bad("body must be a JSON object");
  if (!Array.isArray(b.projectIds) || b.projectIds.length < 2) return bad("projectIds[] with at least two entries is required");
  if (!b.projectIds.every((id: unknown) => typeof id === "string" && isWorkbenchProject(String(id)))) {
    return bad("only workbench (wb_*) sources can be combined");
  }
  try {
    const { source, renames } = await combineSources(tenantId, b.projectIds, typeof b.label === "string" ? b.label : undefined);
    return { status: 200, body: { projectId: source.projectId, label: source.label, tables: source.tables, components: source.components, warnings: renames } };
  } catch (err: any) {
    return bad(err?.message ?? "combine failed");
  }
}

// ---- DELETE /api/sql/stage/:conversationId — discard an unpublished stage --------
// Fresh-start semantics: booting the app anywhere other than the workbench pages
// clears the remembered stage; this removes the server side of it too.
export function handleSqlStageDiscard(conversationId: string, tenantId: string): Out {
  const removed = discardStaged(String(conversationId ?? ""), tenantId);
  return { status: 200, body: { discarded: removed } };
}

// ---- POST /api/sql/extract-db — the "Extract DB" button: publish the stage ------
export async function handleSqlExtractDb(body: unknown, tenantId: string): Promise<Out> {
  const b = body as any;
  if (!b || typeof b !== "object") return bad("body must be a JSON object");
  if (typeof b.conversationId !== "string" || !b.conversationId) return bad("conversationId is required");
  const st = getStaged(b.conversationId);
  if (!st) return bad("nothing staged in this conversation yet — extract some tables first");
  if (st.tenantId !== tenantId) return { status: 404, body: { error: "unknown conversation" } };
  try {
    const source = finalizeStaged(b.conversationId, typeof b.label === "string" ? b.label : undefined);
    return { status: 200, body: { projectId: source.projectId, label: source.label, tables: source.tables } };
  } catch (err: any) {
    return bad(err?.message ?? "extract DB failed");
  }
}

// ---- POST /api/sql/chat -----------------------------------------------------------
export async function handleSqlChat(body: unknown, tenantId: string, deps: SqlHandlerDeps = {}): Promise<Out> {
  const b = body as any;
  if (!b || typeof b !== "object") return bad("body must be a JSON object");
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return bad("prompt is required");
  const rec = getConnection(tenantId, String(b.connectionId ?? ""));
  if (!rec) return { status: 404, body: { error: "unknown or expired connection — reconnect" } };

  const store = deps.chatStore ?? getChatStore();
  const conversationId = await store.createConversation(`Workbench: ${rec.conn.database}`, b.conversationId || undefined);
  const history = await store.getHistory(conversationId, 20);
  const prompt = b.prompt.trim();
  await store.appendMessage(conversationId, { role: "user", content: prompt });

  const reply = async (out: any): Promise<Out> => {
    await store.appendMessage(conversationId, {
      role: "assistant",
      content: String(out.answer ?? ""),
      briefJson: out.sql ? JSON.stringify({ intent: out.intent, sql: out.sql, executionMeta: out.executionMeta, policy: out.policy }) : null,
    });
    return { status: 200, body: { conversationId, ...out } };
  };

  const plan: SqlTurnPlan | null = await planSqlTurn(
    { prompt, dialect: rec.conn.dialect, allTables: rec.allTables, datasets: rec.datasets, history },
    deps.plan,
  );
  if (!plan) {
    return reply({
      intent: "chat",
      answer: `I couldn't plan that turn. The connected schema has ${rec.allTables.length} tables — try asking about one by name, e.g. "show me ${rec.allTables[0]?.name ?? "a table"}".`,
    });
  }

  switch (plan.intent) {
    case "chat":
      return reply({ intent: "chat", answer: plan.reply?.trim() || `Connected to ${rec.label} — ${rec.allTables.length} tables available.` });

    case "query":
    case "preview": {
      if (rec.status === "degraded") {
        return reply({ intent: plan.intent, answer: "This connection has failed repeatedly and is marked degraded — the database may be down or the session lost. Disconnect and reconnect to continue." });
      }
      const guarded = guardSelect(plan.sql ?? "", QUERY_MAX_ROWS);
      if (!guarded.ok) return reply({ intent: plan.intent, answer: `I generated a query but it failed the safety check (${guarded.error}). Try rephrasing.`, sql: plan.sql, policy: { outcome: "rejected", reason: guarded.error } });
      const t0 = Date.now();
      let rows: Record<string, unknown>[];
      try {
        rows = await runOnLiveAttach(rec, guarded.sql, plan.intent === "preview" ? PREVIEW_TIMEOUT_MS : QUERY_TIMEOUT_MS);
        markExecution(rec, true);
      } catch (err: any) {
        const status = markExecution(rec, false);
        return reply({ intent: plan.intent, answer: `The query failed: ${err?.message ?? err}${status === "degraded" ? " The connection is now marked degraded — reconnect to continue." : ""}`, sql: guarded.sql });
      }
      const executionMeta = { durationMs: Date.now() - t0, rowsReturned: rows.length, sourceType: "live" as const };
      const truncated = rows.length >= QUERY_MAX_ROWS;
      // Deterministic answer paths (blueprint: "skip the composer LLM on simple
      // shapes"): previews, empty results, and single-cell answers need no model.
      const simpleShape = rows.length === 0 || (rows.length === 1 && Object.keys(rows[0]).length === 1);
      const answer = plan.intent === "preview" || simpleShape
        ? composeFallback({ question: prompt, sql: guarded.sql, rows, truncated })
        : await composeAnswer({ question: prompt, sql: guarded.sql, rows, truncated }, deps.compose);
      return reply({
        intent: plan.intent, answer, sql: guarded.sql,
        rows: rows.slice(0, ROWS_TO_CLIENT),
        columns: rows.length ? Object.keys(rows[0]) : [],
        truncated: truncated || rows.length > ROWS_TO_CLIENT,
        executionMeta,
        policy: guarded.capped ? { outcome: "capped", reason: `row cap ${QUERY_MAX_ROWS} applied` } : { outcome: "allowed" },
      });
    }

    case "extract": {
      try {
        const { staged, skipped } = await stageSnapshot(rec, plan.tables ?? [], tenantId, conversationId);
        const names = staged.tables.map((t) => t.tableName).join(", ");
        const answer =
          `Staged ${staged.tables.length} table${staged.tables.length === 1 ? "" : "s"} so far (${names}) — see the panel on the right. ` +
          `Keep extracting more, or press “Extract DB” to publish them all as one data source on the build page.` +
          (skipped.length ? ` Skipped: ${skipped.join("; ")}.` : "");
        return reply({ intent: "extract", answer, staged: stagedView(staged) });
      } catch (err: any) {
        return reply({ intent: "extract", answer: `Extraction failed: ${err?.message ?? err}` });
      }
    }

    case "build": {
      // Snapshot first (production is read once, never touched at build time),
      // then hand the client everything it needs to drive the EXISTING pipeline.
      try {
        const { staged } = await stageSnapshot(rec, plan.tables ?? [], tenantId, conversationId);
        const source = finalizeStaged(conversationId, plan.tables?.length ? `${rec.conn.database} (${plan.tables.join(", ")})` : undefined);
        void staged;
        const answer =
          `I've extracted ${source.tables.map((t) => t.tableName).join(", ")} and I'm handing off to the ` +
          `${plan.artifact === "ppt" ? "deck" : "dashboard"} builder…`;
        return reply({
          intent: "build", answer,
          handoff: {
            projectId: source.projectId,
            label: source.label,
            tables: source.tables,
            artifact: plan.artifact ?? "dashboard",
            buildPrompt: plan.buildPrompt?.trim() || prompt,
          },
        });
      } catch (err: any) {
        return reply({ intent: "build", answer: `I couldn't extract the tables for the build: ${err?.message ?? err}` });
      }
    }
  }
}

/** Run guarded SQL on the connection's live attach. One retry through a fresh
 *  handle when the cached one has died (dropped TCP, MySQL restart). */
async function runOnLiveAttach(rec: ConnRecord, sql: string, timeoutMs = QUERY_TIMEOUT_MS): Promise<Record<string, unknown>[]> {
  const attempt = async () => {
    const h = await getHandle(rec);
    // Query-class timeout race on top of the attach-level timeout. Note the
    // underlying statement may keep running server-side after the race loses —
    // acceptable for read-only capped queries; async cancellation is phase-3.
    return Promise.race([
      h.readAll(sql, "workbench query"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`query exceeded ${timeoutMs}ms`)), timeoutMs).unref?.()),
    ]);
  };
  try {
    return await attempt();
  } catch (err) {
    closeConnectionHandle(rec);
    return attempt();
  }
}

export { profileTables }; // re-export for the schema-expansion route, if added later
