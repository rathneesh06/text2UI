// bff/sources/selection-store.ts — the user's TABLE SELECTION, per conversation.
//
// The selection page is a conversation with state: the chat says "add orders",
// the rail's checkbox says "…and customers", and both must be looking at the
// same list. That list lives here, keyed by conversationId, so the chat model,
// the UI and the eventual extract all read one truth.
//
// TWO BACKENDS, chosen by the same env that drives the rest of storage:
//
//   STORAGE=postgres + PG_URL  ->  PgSelectionStore   (shared, survives redeploys)
//   anything else              ->  FileSelectionStore (.t2ui/workbench/selections.json)
//
// Why Postgres matters: with more than one BFF instance behind a load balancer, a
// selection made on instance A is invisible to B. That is a bug, not a nicety.
// The file backend is genuinely fine for a single instance on a persistent disk,
// which is why it stays rather than being deleted.
//
// AND IT MUST NEVER TAKE THE PAGE DOWN. We already spent a week on a chat-store
// outage that made ticking a checkbox fail with a bare 500. Moving selections to
// Postgres naively would reintroduce exactly that on a different table, so the
// Postgres backend degrades to the file backend on first failure and logs once —
// the same shape as resilientStore() in the selection handler.
//
// The undo stack stays in memory on purpose: it is a within-session affordance,
// not a document history, and persisting it would need a second table to buy
// almost nothing. canUndo() therefore stays synchronous.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WB_DIR } from "./workbench-store";
import { describeError } from "./describe-error";

export interface SelectionState {
  conversationId: string;
  tenantId: string;
  /** The connection this selection was made against (advisory: connections are
   *  in-memory and TTL out, the selection outlives them). */
  connectionId: string;
  /** Human label of that connection, for the UI after a reconnect. */
  connectionLabel?: string;
  tables: string[];
  /** Per-table column projection. A table ABSENT from this map (or mapped to an
   *  empty array) means "every column" — the common case, and the one that
   *  survives a schema change gracefully. Only narrowed tables are recorded. */
  columns: Record<string, string[]>;
  updatedAt: number;
}

export interface SelectionMeta {
  connectionId?: string;
  connectionLabel?: string;
  /** When supplied, REPLACES the projection — it is the complete state, not a
   *  patch. Omitting it leaves the existing projection alone. */
  columns?: Record<string, string[]>;
}

/** What a backend has to do. Deliberately three methods: the undo stack and the
 *  "forget projections for deselected tables" rule live above this, so both
 *  backends can't disagree about them. */
export interface SelectionBackend {
  load(conversationId: string, tenantId: string): Promise<SelectionState | null>;
  save(state: SelectionState): Promise<void>;
  remove(conversationId: string, tenantId: string): Promise<boolean>;
}

const MAX_UNDO = 25;
const empty = (conversationId: string, tenantId: string): SelectionState =>
  ({ conversationId, tenantId, connectionId: "", tables: [], columns: {}, updatedAt: 0 });

// ---- file backend ---------------------------------------------------------------

const FILE = () => join(WB_DIR(), "selections.json");

export class FileSelectionStore implements SelectionBackend {
  private states = new Map<string, SelectionState>();
  private loaded = false;

  private read(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(FILE(), "utf8"));
      const list: SelectionState[] = Array.isArray(parsed?.selections) ? parsed.selections : [];
      for (const s of list) {
        if (!s?.conversationId || !Array.isArray(s.tables)) continue;
        // Selections saved before column projection existed have no `columns`.
        this.states.set(s.conversationId, { ...s, columns: s.columns ?? {} });
      }
    } catch { /* nothing saved yet */ }
  }

  private write(): void {
    try {
      mkdirSync(WB_DIR(), { recursive: true });
      const path = FILE();
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ selections: [...this.states.values()] }, null, 2));
      renameSync(tmp, path);
    } catch (err: any) {
      // A selection that can't be persisted still works in memory for this
      // session — never fail the user's turn over a disk problem.
      console.warn(`[selection-store] persist failed: ${describeError(err)}`);
    }
  }

  async load(conversationId: string, tenantId: string): Promise<SelectionState | null> {
    this.read();
    const s = this.states.get(conversationId);
    return s && s.tenantId === tenantId ? s : null;
  }

  async save(state: SelectionState): Promise<void> {
    this.read();
    this.states.set(state.conversationId, state);
    this.write();
  }

  async remove(conversationId: string, tenantId: string): Promise<boolean> {
    this.read();
    const s = this.states.get(conversationId);
    if (!s || s.tenantId !== tenantId) return false;
    this.states.delete(conversationId);
    this.write();
    return true;
  }

  /** Test seam. */
  _clear(): void { this.states.clear(); this.loaded = false; }
}

// ---- Postgres backend -------------------------------------------------------------

const PG_TIMEOUT_MS = Number(process.env.SELECTION_PG_TIMEOUT_MS ?? 8_000);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export class PgSelectionStore implements SelectionBackend {
  private pool: any;
  private ready: Promise<void>;

  constructor(private connectionString: string) {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const pg = await import("pg");
    this.pool = new pg.default.Pool({ connectionString: this.connectionString, max: 3 });
    // `text2ui_` prefix: flowops is shared with the workflow platform, and an
    // unprefixed name could collide with — or be adopted from — another service.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS public.text2ui_selections (
      conversation_id  TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL,
      connection_id    TEXT,
      connection_label TEXT,
      tables           JSONB NOT NULL DEFAULT '[]'::jsonb,
      columns          JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  }

  // Reads are NOT cached. A per-process cache would defeat the reason this
  // backend exists: two BFF instances must see each other's writes.
  async load(conversationId: string, tenantId: string): Promise<SelectionState | null> {
    await withTimeout(this.ready, PG_TIMEOUT_MS, "selection store init");
    const r: any = await withTimeout(
      this.pool.query(
        `SELECT conversation_id, tenant_id, connection_id, connection_label, tables, columns,
                (extract(epoch from updated_at) * 1000)::bigint AS updated_ms
           FROM public.text2ui_selections WHERE conversation_id = $1 AND tenant_id = $2`,
        [conversationId, tenantId],
      ),
      PG_TIMEOUT_MS,
      "selection load",
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      conversationId: String(row.conversation_id),
      tenantId: String(row.tenant_id),
      connectionId: row.connection_id ?? "",
      connectionLabel: row.connection_label ?? undefined,
      tables: Array.isArray(row.tables) ? row.tables.map(String) : [],
      columns: row.columns && typeof row.columns === "object" ? row.columns : {},
      updatedAt: Number(row.updated_ms ?? 0),
    };
  }

  async save(state: SelectionState): Promise<void> {
    await withTimeout(this.ready, PG_TIMEOUT_MS, "selection store init");
    await withTimeout(
      this.pool.query(
        `INSERT INTO public.text2ui_selections
           (conversation_id, tenant_id, connection_id, connection_label, tables, columns, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
         ON CONFLICT (conversation_id) DO UPDATE SET
           tenant_id = EXCLUDED.tenant_id,
           connection_id = EXCLUDED.connection_id,
           connection_label = EXCLUDED.connection_label,
           tables = EXCLUDED.tables,
           columns = EXCLUDED.columns,
           updated_at = now()`,
        [
          state.conversationId, state.tenantId, state.connectionId || null,
          state.connectionLabel ?? null,
          JSON.stringify(state.tables), JSON.stringify(state.columns),
        ],
      ),
      PG_TIMEOUT_MS,
      "selection save",
    );
  }

  async remove(conversationId: string, tenantId: string): Promise<boolean> {
    await withTimeout(this.ready, PG_TIMEOUT_MS, "selection store init");
    const r: any = await withTimeout(
      this.pool.query(`DELETE FROM public.text2ui_selections WHERE conversation_id = $1 AND tenant_id = $2`, [conversationId, tenantId]),
      PG_TIMEOUT_MS,
      "selection delete",
    );
    return (r.rowCount ?? 0) > 0;
  }
}

// ---- backend resolution, with a degrade path ----------------------------------------

let backend: SelectionBackend | null = null;
let fileFallback: FileSelectionStore | null = null;
let warnedDegraded = false;

function fileStore(): FileSelectionStore {
  fileFallback ??= new FileSelectionStore();
  return fileFallback;
}

function resolveBackend(): SelectionBackend {
  if (backend) return backend;
  const kind = (process.env.STORAGE ?? "duckdb").toLowerCase();
  if (kind === "postgres" && process.env.PG_URL) {
    try {
      backend = new PgSelectionStore(process.env.PG_URL);
      console.log("[selection-store] using Postgres (public.text2ui_selections)");
      return backend;
    } catch (err: any) {
      console.warn(`[selection-store] Postgres unavailable at construction (${describeError(err)}) — using the local file`);
    }
  }
  backend = fileStore();
  return backend;
}

/** Any backend failure degrades to the local file for the rest of the process.
 *  A selection is working state — losing durability is survivable, losing the
 *  page is not. */
async function viaBackend<T>(op: (b: SelectionBackend) => Promise<T>): Promise<T> {
  const b = resolveBackend();
  if (b === fileFallback) return op(b);
  try {
    return await op(b);
  } catch (err: any) {
    if (!warnedDegraded) {
      warnedDegraded = true;
      console.warn(`[selection-store] Postgres failed (${describeError(err)}) — selections fall back to the local file for this process. Ticking still works; they won't be shared across instances.`);
    }
    backend = fileStore();
    return op(backend);
  }
}

// ---- public API (async: Postgres isn't synchronous) -----------------------------------

const undoStacks = new Map<string, { tables: string[]; columns: Record<string, string[]> }[]>();

/** Current selection for a conversation (never null — an unknown conversation is
 *  simply an empty selection). */
export async function getSelection(conversationId: string, tenantId: string): Promise<SelectionState> {
  const s = await viaBackend((b) => b.load(conversationId, tenantId));
  return s ?? empty(conversationId, tenantId);
}

/** Replace the selection, pushing the previous value onto the undo stack. */
export async function setSelection(
  conversationId: string,
  tenantId: string,
  tables: string[],
  meta: SelectionMeta = {},
): Promise<SelectionState> {
  const prev = await viaBackend((b) => b.load(conversationId, tenantId));
  if (prev) {
    const stack = undoStacks.get(conversationId) ?? [];
    stack.push({ tables: [...prev.tables], columns: { ...prev.columns } });
    undoStacks.set(conversationId, stack.slice(-MAX_UNDO));
  }
  const kept = [...new Set(tables.map(String).filter(Boolean))];
  // `meta.columns`, when supplied, REPLACES the projection — it is the complete
  // state, not a patch. Spreading it over the previous value made widening a
  // table back to all its columns impossible: the client signals "no longer
  // narrowed" by OMITTING the table, and a merge cannot express a deletion.
  const incoming = meta.columns ?? prev?.columns ?? {};
  // A projection only means anything while its table is selected.
  const columns: Record<string, string[]> = {};
  for (const t of kept) if (incoming[t]?.length) columns[t] = [...new Set(incoming[t])];

  const next: SelectionState = {
    conversationId,
    tenantId,
    connectionId: meta.connectionId ?? prev?.connectionId ?? "",
    connectionLabel: meta.connectionLabel ?? prev?.connectionLabel,
    tables: kept,
    columns,
    updatedAt: Date.now(),
  };
  await viaBackend((b) => b.save(next));
  return next;
}

/** Pop one step of history. Returns null when there's nothing to undo. */
export async function undoSelection(conversationId: string, tenantId: string): Promise<SelectionState | null> {
  const stack = undoStacks.get(conversationId);
  if (!stack?.length) return null;
  const cur = await viaBackend((b) => b.load(conversationId, tenantId));
  const prev = stack.pop()!;
  undoStacks.set(conversationId, stack);
  const next: SelectionState = {
    conversationId,
    tenantId,
    connectionId: cur?.connectionId ?? "",
    connectionLabel: cur?.connectionLabel,
    tables: prev.tables,
    columns: prev.columns,
    updatedAt: Date.now(),
  };
  await viaBackend((b) => b.save(next));
  return next;
}

/** In-memory, so it stays synchronous — see the header. */
export function canUndo(conversationId: string): boolean {
  return (undoStacks.get(conversationId)?.length ?? 0) > 0;
}

/** Forget a selection entirely (used when its tables are published as a source). */
export async function dropSelection(conversationId: string, tenantId: string): Promise<boolean> {
  undoStacks.delete(conversationId);
  return viaBackend((b) => b.remove(conversationId, tenantId));
}

/** Test seam: forget everything held in memory, and any resolved backend. */
export function _resetSelectionsForTest(b?: SelectionBackend): void {
  undoStacks.clear();
  fileFallback?._clear();
  warnedDegraded = false;
  backend = b ?? null;
  if (!b) fileFallback = null;
}
