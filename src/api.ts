// api.ts — every call from the UI to the BFF goes through here.
// Today the BFF exposes exactly two endpoints: POST /api/generate and GET /health.
// The backend phase (projects, datasets, server-side query) will extend this file —
// see the endpoint sketch at the bottom.
import type { DataAccess, Dataset, DataProfile, GeneratedApp, ReportDoc, DeckDoc, GenerationMetrics, OrchestratorBrief, ChatMessage, OutputMode } from "../shared/types";
import type { DashboardSpec } from "../shared/dashboard-spec";
import type { Table } from "./lib/datasets";

export const BFF_URL: string = (import.meta as any).env?.VITE_BFF_URL ?? "http://localhost:8787";
const BFF = BFF_URL;

/** Remote-data mode: the BFF stores rows (DuckDB) and the sandbox queries it.
 *  Must be paired with a running BFF; defaults to the inline (in-browser) layer. */
export const REMOTE_DATA: boolean = (import.meta as any).env?.VITE_REMOTE_DATA === "1";

export interface GenerateRequest {
  datasets: Dataset[];
  userPrompt: string;
  currentCode?: string; // present on edit turns
  lastError?: string;   // present on self-heal turns
  dataAccess?: DataAccess;
}

export interface SummaryRequest {
  projectId: string;
  tableName: string;
  profile: Dataset["profile"];
  featureTitle?: string;
  featureType?: string;
  featureDetails?: string;
  query?: string;
}

export interface SummaryResponse {
  summary: string;
}

/** P8: send the tenant bearer token (if configured) on every BFF call. */
function authHeaders(): Record<string, string> {
  const t = (import.meta as any).env?.VITE_AUTH_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Lightweight client debug log — visible in the browser console. Always on for
 *  now so we can see the request flow; flip the guard to quiet it later. */
export const dbg = (...args: unknown[]) => console.log("%c[t2ui]", "color:#6366f1;font-weight:bold", ...args);

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${BFF}${endpoint}`;
  dbg(`→ ${options.method ?? "GET"} ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers as Record<string, string> | undefined) },
    });
  } catch (e) {
    dbg(`✗ ${url} — network error (is the BFF running on :8787?)`, e);
    throw e;
  }
  const json: any = await res.json().catch(() => ({}));
  dbg(`← ${res.status} ${url}`, json);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (HTTP ${res.status})`);
  return json as T;
}

/** One build / edit / self-heal turn. Returns the generated app (files + summary). */
export function generate(body: GenerateRequest): Promise<GeneratedApp> {
  return request<GeneratedApp>("/api/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Spec-driven dashboard build/edit. The planner emits a typed DashboardSpec, the
 *  server compiles it to SQL + a deterministic renderer, and returns BOTH the app and
 *  the spec. Persist `spec` and pass it back as `currentSpec` next turn so each prompt
 *  edits the same dashboard. */
export interface BuildDashboardRequest {
  datasets: { tableName: string; profile: DataProfile }[];
  userPrompt: string;
  currentSpec?: DashboardSpec;
  /** Orchestrator brief (palette + design direction) — becomes the spec planner's visual directive. */
  brief?: unknown;
  /** al1: analyst-loop evidence pack (findings computed from the live DB) — outranks
   *  the brief's analytical half as the spec planner's directive on the first build. */
  analystDirective?: string;
  /** Conversation join: enables chat memory for the planner, version history, and undo/redo. */
  conversationId?: string;
  /** The widget the user clicked in the preview — "this"/"that" in the next edit. */
  selectedWidget?: { id?: string; title?: string };
}
export interface BuildDashboardResult {
  app: GeneratedApp | null;
  spec: DashboardSpec;
  warnings: string[];
  /** Human-readable description of what this turn changed. */
  summary?: string[];
  /** Which pipeline served the turn: agents | planner | history (undo/redo). */
  pipeline?: string;
  /** True when a history intent had nothing to do (e.g. undo at the first version). */
  noChange?: boolean;
}
export function buildDashboard(body: BuildDashboardRequest): Promise<BuildDashboardResult> {
  return request<BuildDashboardResult>("/api/dashboard/build", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Spec-driven PPT build/edit. Returns the editable DeckSpec, the COMPILED deck (data
 *  resolved — for an in-app slide preview), and the .pptx (base64). For uploaded data,
 *  pass `rows` so the server can resolve slide charts; colo needs no rows. Pass the prior
 *  `spec` back as `currentSpec` to edit the same deck. */
export interface BuildDeckRequest {
  datasets: { tableName: string; profile: DataProfile }[];
  userPrompt: string;
  rows?: { tableName: string; rows: Record<string, unknown>[] }[];
  currentSpec?: import("../shared/deck-spec").DeckSpec;
  deckId?: string;   // present → server edits the stored deck (targeted ops) instead of rebuilding
  documents?: { name: string; base64: string }[];   // uploaded docs → parsed into tables + narrative context
  images?: { name: string; base64: string }[];       // uploaded images → Asset Store (logo/embeds)
  conversationId?: string;   // asset scope, stable across build + edit turns
  projectId?: string;
}
export interface BuildDeckResult {
  deckId: string;
  version: number;
  spec: import("../shared/deck-spec").DeckSpec;
  compiled: import("../shared/deck-spec").CompiledDeck;
  filename: string;
  pptxBase64: string;
  warnings: string[];
  summary?: string[];   // human-readable list of what an edit changed
}
export function buildDeck(body: BuildDeckRequest): Promise<BuildDeckResult> {
  return request<BuildDeckResult>("/api/deck/build", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Exact preview: render the real .pptx to one PNG data URL per slide (LibreOffice). Returns
 *  empty images if the server can't render (e.g. LibreOffice missing) so the UI can fall back. */
export async function renderDeckPreview(pptxBase64: string): Promise<{ images: string[] }> {
  try { return await request<{ images: string[] }>("/api/deck/preview", { method: "POST", body: JSON.stringify({ pptxBase64 }) }); }
  catch { return { images: [] }; }
}

/** Orchestrator front door (Phase 1-3). One conversational turn: the planner
 *  chooses the output mode, enhances the prompt, and the chosen pipeline builds.
 *  Carries `conversationId` so the thread has memory across turns. */
export interface ChatRequest extends GenerateRequest {
  conversationId?: string;
}
export type ChatResponse =
  | ({ conversationId: string; needsClarification: true; question: string })
  | ({ conversationId: string; brief?: OrchestratorBrief; mode?: "dashboard" } & GeneratedApp)
  | ({ conversationId: string; brief?: OrchestratorBrief } & ReportResult)
  | ({ conversationId: string; brief?: OrchestratorBrief } & PptResult);

export function chat(body: ChatRequest): Promise<ChatResponse> {
  return request<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify(body) });
}

export interface ConversationSummary { id: string; title: string | null; updatedAt: number }
export function listConversations(): Promise<{ conversations: ConversationSummary[] }> {
  return request("/api/conversations");
}
export function getConversation(id: string): Promise<{ id: string; messages: ChatMessage[] }> {
  return request(`/api/conversations/${id}`);
}

/** Plan-only step: the orchestrator decides the mode and returns the enhanced
 *  prompt, so the client can drive the streaming build per turn. */
export type OrchestratePlan =
  | { conversationId: string; needsClarification: true; question: string }
  | { conversationId: string; outputMode: OutputMode; enhancedPrompt: string; brief?: OrchestratorBrief };
export interface GateTurnResult { conversationId: string; action: "edit" | "question" | "chat"; reply?: string; dataQuestion?: boolean }

/** Follow-up gate: classify a turn against an existing artifact (edit vs answer). */
export function gateTurn(body: {
  userPrompt: string; conversationId?: string; artifactKind: string; artifactSummary?: string;
  datasets?: { tableName: string; profile: DataProfile }[];
}): Promise<GateTurnResult> {
  return request<GateTurnResult>("/api/gate", { method: "POST", body: JSON.stringify(body) });
}

export function orchestratePlan(body: ChatRequest): Promise<OrchestratePlan> {
  return request<OrchestratePlan>("/api/orchestrate", { method: "POST", body: JSON.stringify(body) });
}

export type StreamEvent =
  | { type: "stage"; stage: "planning" | "model_call" | "continuation" | "validating" | "styling"; detail?: string }
  | { type: "chunk"; text: string }
  | { type: "progress"; chars: number }
  | { type: "plan"; text: string }
  | { type: "done"; app: GeneratedApp }
  | { type: "error"; error: string };

export async function generateStream(body: GenerateRequest, onEvent: (ev: StreamEvent) => void): Promise<GeneratedApp> {
  const url = `${BFF}/api/generate/stream`;
  dbg(`→ STREAM ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
  } catch (e) {
    dbg(`✗ STREAM ${url} — network error (is the BFF running?)`, e);
    throw e;
  }
  dbg(`← STREAM ${res.status} ${res.headers.get("content-type") ?? ""}`);

  if (!res.ok) {
    const json: any = await res.json().catch(() => ({}));
    throw new Error(json?.error ?? `Stream request failed (HTTP ${res.status})`);
  }

  if (!res.body) throw new Error("Stream unavailable");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let app: GeneratedApp | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });

    let splitIndex: number;
    while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      const line = chunk.trim();
      if (!line) continue;
      if (!line.startsWith("data:")) continue;

      const payload = JSON.parse(line.slice(5).trim()) as StreamEvent;
      dbg(`  stream event: ${payload.type}${payload.type === "stage" ? ` (${(payload as any).stage})` : ""}`);
      if (payload.type === "error") throw new Error(payload.error);
      if (payload.type === "done") {
        app = payload.app;
        break;
      }
      onEvent(payload);
    }

    if (done) break;
    if (app) break;
  }

  if (!app) throw new Error("Stream ended without completion");
  dbg(`✓ STREAM complete — ${app.files?.length ?? 0} files`);
  return app;
}

export function summary(body: SummaryRequest): Promise<SummaryResponse> {
  return request<SummaryResponse>("/api/summary", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function health(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/health");
}

/** Wave 1 / N5: download the current app as a complete, runnable Vite project.
 *  Hits POST /api/export, which returns a zip; this triggers a browser download.
 *  Inline mode (default) bakes the rows in so the exported app is self-contained. */
export async function exportProject(body: {
  app: GeneratedApp;
  tables: { tableName: string; rows: Record<string, unknown>[] }[];
  appName?: string;
  dataMode?: "inline" | "remote";
  remote?: { bffUrl: string; projectId: string };
  bundle?: "connected";
}): Promise<void> {
  const res = await fetch(`${BFF}/api/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      app: body.app,
      appName: body.appName,
      dataMode: body.dataMode ?? "inline",
      remote: body.remote,
      tables: body.tables,
      bundle: body.bundle,
    }),
  });
  if (!res.ok) {
    const json: any = await res.json().catch(() => ({}));
    throw new Error(json?.error ?? `Export failed (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const m = /filename="?([^"]+)"?/.exec(cd);
  const filename = (m && m[1]) || "text2ui-app.zip";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Wave 4 / N2b: document pipelines (PDF report, PPT deck). The model returns
 *  structured content; the BFF renders the file and returns it base64-encoded. */
export interface DocRequest {
  datasets: { tableName: string; profile: Dataset["profile"] }[];
  userPrompt: string;
  docContext?: string;
}
export interface ReportResult { mode: "pdf"; filename: string; pdfBase64: string; doc: ReportDoc; metrics?: GenerationMetrics }
export interface PptResult { mode: "ppt"; filename: string; pptxBase64: string; doc: DeckDoc; metrics?: GenerationMetrics }

/** PDF report pipeline — POST /api/report. */
export function generateReport(body: DocRequest): Promise<ReportResult> {
  return request<ReportResult>("/api/report", { method: "POST", body: JSON.stringify(body) });
}

/** PPT deck pipeline — POST /api/ppt. */
export function generatePpt(body: DocRequest): Promise<PptResult> {
  return request<PptResult>("/api/ppt", { method: "POST", body: JSON.stringify(body) });
}

/** Trigger a browser download from a base64-encoded file payload. */
export function downloadBase64(base64: string, filename: string, mime: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Reserved projectId the BFF treats as "the colo data snapshot". */
export const COLO_PROJECT_ID = "colosnapshot";

export interface SourceInfo {
  id: string;
  /** Combined sources: the original wb_* projectIds merged in. */
  components?: string[];
  label: string;
  projectId: string;
  tables: { tableName: string; profile: DataProfile }[];
}

/** Named backend data sources (e.g. "colo data"). Empty if none configured. */
export function listSources(): Promise<{ sources: SourceInfo[] }> {
  return request<{ sources: SourceInfo[] }>("/api/sources");
}

/** Turn server-provided source profiles into frontend Tables. Sample rows are
 *  carried for preview/context; the live data is queried from the BFF. */
export function sourceTablesToTables(tables: { tableName: string; profile: DataProfile }[]): Table[] {
  return tables.map((t) => ({
    id: `colo-${t.tableName}`,
    filename: t.profile.source?.filename ?? `colo:${t.tableName}`,
    tableName: t.tableName,
    ingest: { profile: t.profile, rows: t.profile.sampleRows ?? [] },
  }));
}

/** Replace the project's server-side tables with the current set (remote-data mode). */
export function uploadDatasets(projectId: string, tables: Table[]): Promise<void> {
  return request<void>("/api/datasets", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      datasets: tables.map((t) => ({
        tableName: t.tableName,
        filename: t.filename,
        profile: t.ingest.profile,
        rows: t.ingest.rows,
      })),
    }),
  });
}

/* ---- M3: project persistence (server-backed; used in remote-data mode) ---- */

export interface ServerProject {
  projectId: string;
  name: string;
  createdAt: number;
  editedAt: number;
  versionCount: number;
  tableNames: string[];
}
export interface ServerVersion { num: number; label: string; app: GeneratedApp; createdAt: number }
export interface ServerDataset { tableName: string; filename: string; rowCount: number; profile: DataProfile }

export function listProjects(): Promise<{ projects: ServerProject[] }> {
  return request("/api/projects");
}
export function getProject(projectId: string): Promise<{ project: Omit<ServerProject, "versionCount" | "tableNames">; versions: ServerVersion[] }> {
  return request(`/api/projects/${projectId}`);
}
export function upsertProject(projectId: string, name: string): Promise<void> {
  return request("/api/projects", { method: "POST", body: JSON.stringify({ projectId, name }) });
}
export function saveVersion(projectId: string, v: { num: number; label: string; app: GeneratedApp }): Promise<void> {
  return request(`/api/projects/${projectId}/versions`, { method: "POST", body: JSON.stringify(v) });
}
export function deleteProjectApi(projectId: string): Promise<void> {
  return request(`/api/projects/${projectId}`, { method: "DELETE" });
}
export function listServerDatasets(projectId: string): Promise<{ datasets: ServerDataset[] }> {
  return request(`/api/datasets/${projectId}`);
}
/** Pull a stored table's rows back for project restore (cap = its known row count). */
export function fetchTableRows(projectId: string, tableName: string, rowCount: number): Promise<Record<string, unknown>[]> {
  return request<{ rows: Record<string, unknown>[] }>("/api/query", {
    method: "POST",
    body: JSON.stringify({ projectId, sql: `SELECT * FROM "${tableName.replace(/"/g, '""')}"`, rowCap: rowCount }),
  }).then((r) => r.rows);
}