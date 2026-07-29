// bff/sources/selection-store.ts — the user's TABLE SELECTION, per conversation.
//
// The selection page is a conversation with state: the chat says "add orders",
// the rail's checkbox says "…and customers", and both must be looking at the
// same list. That list lives here — server-side, keyed by conversationId — so
// the chat model, the UI, and the eventual extract all read one truth.
//
// Durability mirrors workbench-store's staging: an in-memory Map written
// through to a small JSON file (atomic tmp+rename) under WB_DIR, so a reload or
// a BFF restart doesn't lose a selection someone spent ten minutes curating.
// The undo stack is deliberately memory-only — "undo" is a within-session
// affordance, not a document history.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WB_DIR } from "./workbench-store";

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

const FILE = () => join(WB_DIR(), "selections.json");
const MAX_UNDO = 25;

const states = new Map<string, SelectionState>();
const undoStacks = new Map<string, { tables: string[]; columns: Record<string, string[]> }[]>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(FILE(), "utf8"));
    const list: SelectionState[] = Array.isArray(parsed?.selections) ? parsed.selections : [];
    for (const s of list) {
      if (!s?.conversationId || !Array.isArray(s.tables)) continue;
      // Selections saved before column projection existed have no `columns`.
      states.set(s.conversationId, { ...s, columns: s.columns ?? {} });
    }
  } catch { /* nothing saved yet */ }
}

function save(): void {
  try {
    mkdirSync(WB_DIR(), { recursive: true });
    const path = FILE();
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ selections: [...states.values()] }, null, 2));
    renameSync(tmp, path);
  } catch (err: any) {
    // A selection that can't be persisted still works in memory for this
    // session — never fail the user's turn over a disk problem.
    console.warn(`[selection-store] persist failed: ${err?.message ?? err}`);
  }
}

/** Current selection for a conversation (never null — an unknown conversation
 *  is simply an empty selection). */
export function getSelection(conversationId: string, tenantId: string): SelectionState {
  load();
  const s = states.get(conversationId);
  if (s && s.tenantId === tenantId) return s;
  return { conversationId, tenantId, connectionId: "", tables: [], columns: {}, updatedAt: 0 };
}

/** Replace the selection, pushing the previous value onto the undo stack. */
export function setSelection(
  conversationId: string,
  tenantId: string,
  tables: string[],
  meta: { connectionId?: string; connectionLabel?: string; columns?: Record<string, string[]> } = {},
): SelectionState {
  load();
  const prev = states.get(conversationId);
  if (prev && prev.tenantId === tenantId) {
    const stack = undoStacks.get(conversationId) ?? [];
    stack.push({ tables: [...prev.tables], columns: { ...prev.columns } });
    undoStacks.set(conversationId, stack.slice(-MAX_UNDO));
  }
  const kept = [...new Set(tables.map(String).filter(Boolean))];
  // A column projection only means anything while its table is selected;
  // deselecting a table forgets how it was narrowed.
  const merged = { ...(prev?.columns ?? {}), ...(meta.columns ?? {}) };
  const columns: Record<string, string[]> = {};
  for (const t of kept) if (merged[t]?.length) columns[t] = [...new Set(merged[t])];
  const next: SelectionState = {
    conversationId,
    tenantId,
    connectionId: meta.connectionId ?? prev?.connectionId ?? "",
    connectionLabel: meta.connectionLabel ?? prev?.connectionLabel,
    tables: kept,
    columns,
    updatedAt: Date.now(),
  };
  states.set(conversationId, next);
  save();
  return next;
}

/** Pop one step of history. Returns null when there's nothing to undo. */
export function undoSelection(conversationId: string, tenantId: string): SelectionState | null {
  load();
  const stack = undoStacks.get(conversationId);
  if (!stack?.length) return null;
  const cur = states.get(conversationId);
  if (cur && cur.tenantId !== tenantId) return null;
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
  states.set(conversationId, next);
  save();
  return next;
}

export function canUndo(conversationId: string): boolean {
  return (undoStacks.get(conversationId)?.length ?? 0) > 0;
}

/** Forget a selection entirely (used when its tables are published as a source). */
export function dropSelection(conversationId: string, tenantId: string): boolean {
  load();
  const s = states.get(conversationId);
  if (!s || s.tenantId !== tenantId) return false;
  states.delete(conversationId);
  undoStacks.delete(conversationId);
  save();
  return true;
}

/** Test seam: forget everything held in memory (the file is left alone). */
export function _resetSelectionsForTest(): void {
  states.clear();
  undoStacks.clear();
  loaded = false;
}
