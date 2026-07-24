// bff/chat-store.ts — conversation memory for the orchestrator (Phase 3).
// Self-contained: the Postgres impl owns a small pool and creates its own tables
// (best-effort, mirroring the design-rag migration), so it never risks the core
// storage. Falls back to in-memory when Postgres isn't configured.
import pg from "pg";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../shared/types";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  briefJson?: string | null;
  outputMode?: string | null;
}
export interface ConversationSummary { id: string; title: string | null; updatedAt: number }

export interface ChatStore {
  createConversation(title?: string, id?: string): Promise<string>;
  appendMessage(conversationId: string, msg: StoredMessage): Promise<void>;
  /** Prior turns as {role, content} — exactly what the orchestrator threads in. */
  getHistory(conversationId: string, limit?: number): Promise<ChatMessage[]>;
  listConversations(limit?: number): Promise<ConversationSummary[]>;
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
    await this.pool.query(`CREATE TABLE IF NOT EXISTS public._conversations (
      id         TEXT PRIMARY KEY,
      title      TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS public._messages (
      id              BIGSERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES public._conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      brief_json      TEXT,
      output_mode     TEXT,
      created_at      TIMESTAMPTZ DEFAULT now()
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_conv ON public._messages (conversation_id, id)`);
  }

  async createConversation(title?: string, id?: string): Promise<string> {
    await this.ready;
    const cid = id ?? randomUUID();
    await this.pool.query(
      `INSERT INTO public._conversations (id, title) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [cid, title ?? null],
    );
    return cid;
  }
  async appendMessage(conversationId: string, msg: StoredMessage): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO public._messages (conversation_id, role, content, brief_json, output_mode) VALUES ($1,$2,$3,$4,$5)`,
      [conversationId, msg.role, msg.content, msg.briefJson ?? null, msg.outputMode ?? null],
    );
    await this.pool.query(`UPDATE public._conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
  }
  async getHistory(conversationId: string, limit = 20): Promise<ChatMessage[]> {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT role, content FROM public._messages WHERE conversation_id = $1 ORDER BY id ASC LIMIT $2`,
      [conversationId, limit],
    );
    return rows.map((r) => ({ role: r.role, content: r.content }));
  }
  async listConversations(limit = 50): Promise<ConversationSummary[]> {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT id, title, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
       FROM public._conversations ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: Number(r.updated_ms) }));
  }
}

let singleton: ChatStore | null = null;
/** PG-backed when STORAGE=postgres + PG_URL; otherwise in-memory. */
export function getChatStore(): ChatStore {
  if (singleton) return singleton;
  const url = process.env.PG_URL;
  if ((process.env.STORAGE ?? "").toLowerCase() === "postgres" && url) {
    try { singleton = new PgChatStore(url); } catch { singleton = new InMemoryChatStore(); }
  } else {
    singleton = new InMemoryChatStore();
  }
  return singleton;
}
