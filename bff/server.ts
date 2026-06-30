// server.ts — the BFF. Holds the AIFLOW key (via env), exposes POST /api/generate,
// and ties assemble() -> generateApp() together. No business logic beyond that.
//
// IMPORTANT: `import "dotenv/config"` must be FIRST so process.env is populated
// before aiflow.ts reads it at module load.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { assemble, assembleSummary, assemblePlan } from "./assembler";
import { scoreDomain, classifyDomain, buildEnrichment } from "./domain";
import { runWithMetrics, setPhase } from "./metrics";
import { callGemini, generateApp, generateAppStream, planApp, BUILD_OPTS, EDIT_OPTS, type GenOptions } from "./aiflow";
import { compileCss } from "./tailwind";
import { DuckDBStorage } from "./storage/duckdb";
import { PostgresStorage } from "./storage/postgres";
import { PROJECT_ID_RE, TABLE_NAME_RE, type StorageEngine, type TenantStorageEngine, type DatasetUpload } from "./storage/types";
import type { AssembleInput, DataProfile, Dataset, GeneratedApp } from "../shared/types";
import { convertToMarkdown, isDocumentFile } from "./markitdown";
import { buildExportZip, buildConnectedZip } from "./export";
import { generateReport } from "./report";
import { COLO_PROJECT_ID, COLO_LABEL, coloAvailable, coloProfiles, coloQuery } from "./sources/colo";
import { handleDashboardBuild } from "./dashboard/handler";
import { retrieveForBuild } from "./design-rag/build-context";
import { enrollGeneration } from "./design-rag/enroll";
import { generateDeck } from "./slides";
import { orchestrate, composePrompt, ORCHESTRATOR_ENABLED } from "./orchestrator";
import { getChatStore, type ChatStore } from "./chat-store";
import type { OrchestratorResult, ChatMessage } from "../shared/types";
import { parseAllowedOrigins, corsOptions, securityHeaders, validateConfig, applyConfigCheck } from "./security";
import { parseAuthTokens, authMiddleware, DEV_TENANT } from "./auth";
import { TenantScopedStorage } from "./storage/tenant-scope";
import { InMemoryRateLimiter, rateLimitConfigFromEnv, sendLimited, type RateLimiter } from "./ratelimit";
import { fileURLToPath } from "url";

// ---- storage (M1: embedded DuckDB; M2: Postgres adapter behind the same interface) ----
const STORAGE_KIND = (process.env.STORAGE ?? "duckdb").toLowerCase();
const STORAGE_PATH = process.env.STORAGE_PATH ?? "bff/data/text2ui.duckdb";
const QUERY_ROW_CAP = Number(process.env.QUERY_ROW_CAP ?? 10_000);
const QUERY_ROW_CAP_MAX = Number(process.env.QUERY_ROW_CAP_MAX ?? 200_000); // ceiling for explicit rowCap requests (project restore)
const QUERY_TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS ?? 15_000);
let _rawStorage: StorageEngine | null = null;
let _storage: TenantStorageEngine | null = null;
function getRawStorage(): StorageEngine {
  if (!_rawStorage) {
    if (STORAGE_KIND === "postgres") {
      if (!process.env.PG_URL) {
        throw new Error("STORAGE=postgres requires PG_URL (e.g. postgres://user:pass@localhost:5432/text2ui)");
      }
      _rawStorage = new PostgresStorage(process.env.PG_URL);
    } else if (STORAGE_KIND === "duckdb") {
      _rawStorage = new DuckDBStorage(STORAGE_PATH);
    } else {
      throw new Error(`unknown STORAGE "${STORAGE_KIND}" (use "duckdb" or "postgres")`);
    }
  }
  return _rawStorage;
}

/** Tenant-scoped storage facade — every call namespaces the project by tenant. */
export function getStorage(): TenantStorageEngine {
  if (!_storage) _storage = new TenantScopedStorage(getRawStorage());
  return _storage;
}

let _rateLimiter: RateLimiter | null = null;
export function getRateLimiter(): RateLimiter {
  if (!_rateLimiter) _rateLimiter = new InMemoryRateLimiter(rateLimitConfigFromEnv());
  return _rateLimiter;
}

type GenerateFn = typeof generateApp;

function isProfile(p: any): boolean {
  return !!p && typeof p === "object" && Array.isArray(p.columns);
}

/** Pick the SQL dialect the generated app should target. It must match the engine
 *  that will actually run the queries. The per-project store may be Postgres, but
 *  "colo data" is always served from the DuckDB snapshot (via coloQuery), so a colo
 *  build must use DuckDB SQL regardless of STORAGE. Colo datasets are tagged with a
 *  `view:` source label by the model builder, which is how we recognize them here. */
function dialectFor(input: AssembleInput): "duckdb" | "postgres" {
  const ds = input.datasets ?? [];
  const allColoViews = ds.length > 0 && ds.every(
    (d) => (d.profile?.source?.filename ?? "").startsWith("view:"),
  );
  return allColoViews ? "duckdb" : getStorage().dialect;
}

/** Validate an untrusted request body into an AssembleInput. */
function validateInput(body: any): { ok: true; input: AssembleInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const { datasets, profile, userPrompt, currentCode, lastError, dataAccess } = body;
  if (dataAccess !== undefined && dataAccess !== "inline" && dataAccess !== "remote") {
    return { ok: false, error: 'dataAccess must be "inline" or "remote"' };
  }

  let ds: Dataset[];
  if (Array.isArray(datasets) && datasets.length) {
    for (const d of datasets) {
      if (!d || typeof d.tableName !== "string" || !d.tableName.trim() || !isProfile(d.profile)) {
        return { ok: false, error: "each dataset needs { tableName, profile.columns[] }" };
      }
    }
    ds = datasets;
  } else if (isProfile(profile)) {
    ds = [{ tableName: "data", profile }]; // back-compat: single profile -> table "data"
  } else {
    return { ok: false, error: "datasets[] (each with tableName + profile.columns[]) is required" };
  }

  if (typeof userPrompt !== "string") return { ok: false, error: "userPrompt must be a string" };
  if (!lastError && !userPrompt.trim()) return { ok: false, error: "userPrompt is required for a build/edit turn" };
  if (currentCode !== undefined && typeof currentCode !== "string") return { ok: false, error: "currentCode must be a string" };
  if (lastError !== undefined && typeof lastError !== "string") return { ok: false, error: "lastError must be a string" };
  return { ok: true, input: { datasets: ds, userPrompt, currentCode, lastError, dataAccess } };
}

/** Pure handler — generate fn is injectable so the route is testable without the network. */
export async function handleGenerate(
  body: unknown,
  generate: GenerateFn = generateApp,
  plan: (s: string, u: string) => Promise<string | null> = (s, u) => planApp(s, u),
): Promise<{ status: number; body: any }> {
  const v = validateInput(body);
  if (!v.ok) return { status: 400, body: { error: v.error } };

  const { result, metrics } = await runWithMetrics(async () => {
    // The model must speak the dialect of whatever engine will execute its SQL.
    // Server decides — never trusted from the client.
    if (v.input.dataAccess === "remote") v.input.sqlDialect = dialectFor(v.input);
    // Phase 3: best-effort design plan on build turns (mutates v.input.plan).
    await runPlanForBuild(v.input, plan);
    // Design Retrieval (flag-gated, build-turn only): inject retrieved design
    // references as notes (into the prompt) + images (to the model call).
    // EMPTY -> the build uses the text exemplar exactly as before.
    const refs = await retrieveForBuild(v.input);
    v.input.referenceBlock = refs.referenceBlock;
    const { system_prompt, user_prompt } = assemble(v.input);

    try {
      setPhase(v.input.lastError ? "heal" : v.input.currentCode ? "edit" : "build");
      const app = await generate(system_prompt, user_prompt, undefined, optsForTurn(body), refs.images);
      // Flywheel: on a successful BUILD, async-enroll if it clears the eval gate.
      // Fire-and-forget — never blocks the response; no-op when the flag is off.
      if (!v.input.currentCode && !v.input.lastError) {
        const enrollDomain = buildEnrichment(v.input.datasets, v.input.modelDomain).domain;
        void enrollGeneration(app, v.input.datasets, enrollDomain, { exemplarCode: refs.referenceBlock || undefined, source: (body as any)?.enrollSource }).catch(() => {});
      }
      const withCss = await compileForBuild(v.input, app);
      return { status: 200, body: withCss as any };
    } catch (err: any) {
      const msg = err?.message ?? "unknown error";
      // A truncated payload surfaces as a parse failure here. Until we confirm the
      // workflow's max-output-tokens, surface it clearly rather than shipping a
      // broken app. CONTINUE-PASS SEAM: if the cap is low, retry/continue here.
      const looksTruncated = /not JSON|files\[\]|Unexpected end/.test(msg);
      const hint = looksTruncated
        ? " (output may have been truncated — check the workflow's max-output-tokens)"
        : "";
      return { status: 502, body: { error: `generation failed: ${msg}${hint}` } };
    }
  });

  // Attach the cost/latency summary to successful responses (non-breaking extra field).
  if (result.status === 200) {
    result.body = { ...result.body, metrics };
    const phases = Object.entries(metrics.byPhase).map(([p, a]) => `${p}:${a.calls}`).join(" ");
    console.log(
      `[metrics] ${metrics.calls} call(s) ${metrics.ms}ms | ` +
      `in=${metrics.inputTokens} out=${metrics.outputTokens} tot=${metrics.totalTokens} tok | ` +
      `~$${metrics.costUsd.toFixed(5)} | ${phases} | ${metrics.model}`,
    );
  }
  return result;
}

/** Pure handler for POST /api/report — the PDF pipeline. `run` is injectable for tests. */
export async function handleGenerateReport(
  body: unknown,
  run?: (s: string, u: string) => Promise<string>,
): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  if (!Array.isArray(b.datasets) || !b.datasets.length) return { status: 400, body: { error: "datasets[] is required" } };
  if (typeof b.userPrompt !== "string" || !b.userPrompt.trim()) return { status: 400, body: { error: "userPrompt is required" } };
  for (const d of b.datasets) {
    if (!d || typeof d.tableName !== "string" || !d.profile || !Array.isArray(d.profile.columns)) {
      return { status: 400, body: { error: "each dataset needs { tableName, profile.columns[] }" } };
    }
  }
  const { result, metrics } = await runWithMetrics(async () => {
    try {
      setPhase("build");
      const { doc, pdf } = await generateReport(
        {
          datasets: b.datasets as Dataset[],
          userPrompt: b.userPrompt,
          docContext: typeof b.docContext === "string" ? b.docContext : undefined,
        },
        run,
      );
      return { status: 200, body: { mode: "pdf", filename: reportSlug(doc.title) + ".pdf", pdfBase64: pdf.toString("base64"), doc } as any };
    } catch (err: any) {
      return { status: 502, body: { error: `report generation failed: ${err?.message ?? "unknown error"}` } };
    }
  });
  if (result.status === 200) result.body = { ...result.body, metrics };
  return result;
}

function reportSlug(title: string): string {
  return (title || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
}

/** Pure handler for POST /api/ppt — the slide-deck pipeline. `run` is injectable for tests. */
export async function handleGeneratePpt(
  body: unknown,
  run?: (s: string, u: string) => Promise<string>,
): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  if (!Array.isArray(b.datasets) || !b.datasets.length) return { status: 400, body: { error: "datasets[] is required" } };
  if (typeof b.userPrompt !== "string" || !b.userPrompt.trim()) return { status: 400, body: { error: "userPrompt is required" } };
  for (const d of b.datasets) {
    if (!d || typeof d.tableName !== "string" || !d.profile || !Array.isArray(d.profile.columns)) {
      return { status: 400, body: { error: "each dataset needs { tableName, profile.columns[] }" } };
    }
  }
  const { result, metrics } = await runWithMetrics(async () => {
    try {
      setPhase("build");
      const { doc, pptx } = await generateDeck(
        {
          datasets: b.datasets as Dataset[],
          userPrompt: b.userPrompt,
          docContext: typeof b.docContext === "string" ? b.docContext : undefined,
        },
        run,
      );
      return { status: 200, body: { mode: "ppt", filename: reportSlug(doc.title) + ".pptx", pptxBase64: pptx.toString("base64"), doc } as any };
    } catch (err: any) {
      return { status: 502, body: { error: `deck generation failed: ${err?.message ?? "unknown error"}` } };
    }
  });
  if (result.status === 200) result.body = { ...result.body, metrics };
  return result;
}

/** Pure handler for POST /api/chat — the orchestrator front door (Phase 1).
 *  Runs the planner, then dispatches to the existing pipeline for the chosen
 *  mode with the enhanced prompt. Flag-gated; degrades to a raw dashboard build
 *  when disabled, when the planner asks nothing useful, or on any failure. All
 *  collaborators are injectable for tests. */
export interface ChatDeps {
  orchestrateFn?: (input: { datasets: any[]; userPrompt: string; history?: ChatMessage[] }) => Promise<OrchestratorResult | null>;
  generate?: (body: unknown) => Promise<{ status: number; body: any }>;
  report?: (body: unknown) => Promise<{ status: number; body: any }>;
  ppt?: (body: unknown) => Promise<{ status: number; body: any }>;
  enabled?: boolean;
  chatStore?: ChatStore;
}

export async function handleChat(body: unknown, deps: ChatDeps = {}): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  if (!Array.isArray(b.datasets) || !b.datasets.length) return { status: 400, body: { error: "datasets[] is required" } };
  if (typeof b.userPrompt !== "string" || !b.userPrompt.trim()) return { status: 400, body: { error: "userPrompt is required" } };

  const enabled = deps.enabled ?? ORCHESTRATOR_ENABLED;
  const generate = deps.generate ?? ((x) => handleGenerate(x));
  const report = deps.report ?? ((x) => handleGenerateReport(x));
  const ppt = deps.ppt ?? ((x) => handleGeneratePpt(x));
  const store = deps.chatStore ?? getChatStore();

  // Conversation memory (best-effort: a store failure degrades to no memory,
  // never breaks the build). Load prior turns, thread them in, persist this turn.
  let conversationId: string = typeof b.conversationId === "string" ? b.conversationId : "";
  let history: ChatMessage[] = Array.isArray(b.history) ? b.history : [];
  try {
    if (conversationId) history = await store.getHistory(conversationId);
    else conversationId = await store.createConversation(b.userPrompt.slice(0, 80));
    await store.appendMessage(conversationId, { role: "user", content: b.userPrompt });
  } catch (e) { console.warn(`[chat] memory unavailable: ${(e as Error).message}`); }

  const persistAssistant = async (content: string, brief?: any) => {
    try { await store.appendMessage(conversationId, { role: "assistant", content, briefJson: brief ? JSON.stringify(brief) : null, outputMode: brief?.outputMode ?? null }); } catch { /* best-effort */ }
  };
  const withConv = (res: { status: number; body: any }) => {
    if (res.status === 200 && res.body && typeof res.body === "object") res.body = { ...res.body, conversationId };
    return res;
  };

  if (!enabled) { const r = await generate(b); await persistAssistant("Built dashboard"); return withConv(r); }

  const orchestrateFn = deps.orchestrateFn ?? ((input) => orchestrate(input));
  const result = await orchestrateFn({ datasets: b.datasets, userPrompt: b.userPrompt, history });

  if (result && "needsClarification" in result) {
    await persistAssistant(result.question);
    return { status: 200, body: { conversationId, needsClarification: true, question: result.question } };
  }
  if (!result) { const r = await generate(b); await persistAssistant("Built dashboard"); return withConv(r); }

  const rewritten = { ...b, userPrompt: composePrompt(result) };
  const dispatch = result.outputMode === "pdf" ? report : result.outputMode === "ppt" ? ppt : generate;
  const res = await dispatch(rewritten);
  if (res.status === 200 && res.body && typeof res.body === "object") res.body = { ...res.body, brief: result, conversationId };
  await persistAssistant(result.title ?? `Built ${result.outputMode}`, result);
  return res;
}

/** Pure handler for POST /api/orchestrate — plan only (Phase 4 streaming UI).
 *  Runs the planner, persists the turn, and returns the brief + composed prompt
 *  so the client can drive the EXISTING streaming build endpoint per turn. The
 *  build itself is not done here. Degrades to a raw dashboard plan when the
 *  orchestrator is off, asks nothing useful, or fails. */
export interface OrchestrateDeps {
  orchestrateFn?: (input: { datasets: any[]; userPrompt: string; history?: ChatMessage[] }) => Promise<OrchestratorResult | null>;
  enabled?: boolean;
  chatStore?: ChatStore;
}

export async function handleOrchestrate(body: unknown, deps: OrchestrateDeps = {}): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  if (!Array.isArray(b.datasets) || !b.datasets.length) return { status: 400, body: { error: "datasets[] is required" } };
  if (typeof b.userPrompt !== "string" || !b.userPrompt.trim()) return { status: 400, body: { error: "userPrompt is required" } };

  const enabled = deps.enabled ?? ORCHESTRATOR_ENABLED;
  const store = deps.chatStore ?? getChatStore();
  console.log(`[orchestrate] in: datasets=${b.datasets.length} prompt="${String(b.userPrompt).slice(0, 60)}" enabled=${enabled} conv=${b.conversationId || "(new)"}`);

  let conversationId: string = typeof b.conversationId === "string" ? b.conversationId : "";
  let history: ChatMessage[] = Array.isArray(b.history) ? b.history : [];
  try {
    if (conversationId) history = await store.getHistory(conversationId);
    else conversationId = await store.createConversation(b.userPrompt.slice(0, 80));
    await store.appendMessage(conversationId, { role: "user", content: b.userPrompt });
  } catch (e) { console.warn(`[orchestrate] memory unavailable: ${(e as Error).message}`); }

  const persist = async (content: string, brief?: any) => {
    try { await store.appendMessage(conversationId, { role: "assistant", content, briefJson: brief ? JSON.stringify(brief) : null, outputMode: brief?.outputMode ?? null }); } catch { /* best-effort */ }
  };
  // Fallback plan: build a dashboard from the raw prompt (mirrors flag-off / failure).
  const rawPlan = { status: 200, body: { conversationId, outputMode: "dashboard", enhancedPrompt: b.userPrompt } };

  if (!enabled) { console.log("[orchestrate] flag off -> raw dashboard plan"); return rawPlan; }

  const orchestrateFn = deps.orchestrateFn ?? ((input) => orchestrate(input));
  const result = await orchestrateFn({ datasets: b.datasets, userPrompt: b.userPrompt, history });

  if (result && "needsClarification" in result) {
    console.log("[orchestrate] -> needsClarification");
    await persist(result.question);
    return { status: 200, body: { conversationId, needsClarification: true, question: result.question } };
  }
  if (!result) { console.log("[orchestrate] planner returned null -> raw dashboard plan"); return rawPlan; }

  console.log(`[orchestrate] -> mode=${result.outputMode} title="${result.title}"`);
  await persist(result.title ?? `Plan: ${result.outputMode}`, result);
  return { status: 200, body: { conversationId, brief: result, outputMode: result.outputMode, enhancedPrompt: composePrompt(result) } };
}

/** Pure handler for POST /api/datasets — storage is injectable for tests. */
export async function handleDatasets(
  body: unknown,
  tenantId: string,
  storage: TenantStorageEngine = getStorage(),
): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  const { projectId, datasets } = b;
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    return { status: 400, body: { error: "projectId must match " + PROJECT_ID_RE.source } };
  }
  if (!Array.isArray(datasets)) return { status: 400, body: { error: "datasets[] is required" } };
  for (const d of datasets) {
    if (!d || typeof d.tableName !== "string" || !TABLE_NAME_RE.test(d.tableName)) {
      return { status: 400, body: { error: "each dataset needs a valid tableName" } };
    }
    if (typeof d.filename !== "string" || !Array.isArray(d.rows) || !d.profile) {
      return { status: 400, body: { error: "each dataset needs { tableName, filename, profile, rows[] }" } };
    }
  }
  try {
    const meta = await storage.replaceDatasets(tenantId, projectId, datasets as DatasetUpload[]);
    return { status: 200, body: { datasets: meta } };
  } catch (err: any) {
    return { status: 500, body: { error: `storing datasets failed: ${err?.message ?? "unknown error"}` } };
  }
}

// Wave 0 / N2a: convert an uploaded document (PDF/Word/PPT/...) to Markdown for
// use as build CONTEXT. The browser sends { filename, dataBase64 }; we forward
// the bytes to the markitdown sidecar. Best-effort: a sidecar that's down/slow
// returns 503 and the client simply proceeds without document context.
export async function handleConvertDoc(
  body: unknown,
): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  const { filename, dataBase64 } = b;
  if (typeof filename !== "string" || !filename.trim()) {
    return { status: 400, body: { error: "filename is required" } };
  }
  if (typeof dataBase64 !== "string" || !dataBase64) {
    return { status: 400, body: { error: "dataBase64 is required" } };
  }
  if (!isDocumentFile(filename)) {
    return { status: 415, body: { error: `not a supported document type: ${filename}` } };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(dataBase64, "base64"));
  } catch {
    return { status: 400, body: { error: "dataBase64 is not valid base64" } };
  }
  if (bytes.length === 0) return { status: 400, body: { error: "empty file" } };

  const result = await convertToMarkdown(bytes, filename);
  if (!result) {
    // null = sidecar unreachable, timed out, or couldn't convert. Tell the client
    // it's optional so it can proceed with the build regardless.
    return {
      status: 503,
      body: { error: "document conversion unavailable", optional: true },
    };
  }
  return { status: 200, body: result };
}

// Wave 1 / N5: scaffold the generated app into a complete, runnable Vite project
// and return it as a downloadable zip. Stateless: the client sends the generated
// app + (for inline mode) the table rows it already holds. Returns either a JSON
// error or the zip bytes (the route sends binary on ok).
export type ExportResult =
  | { ok: false; status: number; error: string }
  | { ok: true; filename: string; zip: Buffer };

export async function handleExport(body: unknown): Promise<ExportResult> {
  const b = body as any;
  if (!b || typeof b !== "object") return { ok: false, status: 400, error: "body must be a JSON object" };
  const { app, tables, appName, dataMode, remote } = b;
  if (!app || !Array.isArray(app.files) || app.files.length === 0) {
    return { ok: false, status: 400, error: "app.files[] is required" };
  }
  try {
    const built =
      b.bundle === "connected"
        ? await buildConnectedZip({ app, tables, appName, dataMode, remote })
        : await buildExportZip({ app, tables, appName, dataMode, remote });
    return { ok: true, filename: built.filename, zip: built.zip };
  } catch (err: any) {
    // scaffoldProject throws on bad input (missing tables for inline, etc.) -> 400.
    return { ok: false, status: 400, error: err?.message ?? "export failed" };
  }
}

/** Pure handler for POST /api/query — read-only, row-capped, timed out. */
export async function handleQuery(
  body: unknown,
  tenantId: string,
  storage: TenantStorageEngine = getStorage(),
): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  const { projectId, sql, rowCap } = b;
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    return { status: 400, body: { error: "projectId must match " + PROJECT_ID_RE.source } };
  }
  if (typeof sql !== "string" || !sql.trim()) return { status: 400, body: { error: "sql is required" } };
  const cap = typeof rowCap === "number" && rowCap > 0 ? Math.min(Math.floor(rowCap), QUERY_ROW_CAP_MAX) : QUERY_ROW_CAP;
  // "colo data": query the curated snapshot directly instead of a per-project store.
  if (projectId === COLO_PROJECT_ID) {
    try {
      const result = await coloQuery(sql, { rowCap: cap, timeoutMs: QUERY_TIMEOUT_MS });
      return { status: 200, body: result };
    } catch (err: any) {
      console.warn(`[colo] query failed: ${err?.message ?? err}\n  SQL: ${sql}`);
      return { status: 400, body: { error: err?.message ?? "query failed" } };
    }
  }
  try {
    const result = await storage.query(tenantId, projectId, sql, { rowCap: cap, timeoutMs: QUERY_TIMEOUT_MS });
    return { status: 200, body: result };
  } catch (err: any) {
    // guard rejections and SQL errors are client errors, not server faults
    return { status: 400, body: { error: err?.message ?? "query failed" } };
  }
}


/** Pure handler for POST /api/summary — Feature Inspector summaries. */
export async function handleSummary(
  body: unknown,
  run: (s: string, u: string) => Promise<{ text: string; finishReason: string }> = callGemini,
): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  const { projectId, tableName, profile, featureTitle, featureType, featureDetails, query } = b;
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    return { status: 400, body: { error: "projectId must match " + PROJECT_ID_RE.source } };
  }
  if (typeof tableName !== "string" || !tableName.trim()) {
    return { status: 400, body: { error: "tableName is required" } };
  }
  if (!profile || typeof profile !== "object" || typeof profile.rowCount !== "number" || !Array.isArray(profile.columns)) {
    return { status: 400, body: { error: "profile must be a valid DataProfile" } };
  }

  try {
    const { system_prompt, user_prompt } = assembleSummary(tableName, profile as DataProfile, {
      featureTitle,
      featureType,
      featureDetails,
      query,
    });
    const result = await run(system_prompt, user_prompt);
    return { status: 200, body: { summary: result.text.trim() } };
  } catch (err: any) {
    return { status: 500, body: { error: `summary generation failed: ${err?.message ?? "unknown error"}` } };
  }
}



/** Build turns get reasoning + warmth; edit/self-heal turns stay cold and fast. */
function optsForTurn(body: any): GenOptions {
  const isBuild = !body?.currentCode && !body?.lastError;
  return isBuild ? BUILD_OPTS : EDIT_OPTS;
}

/** A turn is a BUILD when there's no existing code and no error to fix. The
 *  Phase-3 plan pass runs on build turns only (edits/heals already have code). */
function isBuildTurn(input: AssembleInput): boolean {
  return !input.currentCode && !input.lastError;
}

/** Best-effort design-plan pass for a build turn. Returns the plan text (also
 *  mutates input.plan so the subsequent assemble() injects it), or null when
 *  skipped/failed. Never throws — a missing plan just means a planless build. */
async function runPlanForBuild(
  input: AssembleInput,
  plan: (s: string, u: string) => Promise<string | null> = (s, u) => planApp(s, u),
): Promise<string | null> {
  if (!isBuildTurn(input)) return null;
  // Wave 3 / N4: model-based detection fallback. When rule scoring isn't
  // confident, ask the (injected) plan model to self-classify the schema so the
  // plan + build get the right domain prior/exemplar instead of falling to
  // generic. Best-effort, build turns only, and only when rules are unsure —
  // confident rule hits stay free and deterministic.
  if (!input.modelDomain && !scoreDomain(input.datasets).confident) {
    setPhase("classify");
    const md = await classifyDomain(input.datasets, (s, u) => plan(s, u).then((t) => t ?? ""));
    if (md) input.modelDomain = md;
  }
  setPhase("plan");
  const { system_prompt, user_prompt } = assemblePlan(input.datasets, input.userPrompt, input.modelDomain);
  const text = await plan(system_prompt, user_prompt);
  if (text) input.plan = text;
  return text;
}

/** Best-effort: compile Tailwind CSS for a freshly BUILT app and attach it to
 *  app.css, so the sandbox styles from compiled CSS instead of the racy CDN.
 *  Build turns only — edits/heals keep the build's CSS (most edits reuse its
 *  class vocabulary; recompiling every edit would add latency for little gain).
 *  On compile failure, app.css stays undefined and the sandbox uses the CDN. */
async function compileForBuild(
  input: AssembleInput,
  app: GeneratedApp,
  compile: (files: GeneratedApp["files"]) => Promise<string | null> = compileCss,
): Promise<GeneratedApp> {
  if (!isBuildTurn(input)) return app;
  const css = await compile(app.files);
  return css ? { ...app, css } : app;
}

/** Validate + prep for the streaming route. Returns the validated AssembleInput
 *  (dialect stamped) so the route can interleave the Phase-3 plan stage before
 *  assembling. Assembly itself happens after the plan, in the route. */
function prepareGenerate(body: unknown): { ok: true; input: AssembleInput } | { ok: false; error: string } {
  const v = validateInput(body);
  if (!v.ok) return { ok: false, error: v.error };
  if (v.input.dataAccess === "remote") v.input.sqlDialect = dialectFor(v.input);
  return { ok: true, input: v.input };
}

/** M3 — project persistence handlers (storage injectable for tests). */
export async function handleUpsertProject(body: unknown, tenantId: string, storage: TenantStorageEngine = getStorage()) {
  const b = body as any;
  if (!b || typeof b.projectId !== "string" || !PROJECT_ID_RE.test(b.projectId)) {
    return { status: 400, body: { error: "projectId must match " + PROJECT_ID_RE.source } };
  }
  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120) {
    return { status: 400, body: { error: "name (1-120 chars) is required" } };
  }
  try {
    await storage.upsertProject(tenantId, b.projectId, b.name.trim());
    return { status: 200, body: { ok: true } };
  } catch (err: any) {
    return { status: 500, body: { error: err?.message ?? "saving project failed" } };
  }
}

export async function handleSaveVersion(projectId: string, body: unknown, tenantId: string, storage: TenantStorageEngine = getStorage()) {
  if (!PROJECT_ID_RE.test(projectId)) return { status: 400, body: { error: "invalid projectId" } };
  const b = body as any;
  if (!b || typeof b.num !== "number" || b.num < 1 || typeof b.label !== "string" || !b.app?.files) {
    return { status: 400, body: { error: "version needs { num >= 1, label, app: GeneratedApp }" } };
  }
  try {
    await storage.saveVersion(tenantId, projectId, { num: Math.floor(b.num), label: b.label, app: b.app });
    return { status: 200, body: { ok: true } };
  } catch (err: any) {
    return { status: 500, body: { error: err?.message ?? "saving version failed" } };
  }
}

// ---- HTTP wiring ----
function requireEnv() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing env var GEMINI_API_KEY. Put it in a server-side .env (gitignored).");
  }
}

export function createServer() {
  const app = express();
  app.use(cors(corsOptions(parseAllowedOrigins(process.env.ALLOWED_ORIGINS))));
  app.use(securityHeaders());
  app.use(express.json({ limit: process.env.BODY_LIMIT ?? "64mb" })); // dataset rows travel once at upload

  // P8: bearer-token-per-tenant auth on the API surface (/health stays open for liveness).
  app.use("/api", authMiddleware(parseAuthTokens(process.env.AUTH_TOKENS)));

  // P8: per-tenant request-rate limit (disabled unless RATE_LIMIT_MAX is set).
  app.use("/api", (req, res, next) => {
    const d = getRateLimiter().checkRequest(req.tenantId ?? DEV_TENANT);
    if (!d.allowed) return sendLimited(res, d);
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/generate", async (req, res) => {
    const tenant = req.tenantId ?? DEV_TENANT;
    const q = getRateLimiter().checkQuota(tenant);
    if (!q.allowed) return sendLimited(res, q);
    const { status, body } = await handleGenerate(req.body);
    if (status === 200 && body?.metrics) getRateLimiter().recordUsage(tenant, { tokens: body.metrics.totalTokens, costUsd: body.metrics.costUsd });
    res.status(status).json(body);
  });

  app.post("/api/report", async (req, res) => {
    const tenant = req.tenantId ?? DEV_TENANT;
    const q = getRateLimiter().checkQuota(tenant);
    if (!q.allowed) return sendLimited(res, q);
    const { status, body } = await handleGenerateReport(req.body);
    if (status === 200 && body?.metrics) getRateLimiter().recordUsage(tenant, { tokens: body.metrics.totalTokens, costUsd: body.metrics.costUsd });
    res.status(status).json(body);
  });

  app.post("/api/chat", async (req, res) => {
    const tenant = req.tenantId ?? DEV_TENANT;
    const q = getRateLimiter().checkQuota(tenant);
    if (!q.allowed) return sendLimited(res, q);
    const { status, body } = await handleChat(req.body);
    if (status === 200 && body?.metrics) getRateLimiter().recordUsage(tenant, { tokens: body.metrics.totalTokens, costUsd: body.metrics.costUsd });
    res.status(status).json(body);
  });

  app.post("/api/orchestrate", async (req, res) => {
    const tenant = req.tenantId ?? DEV_TENANT;
    const q = getRateLimiter().checkQuota(tenant);
    if (!q.allowed) return sendLimited(res, q);
    const { status, body } = await handleOrchestrate(req.body);
    res.status(status).json(body);
  });

  app.get("/api/conversations", async (_req, res) => {
    try { res.json({ conversations: await getChatStore().listConversations() }); }
    catch (e) { res.status(200).json({ conversations: [], error: (e as Error).message }); }
  });

  app.get("/api/conversations/:id", async (req, res) => {
    try { res.json({ id: req.params.id, messages: await getChatStore().getHistory(req.params.id, 200) }); }
    catch (e) { res.status(200).json({ id: req.params.id, messages: [], error: (e as Error).message }); }
  });

  app.post("/api/ppt", async (req, res) => {
    const tenant = req.tenantId ?? DEV_TENANT;
    const q = getRateLimiter().checkQuota(tenant);
    if (!q.allowed) return sendLimited(res, q);
    const { status, body } = await handleGeneratePpt(req.body);
    if (status === 200 && body?.metrics) getRateLimiter().recordUsage(tenant, { tokens: body.metrics.totalTokens, costUsd: body.metrics.costUsd });
    res.status(status).json(body);
  });

  // Streaming generate: Server-Sent Events. Every event the client renders
  // corresponds to a real pipeline moment (model call, code chunks, continuation,
  // validation) — no simulated progress.
  app.post("/api/generate/stream", async (req, res) => {
    const prep = prepareGenerate(req.body);
    console.log(`[stream] start: ok=${prep.ok} datasets=${Array.isArray(req.body?.datasets) ? req.body.datasets.length : "?"} edit=${!!req.body?.currentCode} heal=${!!req.body?.lastError}`);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const send = (ev: unknown) => {
      const t = (ev as any)?.type;
      console.log(`[stream] → ${t}${t === "stage" ? ` (${(ev as any).stage})` : ""}${t === "error" ? `: ${(ev as any).error}` : ""}`);
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    if (!prep.ok) {
      console.warn(`[stream] bad input: ${prep.error}`);
      send({ type: "error", error: prep.error });
      return res.end();
    }
    try {
      // Phase 3: design-plan pass on build turns, surfaced in the journey. The
      // "planning" stage shows first; if a plan comes back, its text streams as
      // a plan event so the user sees the blueprint. Best-effort — on skip/fail
      // the build proceeds with no plan and no stall.
      if (isBuildTurn(prep.input)) {
        send({ type: "stage", stage: "planning" });
        const planText = await runPlanForBuild(prep.input);
        if (planText) send({ type: "plan", text: planText });
      }
      const built = await retrieveForBuild(prep.input);
      prep.input.referenceBlock = built.referenceBlock;
      const { system_prompt, user_prompt } = assemble(prep.input);
      const app_ = await generateAppStream(system_prompt, user_prompt, send, undefined, optsForTurn(req.body), built.images);
      if (isBuildTurn(prep.input)) {
        const enrollDomain = buildEnrichment(prep.input.datasets, prep.input.modelDomain).domain;
        void enrollGeneration(app_, prep.input.datasets, enrollDomain, { exemplarCode: built.referenceBlock || undefined }).catch(() => {});
      }
      // Build turns: compile Tailwind from the finished source (kills the CDN
      // render race). Best-effort — on failure app_.css stays undefined and the
      // sandbox falls back to the CDN.
      let finalApp = app_;
      if (isBuildTurn(prep.input)) {
        send({ type: "stage", stage: "styling" });
        finalApp = await compileForBuild(prep.input, app_);
      }
      send({ type: "done", app: finalApp });
    } catch (err: any) {
      send({ type: "error", error: err?.message ?? "generation failed" });
    }
    res.end();
  });

  app.post("/api/datasets", async (req, res) => {
    const { status, body } = await handleDatasets(req.body, req.tenantId ?? DEV_TENANT);
    res.status(status).json(body);
  });

  app.post("/api/convert-doc", async (req, res) => {
    const { status, body } = await handleConvertDoc(req.body);
    res.status(status).json(body);
  });

  app.post("/api/export", async (req, res) => {
    const r = await handleExport(req.body);
    if (!r.ok) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${r.filename}"`);
    res.send(r.zip);
  });

  app.get("/api/datasets/:projectId", async (req, res) => {
    const projectId = String(req.params.projectId);
    if (!PROJECT_ID_RE.test(projectId)) return res.status(400).json({ error: "invalid projectId" });
    try {
      res.json({ datasets: await getStorage().listDatasets(req.tenantId ?? DEV_TENANT, projectId) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "listing failed" });
    }
  });

  app.post("/api/query", async (req, res) => {
    const { status, body } = await handleQuery(req.body, req.tenantId ?? DEV_TENANT);
    res.status(status).json(body);
  });

  // Spec-driven dashboard build (planner → validate/compile → deterministic render).
  // Returns { app, spec, warnings }; the client persists `spec` and sends it back as
  // currentSpec next turn so each prompt edits the same dashboard.
  app.post("/api/dashboard/build", async (req, res) => {
    const { status, body } = await handleDashboardBuild(req.body);
    res.status(status).json(body);
  });

  // Named backend data sources (currently just the colo snapshot). The frontend
  // calls this to offer "colo data" and to load its view profiles for the planner.
  app.get("/api/sources", async (_req, res) => {
    try {
      if (!coloAvailable()) return res.json({ sources: [] });
      const tables = await coloProfiles();
      res.json({
        sources: [{ id: "colo", label: COLO_LABEL, projectId: COLO_PROJECT_ID, tables }],
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "failed to load sources" });
    }
  });

  app.post("/api/summary", async (req, res) => {
    const { status, body } = await handleSummary(req.body);
    res.status(status).json(body);
  });

  // ---- M3: projects ----
  app.get("/api/projects", async (req, res) => {
    try {
      res.json({ projects: await getStorage().listProjects(req.tenantId ?? DEV_TENANT) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "listing projects failed" });
    }
  });

  app.get("/api/projects/:projectId", async (req, res) => {
    const projectId = String(req.params.projectId);
    if (!PROJECT_ID_RE.test(projectId)) return res.status(400).json({ error: "invalid projectId" });
    try {
      const found = await getStorage().getProject(req.tenantId ?? DEV_TENANT, projectId);
      if (!found) return res.status(404).json({ error: "project not found" });
      res.json(found);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "loading project failed" });
    }
  });

  app.post("/api/projects", async (req, res) => {
    const { status, body } = await handleUpsertProject(req.body, req.tenantId ?? DEV_TENANT);
    res.status(status).json(body);
  });

  app.post("/api/projects/:projectId/versions", async (req, res) => {
    const { status, body } = await handleSaveVersion(String(req.params.projectId), req.body, req.tenantId ?? DEV_TENANT);
    res.status(status).json(body);
  });

  app.delete("/api/projects/:projectId", async (req, res) => {
    const projectId = String(req.params.projectId);
    if (!PROJECT_ID_RE.test(projectId)) return res.status(400).json({ error: "invalid projectId" });
    try {
      await getStorage().deleteProject(req.tenantId ?? DEV_TENANT, projectId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "deleting project failed" });
    }
  });

  return app;
}

// Start only when this file is the entry module (so tests can import it freely).
const isDirectRun =
  process.env.START_BFF === "1" ||
  (!!process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url));
if (isDirectRun) {
  requireEnv();
  const port = Number(process.env.PORT ?? 8787);
  applyConfigCheck(validateConfig());
  console.log(`[bff] flags: ORCHESTRATOR_ENABLED=${process.env.ORCHESTRATOR_ENABLED ?? "0"} DESIGN_RAG_ENABLED=${process.env.DESIGN_RAG_ENABLED ?? "0"} STORAGE=${process.env.STORAGE ?? "duckdb"}`);
  createServer().listen(port, () => console.log(`BFF listening on http://localhost:${port}`));
}