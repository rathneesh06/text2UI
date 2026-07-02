// bff/deck/session-router.ts — the API Gateway / Session Router. Maps a conversationId to
// its active artifact (the current deckId), so a turn that arrives with only a
// conversationId resumes the right deck instead of building a new one, and a page reload can
// rehydrate state from the server. Ties together the Spec Store, Context Manager, and Asset
// Store (all already scoped by the same id). In-memory behind a small interface.
export interface SessionRec {
  conversationId: string;
  deckId?: string;
  artifact?: "deck" | "dashboard" | "doc";
  createdAt: number;
  lastAt: number;
}

const sessions = new Map<string, SessionRec>();
const MAX = 500;

/** Create/update the session record for a conversation. */
export function touchSession(conversationId: string, patch: Partial<Omit<SessionRec, "conversationId" | "createdAt">>): SessionRec {
  if (!conversationId) return { conversationId: "", createdAt: Date.now(), lastAt: Date.now() };
  let rec = sessions.get(conversationId);
  if (!rec) {
    if (sessions.size >= MAX) sessions.delete(sessions.keys().next().value as string);
    rec = { conversationId, createdAt: Date.now(), lastAt: Date.now() };
    sessions.set(conversationId, rec);
  }
  Object.assign(rec, patch, { lastAt: Date.now() });
  return rec;
}

export function getSession(conversationId: string): SessionRec | undefined { return sessions.get(conversationId); }

/** The active deckId for a conversation, if any — used to resume an edit without a client deckId. */
export function sessionDeckId(conversationId?: string): string | undefined {
  return conversationId ? sessions.get(conversationId)?.deckId : undefined;
}