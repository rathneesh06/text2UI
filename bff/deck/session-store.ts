// bff/deck/session-store.ts — the Context Manager: persisted Chat History + a rolling
// Session Summary, keyed by deckId. Every turn is recorded; the summary is refreshed
// deterministically from the latest spec (audience/tone/theme/topics) plus a capped log of
// user decisions. sessionContextText() renders it for the planner prompts so decisions
// persist across a long edit chain. In-memory behind a small interface (swap for a DB later).
import type { DeckSpec } from "../../shared/deck-spec";
import type { ChatTurn, SessionSummary } from "../../shared/session";

interface Session { deckId: string; turns: ChatTurn[]; summary: SessionSummary }

const sessions = new Map<string, Session>();
const MAX_TURNS = 40;
const MAX_DECISIONS = 8;
const MAX_TOPICS = 8;

function blank(): SessionSummary { return { slideCount: 0, topics: [], decisions: [] }; }

function ensure(deckId: string): Session {
  let s = sessions.get(deckId);
  if (!s) { s = { deckId, turns: [], summary: blank() }; sessions.set(deckId, s); }
  return s;
}

export function recordTurn(deckId: string, role: ChatTurn["role"], text: string): void {
  if (!deckId || !text) return;
  const s = ensure(deckId);
  s.turns.push({ role, text: text.slice(0, 500), at: Date.now() });
  if (s.turns.length > MAX_TURNS) s.turns.splice(0, s.turns.length - MAX_TURNS);
}

/** Refresh the rolling summary from the current spec, optionally logging a new decision. */
export function updateSummary(deckId: string, spec: DeckSpec, decision?: string): void {
  const s = ensure(deckId);
  const topics = spec.slides.filter((sl) => sl.role !== "title" && sl.role !== "section").map((sl) => sl.title).slice(0, MAX_TOPICS);
  const decisions = s.summary.decisions.slice();
  if (decision && decisions[decisions.length - 1] !== decision) decisions.push(decision);
  s.summary = {
    audience: spec.meta.audience,
    tone: spec.meta.tone,
    theme: spec.meta.theme,
    slideCount: spec.slides.length,
    topics,
    decisions: decisions.slice(-MAX_DECISIONS),
  };
}

export function getSummary(deckId: string): SessionSummary | undefined { return sessions.get(deckId)?.summary; }
export function getHistory(deckId: string): ChatTurn[] { return sessions.get(deckId)?.turns ?? []; }

/** Compact context block for planner prompts. Empty string if nothing worth including. */
export function sessionContextText(deckId?: string): string {
  if (!deckId) return "";
  const s = sessions.get(deckId);
  if (!s) return "";
  const { summary, turns } = s;
  const lines: string[] = [];
  const shape = [
    summary.audience && `audience ${summary.audience}`,
    summary.tone && `${summary.tone} tone`,
    summary.theme && `${summary.theme} theme`,
    summary.slideCount && `${summary.slideCount} slides`,
  ].filter(Boolean).join(", ");
  if (shape) lines.push(`Deck so far: ${shape}.`);
  if (summary.topics.length) lines.push(`Covered: ${summary.topics.join("; ")}.`);
  if (summary.decisions.length) lines.push(`Accepted decisions (keep these unless changed): ${summary.decisions.join("; ")}.`);
  const recent = turns.filter((t) => t.role === "user").slice(-3).map((t) => `"${t.text}"`);
  if (recent.length) lines.push(`Recent requests: ${recent.join(", ")}.`);
  return lines.length ? `SESSION CONTEXT:\n${lines.join("\n")}` : "";
}