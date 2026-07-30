// bff/chat-store.ts — conversation memory for the orchestrator (Phase 3).
// Self-contained: the Postgres impl owns a small pool and creates its own tables
// (best-effort, mirroring the design-rag migration), so it never risks the core
// storage. Falls back to in-memory when Postgres isn't configured.
import pg from "pg";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../shared/types";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  briefJson?: string | null;
  outputMode?: string | null;
}
export interface ConversationSummary { id: string; title: string | null; updatedAt: number }

export interface ProjectState { spec: unknown; conversationId: string | null; datasets?: unknown; savedAt: number }

export interface ChatStore {
  createConversation(title?: string, id?: string): Promise<string>;
  appendMessage(conversationId: string, msg: StoredMessage): Promise<void>;
  /** Prior turns as {role, content} — exactly what the orchestrator threads in. */
  getHistory(conversationId: string, limit?: number): Promise<ChatMessage[]>;
  listConversations(limit?: number): Promise<ConversationSummary[]>;
  // ---- durable projects (goal: reopen = chat + dashboard back, reconnect data) ----
  /** Persist the latest built dashboard (validated spec + the profiles it was
   *  validated against) and its conversation link, keyed by projectId. */
  saveProjectState(projectId: string, state: { spec: unknown; conversationId?: string | null; datasets?: unknown }): Promise<void>;
  getProjectState(projectId: string): Promise<ProjectState | null>;
}

// ---- In-memory (dev/tests; no persistence across restarts) ------------------
export class InMemoryChatStore implements ChatStore {
  private convos = new Map<string, { title: string | null; updatedAt: number; seq: number; messages: StoredMessage[] }>();
  private seq = 0;

  async createConversation(title?: string, id?: string): Promise<string> {
    const cid = id ?? randomUUID();
    if (!this.convos.has(cid)) this.convos.set(cid, { title: title ?? null, updatedAt: Date.now(), seq: ++this.seq, messages: [] });
    return cid;
  }
  async appendMessage(conversationId: string, msg: StoredMessage): Promise<void> {
    const c = this.convos.get(conversationId) ?? { title: null, updatedAt: Date.now(), seq: ++this.seq, messages: [] };
    c.messages.push(msg); c.updatedAt = Date.now(); c.seq = ++this.seq;
    this.convos.set(conversationId, c);
  }
  async getHistory(conversationId: string, limit = 20): Promise<ChatMessage[]> {
    const c = this.convos.get(conversationId);
    if (!c) return [];
    return c.messages.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
  }
  async listConversations(limit = 50): Promise<ConversationSummary[]> {
    return [...this.convos.entries()]
      .sort((a, b) => b[1].seq - a[1].seq) // monotonic: most-recently-touched first
      .slice(0, limit)
      .map(([id, c]) => ({ id, title: c.title, updatedAt: c.updatedAt }));
  }
  private projects = new Map<string, ProjectState>();
  async saveProjectState(projectId: string, s: { spec: unknown; conversationId?: string | null; datasets?: unknown }): Promise<void> {
    this.projects.set(projectId, { spec: s.spec, conversationId: s.conversationId ?? null, datasets: s.datasets, savedAt: Date.now() });
  }
  async getProjectState(projectId: string): Promise<ProjectState | null> {
    return this.projects.get(projectId) ?? null;
  }
}

// ---- Postgres-backed --------------------------------------------------------
export class PgChatStore implements ChatStore {
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 });
    this.ready = this.init().catch((err: any) => {
      // A dead chat store costs durability, never the process: callers already
      // degrade ("memory unavailable"); an uncaught constructor-field rejection
      // must not exist (the ECONNREFUSED-kills-the-BFF incident).
      console.warn(`[chat-store] Postgres unavailable (${err?.code ?? err?.message ?? err}) — chat persistence degraded. Is 'docker compose up -d db' running?`);
    });
  }

  private async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS public.text2ui_conversations (
      id         TEXT PRIMARY KEY,
      title      TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS public.text2ui_messages (
      id              BIGSERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES public.text2ui_conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      brief_json      TEXT,
      output_mode     TEXT,
      created_at      TIMESTAMPTZ DEFAULT now()
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_text2ui_messages_conv ON public.text2ui_messages (conversation_id, id)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS public.text2ui_project_state (
      project_id      TEXT PRIMARY KEY,
      spec_json       TEXT NOT NULL,
      datasets_json   TEXT,
      conversation_id TEXT,
      saved_at        TIMESTAMPTZ DEFAULT now()
    )`);
  }

  async saveProjectState(projectId: string, s: { spec: unknown; conversationId?: string | null; datasets?: unknown }): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO public.text2ui_project_state (project_id, spec_json, datasets_json, conversation_id, saved_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (project_id) DO UPDATE SET spec_json = EXCLUDED.spec_json,
         datasets_json = EXCLUDED.datasets_json, conversation_id = EXCLUDED.conversation_id, saved_at = now()`,
      [projectId, JSON.stringify(s.spec), s.datasets ? JSON.stringify(s.datasets) : null, s.conversationId ?? null],
    );
  }
  async getProjectState(projectId: string): Promise<ProjectState | null> {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT spec_json, datasets_json, conversation_id, EXTRACT(EPOCH FROM saved_at) * 1000 AS saved_ms
       FROM public.text2ui_project_state WHERE project_id = $1`, [projectId]);
    if (!rows.length) return null;
    return { spec: JSON.parse(rows[0].spec_json), datasets: rows[0].datasets_json ? JSON.parse(rows[0].datasets_json) : undefined,
      conversationId: rows[0].conversation_id ?? null, savedAt: Number(rows[0].saved_ms) };
  }

  async createConversation(title?: string, id?: string): Promise<string> {
    await this.ready;
    const cid = id ?? randomUUID();
    await this.pool.query(
      `INSERT INTO public.text2ui_conversations (id, title) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [cid, title ?? null],
    );
    return cid;
  }
  async appendMessage(conversationId: string, msg: StoredMessage): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO public.text2ui_messages (conversation_id, role, content, brief_json, output_mode) VALUES ($1,$2,$3,$4,$5)`,
      [conversationId, msg.role, msg.content, msg.briefJson ?? null, msg.outputMode ?? null],
    );
    await this.pool.query(`UPDATE public.text2ui_conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
  }
  async getHistory(conversationId: string, limit = 20): Promise<ChatMessage[]> {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT role, content FROM public.text2ui_messages WHERE conversation_id = $1 ORDER BY id ASC LIMIT $2`,
      [conversationId, limit],
    );
    return rows.map((r) => ({ role: r.role, content: r.content }));
  }
  async listConversations(limit = 50): Promise<ConversationSummary[]> {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT id, title, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
       FROM public.text2ui_conversations ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: Number(r.updated_ms) }));
  }
}

// ---- DuckDB-backed (embedded, Docker-free) ------------------------------------------
// Same contract as PgChatStore over an in-process file database: chat and
// project state survive BFF restarts with ZERO external services — the shape
// an MCP server wants. Single-writer (one BFF/MCP process) by design.
export class DuckDbChatStore implements ChatStore {
  private instance?: DuckDBInstance;
  private ready: Promise<void>;
  private initFailed = false;
  constructor(private dbPath: string) {
    this.ready = this.init().then(
      () => { this.initFailed = false; },
      (err: any) => { this.initFailed = true;
        console.warn(`[chat-store] DuckDB unavailable (${err?.message ?? err}) — chat persistence degraded.`); },
    );
  }
  private async init(): Promise<void> {
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.instance = await DuckDBInstance.create(this.dbPath);
    await this.run(`CREATE TABLE IF NOT EXISTS _conversations (
      id TEXT PRIMARY KEY, title TEXT, project_id TEXT,
      created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now())`);
    await this.run(`CREATE SEQUENCE IF NOT EXISTS _messages_seq`);
    await this.run(`CREATE TABLE IF NOT EXISTS _messages (
      id BIGINT DEFAULT nextval('_messages_seq'), conversation_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, brief_json TEXT, output_mode TEXT,
      created_at TIMESTAMP DEFAULT now())`);
    await this.run(`CREATE TABLE IF NOT EXISTS _project_state (
      project_id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, datasets_json TEXT,
      conversation_id TEXT, saved_at TIMESTAMP DEFAULT now())`);
  }
  private async ensure(): Promise<void> {
    await this.ready;
    if (this.initFailed) throw new Error("chat store (DuckDB) unavailable — check the storage directory is writable");
  }
  // Releases the embedded DuckDB file handle so a fresh instance can open the
  // same file (DuckDB holds an exclusive OS lock; on Windows a second open of a
  // still-open file is refused). Closing here = process exit; a new
  // DuckDbChatStore on the same path = a restart. Idempotent, never throws.
  async close(): Promise<void> {
    await this.ready.catch(() => {});
    try { this.instance?.closeSync?.(); } catch { /* best-effort */ }
    this.instance = undefined;
    this.initFailed = false;
  }
  private lit = (v: unknown) => v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
  private async run(sql: string): Promise<void> {
    const c = await this.instance!.connect();
    try { await c.run(sql); } finally { c.disconnectSync(); }
  }
  private async all(sql: string): Promise<Record<string, unknown>[]> {
    const c = await this.instance!.connect();
    try {
      const reader = await c.runAndReadUntil(sql, 100_000);
      return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((row) => {
        for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
        return row;
      });
    } finally { c.disconnectSync(); }
  }
  async createConversation(title?: string, id?: string): Promise<string> {
    await this.ensure();
    const cid = id ?? randomUUID();
    await this.run(`INSERT INTO _conversations (id, title) VALUES (${this.lit(cid)}, ${this.lit(title ?? null)})
      ON CONFLICT (id) DO UPDATE SET updated_at = now()`);
    return cid;
  }
  async appendMessage(conversationId: string, msg: StoredMessage): Promise<void> {
    await this.ensure();
    await this.run(`INSERT INTO _conversations (id, title) VALUES (${this.lit(conversationId)}, NULL) ON CONFLICT (id) DO UPDATE SET updated_at = now()`);
    await this.run(`INSERT INTO _messages (conversation_id, role, content, brief_json, output_mode)
      VALUES (${this.lit(conversationId)}, ${this.lit(msg.role)}, ${this.lit(msg.content)}, ${this.lit(msg.briefJson ?? null)}, ${this.lit(msg.outputMode ?? null)})`);
  }
  async getHistory(conversationId: string, limit = 20): Promise<ChatMessage[]> {
    await this.ensure();
    const rows = await this.all(`SELECT role, content FROM _messages WHERE conversation_id = ${this.lit(conversationId)} ORDER BY id DESC LIMIT ${Math.max(1, Math.min(200, limit))}`);
    return rows.reverse().map((r) => ({ role: r.role as any, content: String(r.content) }));
  }
  async listConversations(limit = 50): Promise<ConversationSummary[]> {
    await this.ensure();
    const rows = await this.all(`SELECT id, title, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms FROM _conversations ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`);
    return rows.map((r) => ({ id: String(r.id), title: (r.title as string) ?? null, updatedAt: Number(r.updated_ms) }));
  }
  async saveProjectState(projectId: string, s: { spec: unknown; conversationId?: string | null; datasets?: unknown }): Promise<void> {
    await this.ensure();
    await this.run(`INSERT INTO _project_state (project_id, spec_json, datasets_json, conversation_id, saved_at)
      VALUES (${this.lit(projectId)}, ${this.lit(JSON.stringify(s.spec))}, ${this.lit(s.datasets ? JSON.stringify(s.datasets) : null)}, ${this.lit(s.conversationId ?? null)}, now())
      ON CONFLICT (project_id) DO UPDATE SET spec_json = EXCLUDED.spec_json, datasets_json = EXCLUDED.datasets_json,
        conversation_id = EXCLUDED.conversation_id, saved_at = now()`);
  }
  async getProjectState(projectId: string): Promise<ProjectState | null> {
    await this.ensure();
    const rows = await this.all(`SELECT spec_json, datasets_json, conversation_id, EXTRACT(EPOCH FROM saved_at) * 1000 AS saved_ms FROM _project_state WHERE project_id = ${this.lit(projectId)}`);
    if (!rows.length) return null;
    return { spec: JSON.parse(String(rows[0].spec_json)),
      datasets: rows[0].datasets_json ? JSON.parse(String(rows[0].datasets_json)) : undefined,
      conversationId: (rows[0].conversation_id as string) ?? null, savedAt: Number(rows[0].saved_ms) };
  }
}

let singleton: ChatStore | null = null;
/** PG-backed when STORAGE=postgres + PG_URL (a pg server, wherever it runs);
 *  otherwise an EMBEDDED DuckDB file — durable with zero external services
 *  (the Docker-free / MCP shape). In-memory only if even the file store fails. */
export function getChatStore(): ChatStore {
  if (singleton) return singleton;
  const url = process.env.PG_URL;
  if ((process.env.STORAGE ?? "").toLowerCase() === "postgres" && url) {
    try { singleton = new PgChatStore(url); } catch { singleton = new InMemoryChatStore(); }
  } else {
    // `||` not `??`: an empty STORAGE_PATH= in .env is a string, not nullish, so
    // `??` kept it and path.dirname("") is ".", resolving the chat DB to
    // ./chat.duckdb in whatever the process CWD happens to be.
    const p = process.env.T2UI_CHAT_DB || path.join(path.dirname(process.env.STORAGE_PATH || "bff/data/text2ui.duckdb"), "chat.duckdb");
    try { singleton = new DuckDbChatStore(p); } catch { singleton = new InMemoryChatStore(); }
  }
  return singleton;
}
