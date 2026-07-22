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
  markExecution, openGroup, type ConnRecord, type GroupPart,
} from "../sources/connection-registry";
import { connFromParts, type DbConnParts } from "../sources/db-conn";
import {
  registerWorkbenchSource, getWorkbenchSource, wbSlug, wbDbPath,
  stagingDbPath, addStaged, getStaged, finalizeStaged, discardStaged, releaseInstance,
  type WorkbenchSource, type StagedState,
} from "../sources/workbench-store";
import { snapshotTables } from "../sources/db-conn";
import { COLO_PROJECT_ID, coloAvailable, coloProfiles, coloQuery } from "../sources/colo";
import { isWorkbenchProject, wbQuery, combineSources } from "../sources/workbench-store";
import { qid } from "../sources/mysql";
import { guardSelect } from "./guard";
import { runAnalystLoop, formatEvidenceDirective, compactEvidence, type AnalystRun } from "./analyst";
import { planSqlTurn, type PlanSqlRun, type SqlTurnPlan } from "./planner";
import { composeAnswer, composeFallback, type ComposeRun } from "./composer";
import type { Dataset } from "../../shared/types";
import { enrichColumns } from "../../shared/profile-enrich";
import { exactColumnStats } from "../sources/exact-stats";
import { duckTypeToColumnType } from "../sources/mysql";

const QUERY_MAX_ROWS = Number(process.env.T2SQL_QUERY_MAX_ROWS ?? 500);
const ROWS_TO_CLIENT = Number(process.env.T2SQL_ROWS_TO_CLIENT ?? 200);
// Query classes get their own timeouts (blueprint): previews must feel instant.
const PREVIEW_TIMEOUT_MS = Number(process.env.T2SQL_PREVIEW_TIMEOUT_MS ?? 10_000);
const QUERY_TIMEOUT_MS = Number(process.env.T2SQL_LIVE_QUERY_TIMEOUT_MS ?? 30_000);
// Analyst loop (al1): flag-gated, evaluated per call so tests can toggle it.
// Analysis queries run against the LIVE attach with a generous timeout (the
// user has accepted analysis latency in exchange for grounded dashboards).
const ANALYST_ENABLED = () => (process.env.T2SQL_ANALYST ?? "0") === "1";
const ANALYST_QUERY_TIMEOUT_MS = Number(process.env.T2SQL_ANALYST_QUERY_TIMEOUT_MS ?? 60_000);

export interface SqlHandlerDeps {
  plan?: PlanSqlRun;        // Gemini runner for the planner (tests inject a fake)
  compose?: ComposeRun;     // Gemini runner for the composer
  analyst?: AnalystRun;     // the analyst loop (tests inject a fake)
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
    // al3: addTo binds this database with an existing connection (or group) into
    // ONE group record — merged schema, one attach, cross-DB joins. The chat,
    // analyst, and live source then run over the union via the group's id.
    if (typeof b.addTo === "string" && b.addTo.trim()) {
      const base = getConnection(tenantId, b.addTo.trim());
      if (!base) return { status: 404, body: { error: "the connection to add to is unknown or expired — reconnect it first" } };
      const asPart = (r: ConnRecord): GroupPart[] =>
        r.groupParts?.length ? r.groupParts : [{ conn: r.conn, label: r.label, allTables: r.allTables, datasets: r.datasets }];
      const group = openGroup(tenantId, [...asPart(base), ...asPart(rec)]);
      console.log(`[text2sql] grouped ${group.groupParts!.length} databases as ${group.id}`);
      return { status: 200, body: publicView(group) };
    }
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
  // Windows lock discipline: if this conversation's stage was already published
  // and queried, the lazy query cache holds the file open — evict it before the
  // snapshot writer opens the same file (re-extract into the same stage).
  await releaseInstance(stagingDbPath(conversationId));
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
  } else if (projectId.startsWith(LIVE_PREFIX)) {
    // al2: live source — data questions answered straight from the live DB
    // through the same views the dashboard's widgets use.
    const rec = getConnection(tenantId, projectId.slice(LIVE_PREFIX.length));
    if (!rec) return { status: 410, body: { error: "live connection expired — reconnect to the database" } };
    tables = rec.datasets;
    runQuery = async (sql) => { await ensureLiveViews(rec); return runOnLiveAttach(rec, sql, 20_000); };
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
      // Analysis memory: build turns persist the compact evidence pack alongside
      // the usual sql breadcrumbs, so follow-up turns can see what was computed.
      briefJson: out.sql || out.analysis
        ? JSON.stringify({ intent: out.intent, sql: out.sql, executionMeta: out.executionMeta, policy: out.policy, ...(out.analysis ? { analysis: out.analysis } : {}) })
        : null,
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
      // Analyst loop (al1, flag-gated): BEFORE the snapshot, decompose the ask
      // into sub-questions and compute real findings from the LIVE attach —
      // grounding → analysis plan → parallel component agents → evidence pack.
      // The evidence rides the handoff as the spec planner's directive, so the
      // dashboard is designed around what the data actually says. Any failure
      // here falls back to the plain handoff (today's behavior, unchanged).
      let evidence: string | undefined;
      let analysis: ReturnType<typeof compactEvidence> | undefined;
      if (ANALYST_ENABLED() && rec.status !== "degraded") {
        try {
          const pack = await (deps.analyst ?? runAnalystLoop)({
            prompt, dialect: rec.conn.dialect, allTables: rec.allTables, datasets: rec.datasets, history,
            runQuery: (sql) => runOnLiveAttach(rec, sql, ANALYST_QUERY_TIMEOUT_MS),
          }, { plan: deps.plan, compose: deps.compose });
          if (pack && pack.findings.some((f) => f.ok)) {
            evidence = formatEvidenceDirective(pack);
            analysis = compactEvidence(pack);
            markExecution(rec, true);
          }
        } catch (err: any) {
          console.warn(`[analyst] failed -> plain build handoff: ${err?.message ?? err}`);
        }
      }
      // al2 (flag-gated): FULLY-LIVE source — skip storage entirely. Widgets
      // query the live DB through per-table views; nothing survives a restart.
      // Setup failure falls back to the snapshot path below (the product keeps
      // working; the log says why the live path was skipped).
      if (LIVE_SOURCE_ENABLED()) {
        try {
          const want = plan.tables?.length ? plan.tables : rec.datasets.map((d) => d.tableName);
          let liveDatasets = await profileTables(rec, want).catch(() => [] as Dataset[]);
          if (!liveDatasets.length) liveDatasets = rec.datasets;
          if (!liveDatasets.length) throw new Error("no profiled tables on this connection");
          // al3: analyst findings become live views (cross-DB joins included) so
          // the dashboard can render the joined numbers at runtime.
          let findingDatasets: Dataset[] = [];
          if (analysis) {
            findingDatasets = await materializeFindings(rec, analysis.findings as any).catch(() => [] as Dataset[]);
            if (findingDatasets.length && evidence) {
              evidence += `\nLIVE FINDING TABLES — each finding above is also available as a live table (a view that re-executes its query, joins included): ` +
                findingDatasets.map((d) => `${(d.profile.source.filename ?? "").replace("live finding: ", "")} → "${d.tableName}"`).join("; ") +
                `. PREFER these exact tables for widgets that should reproduce the findings.`;
            }
          }
          await ensureLiveViews(rec);
          liveDatasets = [...liveDatasets, ...findingDatasets];
          const okCount = analysis ? analysis.findings.filter((f) => f.ok).length : 0;
          const answer =
            (okCount ? `I ran ${okCount} analysis quer${okCount === 1 ? "y" : "ies"} against the live database and ` : "I've ") +
            `wired ${liveDatasets.map((t) => t.tableName).join(", ")} as a LIVE source — nothing is stored; the widgets ` +
            `query the database directly — handing off to the ${plan.artifact === "ppt" ? "deck" : "dashboard"} builder…`;
          return reply({
            intent: "build", answer,
            ...(analysis ? { analysis } : {}),
            handoff: {
              projectId: LIVE_PREFIX + rec.id,
              label: `${rec.label} (live)`,
              tables: liveDatasets.map((d) => ({ tableName: d.tableName, profile: d.profile })),
              artifact: plan.artifact ?? "dashboard",
              buildPrompt: plan.buildPrompt?.trim() || prompt,
              ...(evidence ? { evidence } : {}),
            },
          });
        } catch (err: any) {
          console.warn(`[live-source] setup failed -> falling back to snapshot: ${err?.message ?? err}`);
        }
      }
      // Snapshot next (production is read once for the artifact's runtime —
      // the rendered dashboard queries the durable snapshot, not the live DB),
      // then hand the client everything it needs to drive the EXISTING pipeline.
      try {
        const { staged } = await stageSnapshot(rec, plan.tables ?? [], tenantId, conversationId);
        const source = finalizeStaged(conversationId, plan.tables?.length ? `${rec.conn.database} (${plan.tables.join(", ")})` : undefined);
        void staged;
        const okCount = analysis ? analysis.findings.filter((f) => f.ok).length : 0;
        const answer =
          (okCount ? `I ran ${okCount} analysis quer${okCount === 1 ? "y" : "ies"} against the live database, then ` : "I've ") +
          `extracted ${source.tables.map((t) => t.tableName).join(", ")} and I'm handing off to the ` +
          `${plan.artifact === "ppt" ? "deck" : "dashboard"} builder…`;
        return reply({
          intent: "build", answer,
          ...(analysis ? { analysis } : {}),
          handoff: {
            projectId: source.projectId,
            label: source.label,
            tables: source.tables,
            artifact: plan.artifact ?? "dashboard",
            buildPrompt: plan.buildPrompt?.trim() || prompt,
            ...(evidence ? { evidence } : {}),
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

// ---- al2: fully-live sources ("live_<connectionId>") --------------------------------
// NOTHING is stored: the dashboard's compiled SQL (FROM "table") resolves through
// CREATE OR REPLACE VIEWs on the connection's in-memory attach, and every widget
// query runs against the LIVE database. The source dies with the connection
// (BFF restart / TTL) — by design; a 410 tells the client to reconnect.
export const LIVE_PREFIX = "live_";
const LIVE_SOURCE_ENABLED = () => (process.env.T2SQL_LIVE_SOURCE ?? "0") === "1";
const viewsApplied = new WeakMap<object, number>();

function liveViewDefs(rec: ConnRecord): { name: string; ref: string }[] {
  const refs = new Map(rec.allTables.map((t) => [t.name, t.ref] as const));
  return rec.datasets.flatMap((d) => {
    const ref = refs.get(d.tableName);
    return ref ? [{ name: d.tableName, ref }] : [];
  });
}

/** Idempotent per handle: a FRESH attach (retry after a dropped TCP) gets the
 *  views re-applied automatically before the next query runs. */
async function ensureLiveViews(rec: ConnRecord): Promise<void> {
  const h = await getHandle(rec);
  const version = rec.viewsVersion ?? 0;
  if (viewsApplied.get(h) === version) return;
  for (const v of liveViewDefs(rec)) {
    await h.run(`CREATE OR REPLACE VIEW main.${qid(v.name)} AS SELECT * FROM ${v.ref}`, 10_000, `live view ${v.name}`);
  }
  // al3: materialized analyst findings — live JOIN views (cross-DB included),
  // re-applied on fresh handles and re-issued whenever a build replaces them.
  for (const v of rec.extraViews ?? []) {
    await h.run(`CREATE OR REPLACE VIEW main.${qid(v.name)} AS ${v.sql}`, 10_000, `finding view ${v.name}`);
  }
  viewsApplied.set(h, version);
}

const viewSlug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "finding";

/** al3: turn each successful analyst finding into a LIVE view on the attach, so
 *  widgets can render cross-DB joined numbers at runtime (the view re-executes
 *  the join on every render — live, zero storage). Returns the view datasets
 *  (profiled from the live view) for the build handoff. Fail-soft per finding. */
async function materializeFindings(
  rec: ConnRecord,
  findings: { id: string; ok: boolean; question: string; sql: string }[],
): Promise<Dataset[]> {
  const h = await getHandle(rec);
  const out: Dataset[] = [];
  const defs: { name: string; sql: string }[] = [];
  const taken = new Set(rec.datasets.map((d) => d.tableName));
  for (const f of findings) {
    if (!f.ok) continue;
    let name = viewSlug(f.question);
    for (let n = 2; taken.has(name); n++) name = `${viewSlug(f.question)}_${n}`;
    try {
      await h.run(`CREATE OR REPLACE VIEW main.${qid(name)} AS ${f.sql}`, 15_000, `finding view ${name}`);
      const sample = await h.readAll(`SELECT * FROM main.${qid(name)} LIMIT 200`, `sample ${name}`);
      const cnt = await h.readAll(`SELECT count(*) AS n FROM main.${qid(name)}`, `count ${name}`);
      // Real column types from DESCRIBE (typeof-sniffing collapsed dates to
      // string → no min/max → no derived daterange filter for finding views).
      const desc = await h.readAll(`DESCRIBE main.${qid(name)}`, `describe ${name}`).catch(() => [] as Record<string, unknown>[]);
      const typeOf = new Map(desc.map((d) => [String((d as any).column_name), duckTypeToColumnType(String((d as any).column_type))]));
      const columns = Object.keys(sample[0] ?? {}).map((col) => ({
        name: col,
        type: typeOf.get(col) ?? (typeof sample[0]?.[col] === "number" ? "number" : "string"),
        nullable: sample.some((r) => r[col] == null),
        uniqueCount: new Set(sample.map((r) => String(r[col]))).size,
        sampleValues: sample.map((r) => r[col]).filter((v) => v != null).slice(0, 5),
      }));
      if (!columns.length) continue;
      taken.add(name);
      let enriched = enrichColumns(columns as any, sample);
      try { enriched = await exactColumnStats((q, l) => h.readAll(q, l ?? "stats"), `main.${qid(name)}`, enriched); } catch { /* floor stands */ }
      defs.push({ name, sql: f.sql });
      out.push({
        tableName: name,
        profile: {
          source: { filename: `live finding: ${f.id}`, format: "json" },
          rowCount: Number((cnt[0] as any)?.n ?? sample.length),
          columns: enriched as any,
          sampleRows: sample,
        },
      } as Dataset);
    } catch (err: any) {
      console.warn(`[live-source] finding view ${name} failed: ${err?.message ?? err}`);
    }
  }
  rec.extraViews = defs;
  rec.viewsVersion = (rec.viewsVersion ?? 0) + 1;
  return out;
}

/** Runtime executor for live sources — the /api/query branch for "live_…" ids.
 *  Guarded, capped, timed out, one fresh-handle retry (views re-applied). */
export async function liveQuery(
  tenantId: string,
  projectId: string,
  sql: string,
  opts: { rowCap?: number; timeoutMs?: number } = {},
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const connId = projectId.startsWith(LIVE_PREFIX) ? projectId.slice(LIVE_PREFIX.length) : projectId;
  const rec = getConnection(tenantId, connId);
  if (!rec) throw new Error("live connection expired — reconnect to the database and rebuild the dashboard");
  const rowCap = opts.rowCap ?? 10_000;
  const guarded = guardSelect(sql, rowCap);
  if (!guarded.ok) throw new Error(guarded.error);
  const timeoutMs = opts.timeoutMs ?? QUERY_TIMEOUT_MS;
  const attempt = async () => {
    await ensureLiveViews(rec);
    const h = await getHandle(rec);
    return Promise.race([
      h.readAll(guarded.sql, "live widget query"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`query exceeded ${timeoutMs}ms`)), timeoutMs).unref?.()),
    ]);
  };
  let rows: Record<string, unknown>[];
  try {
    rows = await attempt();
  } catch {
    closeConnectionHandle(rec);
    try { rows = await attempt(); } catch (err2) { markExecution(rec, false); throw err2; }
  }
  markExecution(rec, true);
  return { rows: rows.slice(0, rowCap), truncated: rows.length > rowCap };
}

export { profileTables }; // re-export for the schema-expansion route, if added later
