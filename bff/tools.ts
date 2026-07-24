// bff/tools.ts — the MIGRATION FAÇADE (goal 6, hybrid plan): the pipeline
// published as three composite tools over stable, versioned, API-key-guarded
// HTTP contracts, plus an OpenAPI document at /tools/openapi.json that a
// Dify-class platform imports directly to register all three as custom tools.
//
// DESIGN LAWS (from MIGRATION_ASSESSMENT.md):
// - The tools are COMPOSITE: everything correctness-critical (compilers,
//   guards, contract-tested symmetry, reconcile, sanitizer) stays inside.
//   Nothing here re-implements pipeline logic — every handler is a thin,
//   validated mapper onto the existing handlers.
// - STATELESS BY CONTRACT: spec-in/spec-out. The caller (the flow) carries
//   currentSpec and, if it wants undo, its own stack of prior specs — resend
//   an older spec as currentSpec to "undo". No server session is required
//   for any tool response to be complete.
// - Auth: X-API-Key against T2UI_TOOLS_API_KEY. Unset → open (dev), warned
//   once. Set → required on every /tools/* call except the OpenAPI doc.
import type { Express, Request, Response } from "express";
import type { Dataset } from "../shared/types";
import { handleDashboardBuild } from "./dashboard/handler";
import {
  handleSourceChat, handleSqlConnect, LIVE_PREFIX,
} from "./text2sql/handler";
import { getConnection } from "./sources/connection-registry";
import { COLO_PROJECT_ID, coloAvailable, coloProfiles } from "./sources/colo";
import { isWorkbenchProject, getWorkbenchSource } from "./sources/workbench-store";

export const TOOLS_VERSION = "1.0.0";

// ---- auth ---------------------------------------------------------------------------
let warnedOpen = false;
export function toolsAuthOk(req: { header(name: string): string | undefined }): boolean {
  const key = process.env.T2UI_TOOLS_API_KEY;
  if (!key) {
    if (!warnedOpen) { warnedOpen = true; console.warn("[tools] T2UI_TOOLS_API_KEY unset — the /tools façade is OPEN (dev mode). Set it before exposing the BFF to a platform."); }
    return true;
  }
  return req.header("x-api-key") === key;
}

// ---- dataset resolution (mirrors source-chat's routing + plain uploads) -------------
export async function resolveDatasets(
  projectId: string, tenantId: string,
  listUploadDatasets: (tenantId: string, projectId: string) => Promise<any[]>,
): Promise<{ datasets?: Dataset[]; error?: { status: number; message: string } }> {
  try {
    if (projectId === COLO_PROJECT_ID && coloAvailable()) return { datasets: await coloProfiles() };
    if (isWorkbenchProject(projectId)) {
      const src = getWorkbenchSource(projectId);
      if (!src || src.tenantId !== tenantId) return { error: { status: 404, message: "unknown workbench source" } };
      return { datasets: src.tables };
    }
    if (projectId.startsWith(LIVE_PREFIX)) {
      const rec = getConnection(tenantId, projectId.slice(LIVE_PREFIX.length));
      if (!rec) return { error: { status: 410, message: "live connection expired — reconnect via the datasource tool" } };
      return { datasets: rec.datasets };
    }
    const metas = await listUploadDatasets(tenantId, projectId);
    const datasets = (metas ?? []).filter((m: any) => m?.tableName && m?.profile) as Dataset[];
    if (datasets.length) return { datasets };
    return { error: { status: 404, message: `no datasets found for project "${projectId}"` } };
  } catch (err: any) {
    return { error: { status: 500, message: err?.message ?? "dataset resolution failed" } };
  }
}

// ---- tool handlers (pure: body in, {status, body} out — offline-testable) -----------
export interface ToolsDeps {
  listUploadDatasets: (tenantId: string, projectId: string) => Promise<any[]>;
  buildDeps?: Parameters<typeof handleDashboardBuild>[1];
  sqlDeps?: Parameters<typeof handleSourceChat>[2];
}

/** POST /tools/text2ui — build OR edit (currentSpec present) a dashboard. */
export async function toolText2ui(body: unknown, tenantId: string, deps: ToolsDeps): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return { status: 400, body: { error: "prompt is required" } };
  let datasets: Dataset[] | undefined = Array.isArray(b.datasets) && b.datasets.length ? b.datasets : undefined;
  if (!datasets) {
    if (typeof b.projectId !== "string" || !b.projectId.trim()) {
      return { status: 400, body: { error: "either datasets[] (inline profiles) or projectId is required" } };
    }
    const r = await resolveDatasets(b.projectId.trim(), tenantId, deps.listUploadDatasets);
    if (r.error) return { status: r.error.status, body: { error: r.error.message } };
    datasets = r.datasets!;
  }
  const { status, body: out } = await handleDashboardBuild({
    datasets, userPrompt: b.prompt,
    ...(b.currentSpec ? { currentSpec: b.currentSpec } : {}),
    ...(Array.isArray(b.history) ? { history: b.history } : {}),
    ...(b.brief ? { brief: b.brief } : {}),
    ...(b.selectedWidget ? { selectedWidget: b.selectedWidget } : {}),
    ...(typeof b.conversationId === "string" ? { conversationId: b.conversationId } : {}),
  } as any, deps.buildDeps ?? {});
  if (status !== 200) return { status, body: out };
  // Stable tool contract: spec + the generated app (the sandbox file map the
  // client renders) + honesty channels. The caller persists spec and resends
  // it as currentSpec for edits (or an older one to undo).
  return { status: 200, body: {
    spec: out.spec, app: out.app ?? null, warnings: out.warnings ?? [],
    summary: out.summary ?? [], pipeline: out.pipeline, noChange: !!out.noChange,
    toolVersion: TOOLS_VERSION,
  } };
}

/** POST /tools/text2sql — a guarded data question against a published source. */
export async function toolText2sql(body: unknown, tenantId: string, deps: ToolsDeps): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  if (typeof b.question !== "string" || !b.question.trim()) return { status: 400, body: { error: "question is required" } };
  if (typeof b.projectId !== "string" || !b.projectId.trim()) return { status: 400, body: { error: "projectId is required" } };
  const { status, body: out } = await handleSourceChat(
    { projectId: b.projectId.trim(), prompt: b.question, ...(typeof b.conversationId === "string" ? { conversationId: b.conversationId } : {}) },
    tenantId, deps.sqlDeps ?? {});
  if (status !== 200) return { status, body: out };
  return { status: 200, body: {
    answer: out.answer ?? null, sql: out.sql ?? null,
    rows: out.rows ?? [], columns: out.columns ?? [], truncated: !!out.truncated,
    conversationId: out.conversationId ?? null, toolVersion: TOOLS_VERSION,
  } };
}

/** POST /tools/datasource — register a live connection; returns profiles + the
 *  queryable projectId (live mode) or the connectionId to extract from. */
export async function toolDatasource(body: unknown, tenantId: string): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  const { status, body: out } = await handleSqlConnect(b, tenantId);
  if (status !== 200) return { status, body: out };
  const mode = out.mode ?? null;
  return { status: 200, body: {
    connectionId: out.connectionId, mode,
    projectId: mode === "live" ? `${LIVE_PREFIX}${out.connectionId}` : null,
    tables: out.allTables ?? [], datasets: out.datasets ?? [], warnings: out.warnings ?? [],
    toolVersion: TOOLS_VERSION,
  } };
}

// ---- OpenAPI (what the platform imports) --------------------------------------------
const RESP = (desc: string) => ({ description: desc, content: { "application/json": { schema: { type: "object" } } } });
export const TOOLS_OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "text2UI composite tools",
    version: TOOLS_VERSION,
    description: "The text2UI pipeline published as composite tools. Correctness-critical logic (deterministic SQL compilation, validation guards, edit safety) lives INSIDE these tools; the flow layer routes and carries state (spec-in/spec-out — resend a prior spec as currentSpec to undo).",
  },
  servers: [{ url: "/" }],
  components: { securitySchemes: { ApiKey: { type: "apiKey", in: "header", name: "x-api-key" } } },
  security: [{ ApiKey: [] }],
  paths: {
    "/tools/text2ui": { post: {
      operationId: "text2ui",
      summary: "Build or edit an interactive dashboard from natural language",
      description: "Build: prompt + (projectId | inline dataset profiles). Edit: additionally pass the previously returned spec as currentSpec (and optionally history + selectedWidget). Returns the validated spec, the generated app (renderable file map), and honest warnings.",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", description: "what to build or change" },
          projectId: { type: "string", description: "colo | wb_… | live_… | upload project id (server resolves profiles)" },
          datasets: { type: "array", items: { type: "object" }, description: "inline Dataset profiles (alternative to projectId)" },
          currentSpec: { type: "object", description: "the spec from the previous tool response (edit mode)" },
          history: { type: "array", items: { type: "object" }, description: "recent chat turns [{role, content}]" },
          selectedWidget: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } },
          conversationId: { type: "string" },
        } } } } },
      responses: { "200": RESP("spec + app + warnings + summary"), "400": RESP("invalid input"), "422": RESP("no valid widgets after validation") },
    } },
    "/tools/text2sql": { post: {
      operationId: "text2sql",
      summary: "Answer a data question with guarded, deterministic SQL execution",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object",
        required: ["question", "projectId"],
        properties: {
          question: { type: "string" },
          projectId: { type: "string", description: "colo | wb_… | live_… (a published source)" },
          conversationId: { type: "string" },
        } } } } },
      responses: { "200": RESP("answer + sql + rows"), "400": RESP("invalid input"), "410": RESP("live connection expired") },
    } },
    "/tools/datasource": { post: {
      operationId: "datasource",
      summary: "Register a database connection and profile its tables",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object",
        properties: {
          connectionString: { type: "string", description: "mysql://… or postgres://…" },
          parts: { type: "object", description: "structured fields (host, database, user, password, …)" },
          mode: { type: "string", enum: ["live", "snapshot"], description: "live = query the DB directly, store nothing" },
          addTo: { type: "string", description: "existing connectionId to group with (cross-DB joins)" },
        } } } } },
      responses: { "200": RESP("connectionId + profiles (+ projectId when live)"), "400": RESP("invalid connection") },
    } },
  },
} as const;

// ---- mounting -----------------------------------------------------------------------
export function mountTools(app: Express, deps: ToolsDeps, tenantOf: (req: Request) => string): void {
  const guard = (req: Request, res: Response): boolean => {
    if (toolsAuthOk(req)) return true;
    res.status(401).json({ error: "invalid or missing x-api-key" });
    return false;
  };
  app.get("/tools/openapi.json", (_req, res) => { res.json(TOOLS_OPENAPI); });
  app.post("/tools/text2ui", async (req, res) => {
    if (!guard(req, res)) return;
    try { const { status, body } = await toolText2ui(req.body, tenantOf(req), deps); res.status(status).json(body); }
    catch (err: any) { res.status(500).json({ error: err?.message ?? "text2ui tool failed" }); }
  });
  app.post("/tools/text2sql", async (req, res) => {
    if (!guard(req, res)) return;
    try { const { status, body } = await toolText2sql(req.body, tenantOf(req), deps); res.status(status).json(body); }
    catch (err: any) { res.status(500).json({ error: err?.message ?? "text2sql tool failed" }); }
  });
  app.post("/tools/datasource", async (req, res) => {
    if (!guard(req, res)) return;
    try { const { status, body } = await toolDatasource(req.body, tenantOf(req)); res.status(status).json(body); }
    catch (err: any) { res.status(500).json({ error: err?.message ?? "datasource tool failed" }); }
  });
  console.log(`[tools] façade mounted (v${TOOLS_VERSION}) — OpenAPI at /tools/openapi.json`);
}
