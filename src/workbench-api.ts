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

/** Push the checkbox state — clicking and typing edit the SAME selection. */
export function wbSetSelection(body: { connectionId: string; conversationId?: string; tables: string[]; note?: boolean }): Promise<{ conversationId: string; selection: string[]; added: string[]; removed: string[]; canUndo: boolean }> {
  return request("/api/sql/selection", { method: "POST", body: JSON.stringify(body) });
}

/** Rehydrate selection + transcript after a reload. */
export function wbGetSelection(conversationId: string): Promise<{ conversationId: string; selection: string[]; connectionId: string | null; connectionLabel: string | null; canUndo: boolean; turns: { role: string; content: string }[] }> {
  return request(`/api/sql/selection/${encodeURIComponent(conversationId)}`);
}

/** "Continue to text2UI": the selection becomes a build source. */
export function wbCommitSelection(body: { connectionId: string; conversationId?: string; tables?: string[]; label?: string; mode?: "live" | "snapshot" }): Promise<WbExtracted & { conversationId: string; mode: "live" | "snapshot"; warnings?: string[] }> {
  return request("/api/sql/selection/commit", { method: "POST", body: JSON.stringify(body) });
}

/* ---- dedicated Postgres page: structured connect (no URL parsing pitfalls) ---- */

export interface WbConnParts {
  dialect?: "mysql" | "postgres";
  host: string;
  port?: number | string;
  database: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

/** Best-effort client-side parse of a postgres:// URI into form fields (the
 *  "paste to fill" convenience). Percent-escapes are decoded when valid; the
 *  authoritative connect always sends the FORM values, so a wrong guess here is
 *  visible and fixable before connecting. */
export function pgUriToParts(uri: string): Partial<WbConnParts> | null {
  const s = (uri ?? "").trim();
  const m = s.match(/^postgres(?:ql)?(?:\+[a-z0-9]+)?:\/\//i);
  if (!m) return null;
  const dec = (x: string) => { try { return /%[0-9a-f]{2}/i.test(x) ? decodeURIComponent(x) : x; } catch { return x; } };
  const rest = s.slice(m[0].length);
  const slash = rest.indexOf("/");
  const authority = slash >= 0 ? rest.slice(0, slash) : rest;
  let tail = slash >= 0 ? rest.slice(slash + 1) : "";
  let query = "";
  const qm = tail.search(/[?#]/);
  if (qm >= 0) { query = tail.slice(qm + 1); tail = tail.slice(0, qm); }
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at) : "";
  const hostport = at >= 0 ? authority.slice(at + 1) : authority;
  let user = "", password = "";
  if (userinfo) {
    const colon = userinfo.indexOf(":");
    if (colon >= 0) { user = userinfo.slice(0, colon); password = userinfo.slice(colon + 1); }
    else user = userinfo;
  }
  let host = hostport, port: string | undefined;
  const lastColon = hostport.lastIndexOf(":");
  if (lastColon >= 0 && /^\d+$/.test(hostport.slice(lastColon + 1))) {
    host = hostport.slice(0, lastColon);
    port = hostport.slice(lastColon + 1);
  }
  const ssl = /(^|&)(ssl|sslmode|ssl-mode)=(1|true|require|required|verify[^&]*|yes|on)(&|$)/i.test(query);
  return {
    dialect: "postgres",
    host: host.replace(/^\[|\]$/g, ""),
    ...(port ? { port } : {}),
    database: dec(tail),
    user: dec(user),
    password: dec(password),
    ssl,
  };
}
