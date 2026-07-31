// workbench-api.ts — client for the SQL Workbench routes (/api/sql/*).
// Kept beside api.ts rather than inside it so the workbench feature lands as an
// additive module; mirrors api.ts's request conventions (auth header, dbg log).
import type { Dataset, DataProfile } from "../shared/types";
import { BFF_URL, dbg } from "./api";

function authHeaders(): Record<string, string> {
  const t = (import.meta as any).env?.VITE_AUTH_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${BFF_URL}${endpoint}`;
  dbg(`→ ${options.method ?? "GET"} ${url}`);
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers as Record<string, string> | undefined) },
  });
  const json: any = await res.json().catch(() => ({}));
  dbg(`← ${res.status} ${url}`, json);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (HTTP ${res.status})`);
  return json as T;
}

/** The projectId prefix the BFF uses for extracted workbench sources. */
export const WB_PREFIX = "wb_";
export const isWorkbenchProject = (projectId: string) => projectId.startsWith(WB_PREFIX);
/** al2: fully-live sources — widgets query the live DB; nothing stored, gone on BFF restart. */
export const isLiveProject = (projectId: string) => projectId.startsWith("live_");
/** Any server-managed source (snapshot or live): tables live on the BFF, not in this tab. */
export const isServerSource = (projectId: string) => isWorkbenchProject(projectId) || isLiveProject(projectId);

export interface WbConnection {
  connectionId: string;
  status?: "active" | "degraded";
  label: string;
  allTables: { name: string; approxRows: number; schema?: string; ref?: string }[];
  datasets: Dataset[];
  warnings: string[];
  /** al3: present when this "connection" is a GROUP of databases. */
  members?: string[];
}

export interface WbExtracted {
  projectId: string;
  label: string;
  tables: { tableName: string; profile: DataProfile }[];
  /** al1: analyst-loop findings, present on build handoffs when T2SQL_ANALYST=1 —
   *  carried into the first dashboard build as its analytical directive. */
  evidence?: string;
}

/** Connect + introspect. The connection string is sent once over the wire and the
 *  BFF never echoes credentials back. */
export function wbConnect(connectionString: string, addTo?: string, mode?: "live" | "snapshot", opts: { fast?: boolean } = {}): Promise<WbConnection> {
  return request<WbConnection>("/api/sql/connect", {
    method: "POST",
    // al3: addTo binds this DB with an existing connection/group into ONE group
    // (merged schema, cross-DB joins) — the response's connectionId is the group.
    // mode (goal 3): "live" reads straight from the database and stores nothing;
    // omitted → the server default (snapshot unless T2SQL_LIVE_SOURCE=1).
    // fast: list table names only — the selection page profiles on click, so it
    // skips the connect-time sampling that dominates latency on big servers.
    body: JSON.stringify({ connectionString, ...(addTo ? { addTo } : {}), ...(mode ? { mode } : {}), ...(opts.fast ? { fast: true } : {}) }),
  });
}

/** Rehydrate the schema for an existing connection (e.g. after navigation). */
export function wbSchema(connectionId: string): Promise<WbConnection> {
  return request<WbConnection>(`/api/sql/${encodeURIComponent(connectionId)}/schema`);
}

/** Answer a data question inside the BUILD chat by querying the published
 *  snapshot (or colo) through the text2SQL loop. */
export function sourceChat(body: { projectId: string; conversationId?: string; prompt: string }): Promise<{
  conversationId: string; answer: string; sql?: string;
  rows?: Record<string, unknown>[]; columns?: string[];
  executionMeta?: { durationMs: number; rowsReturned: number; sourceType: string };
}> {
  return request("/api/source/chat", { method: "POST", body: JSON.stringify(body) });
}

/** Merge published extracts into ONE combined source (multi-connection builds). */
export function wbCombineSources(body: { projectIds: string[]; label?: string }): Promise<WbExtracted & { components?: string[]; warnings?: string[] }> {
  return request("/api/sources/combine", { method: "POST", body: JSON.stringify(body) });
}

/** Discard an unpublished stage (panel memory + server entry + staging file). */
export function wbDiscardStage(conversationId: string): Promise<{ discarded: boolean }> {
  return request(`/api/sql/stage/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
}

/** Delete a published workbench source (removes it from the start page). */
export function wbDeleteSource(projectId: string): Promise<{ deleted: boolean }> {
  return request(`/api/sources/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

/* ---- table selection: the pick-your-tables page (/select) ---- */

export interface WbCatalogTable {
  index: number;          // 1-based, exactly the number shown in the rail
  name: string;
  approxRows: number;
  profiled: boolean;      // false -> clicking it needs a wbProfile round-trip
  columnCount: number | null;
}
export interface WbColumn {
  name: string;
  type: string | null;
  nullable: boolean | null;
  uniqueCount: number | null;
  sampleValues: unknown[];
}
export interface WbTableDetail {
  tableName: string;
  rowCount: number;
  columns: WbColumn[];
  sampleRows: Record<string, unknown>[];
}
export interface WbSelectionReply {
  conversationId: string;
  reply: string;
  selection: string[];
  /** Per-table column narrowing. A table absent here keeps every column. */
  columns?: Record<string, string[]>;
  added: string[];
  removed: string[];
  unresolved?: string[];
  ambiguous?: { ref: string; candidates: string[] }[];
  focus?: string;         // the assistant asked to OPEN a table's columns
  canUndo: boolean;
  understood: boolean;
  source?: "model" | "offline";   // "offline" = the model was unreachable
}

/** The rail's list: every table, numbered as the user sees it. */
export function wbCatalog(connectionId: string): Promise<{ connectionId: string; label: string; tables: WbCatalogTable[]; warnings: string[] }> {
  return request(`/api/sql/${encodeURIComponent(connectionId)}/catalog`);
}

/** Columns for the middle panel; profiles on demand for big schemas. */
export function wbProfile(connectionId: string, tables: string[]): Promise<{ tables: WbTableDetail[]; warnings: string[] }> {
  return request(`/api/sql/${encodeURIComponent(connectionId)}/profile`, { method: "POST", body: JSON.stringify({ tables }) });
}

/** One conversational selection turn ("select 1, 2, 3", "drop the audit ones"). */
export function wbSelect(body: { connectionId: string; conversationId?: string; prompt: string }): Promise<WbSelectionReply> {
  return request("/api/sql/select", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Streaming twin of wbSelect(). Emits stage/query/token/selection events as the
 * turn runs and resolves with the finished reply. Throws on any transport or
 * stream error so the caller can fall back to wbSelect() — a dead stream must not
 * cost the user their turn.
 */
export async function wbSelectStream(
  body: { connectionId: string; conversationId?: string; prompt: string },
  onEvent: (ev: any) => void,
): Promise<{ reply: string; conversationId: string }> {
  const url = `${BFF_URL}/api/sql/select/stream`;
  dbg(`→ STREAM ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json: any = await res.json().catch(() => ({}));
    throw new Error(json?.error ?? `Stream request failed (HTTP ${res.status})`);
  }
  if (!res.body) throw new Error("Stream unavailable");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let out: { reply: string; conversationId: string } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let splitIndex: number;
    while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      const line = chunk.trim();
      if (!line || !line.startsWith("data:")) continue;
      const payload = JSON.parse(line.slice(5).trim()) as any;
      if (payload.type === "error") throw new Error(payload.error);
      if (payload.type === "done") {
        out = { reply: String(payload.reply ?? ""), conversationId: String(payload.conversationId ?? "") };
        break;
      }
      onEvent(payload);
    }
    if (done) break;
    if (out) break;
  }
  if (!out) throw new Error("Stream ended without completion");
  return out;
}

/** Push the checkbox state — clicking and typing edit the SAME selection. */
export function wbSetSelection(body: { connectionId: string; conversationId?: string; tables: string[]; columns?: Record<string, string[]>; note?: boolean }): Promise<{ conversationId: string; selection: string[]; columns: Record<string, string[]>; added: string[]; removed: string[]; canUndo: boolean }> {
  return request("/api/sql/selection", { method: "POST", body: JSON.stringify(body) });
}

/** Rehydrate selection + transcript after a reload. */
export function wbGetSelection(conversationId: string): Promise<{ conversationId: string; selection: string[]; columns: Record<string, string[]>; connectionId: string | null; connectionLabel: string | null; canUndo: boolean; turns: { role: string; content: string }[] }> {
  return request(`/api/sql/selection/${encodeURIComponent(conversationId)}`);
}

/** "Continue to text2UI": the selection becomes a build source. */
export function wbCommitSelection(body: { connectionId: string; conversationId?: string; tables?: string[]; label?: string; mode?: "live" | "snapshot" }): Promise<WbExtracted & { conversationId: string; mode: "live" | "snapshot"; warnings?: string[] }> {
  return request("/api/sql/selection/commit", { method: "POST", body: JSON.stringify(body) });
}
