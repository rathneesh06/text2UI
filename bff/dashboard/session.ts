// bff/dashboard/session.ts — the dashboard Context Manager + Diff History.
//
// This is the layer that connects the CHAT to the ARTIFACT, the way editing
// software does: every accepted build/edit is pushed as a VERSION against the
// conversation, the user's asks accumulate as rolling DECISIONS, and the edit
// planner receives both — so "make it like before", "undo that", and "the
// chart we added earlier" resolve against real state instead of guesswork.
//
// The deck pipeline has had this (bff/deck/session-store.ts) since Phase 2;
// the dashboard pipeline never got it — every edit turn saw only the current
// spec and the raw prompt, with the whole conversation invisible. This module
// closes that gap, mirroring the deck store's design: in-memory per
// conversation (the raw chat itself is already durable in the chat store;
// versions are session-scoped working state, like an editor's undo stack).
import type { DashboardSpec } from "../../shared/dashboard-spec";

export interface SpecVersion {
  spec: DashboardSpec;
  /** the human change summary the assistant replied with */
  summary: string;
  /** the user prompt that produced this version */
  prompt: string;
  at: number;
}

interface DashSession {
  versions: SpecVersion[];
  /** index of the CURRENT version in `versions` (undo/redo moves it) */
  cursor: number;
  /** rolling list of what the user asked for — fed to the edit planner */
  decisions: string[];
}

const MAX_VERSIONS = 20;
const MAX_DECISIONS = 12;
const sessions = new Map<string, DashSession>();

function ensure(convId: string): DashSession {
  let s = sessions.get(convId);
  if (!s) { s = { versions: [], cursor: -1, decisions: [] }; sessions.set(convId, s); }
  return s;
}

/** Record an accepted version. Editing after an undo truncates the redo branch —
 *  exactly like an editor's undo stack. */
export function pushVersion(convId: string, spec: DashboardSpec, summary: string, prompt: string): void {
  if (!convId) return;
  const s = ensure(convId);
  s.versions = s.versions.slice(0, s.cursor + 1);          // drop redo branch
  s.versions.push({ spec, summary, prompt: prompt.slice(0, 300), at: Date.now() });
  if (s.versions.length > MAX_VERSIONS) s.versions.splice(0, s.versions.length - MAX_VERSIONS);
  s.cursor = s.versions.length - 1;
  const d = prompt.trim().slice(0, 140);
  if (d && s.decisions[s.decisions.length - 1] !== d) s.decisions.push(d);
  if (s.decisions.length > MAX_DECISIONS) s.decisions.splice(0, s.decisions.length - MAX_DECISIONS);
}

export function versionCount(convId: string): number { return sessions.get(convId)?.versions.length ?? 0; }
export function cursorIndex(convId: string): number { return sessions.get(convId)?.cursor ?? -1; }

/** Step back one version. Null when there is nothing earlier. */
export function undo(convId: string): SpecVersion | null {
  const s = sessions.get(convId);
  if (!s || s.cursor <= 0) return null;
  s.cursor -= 1;
  return s.versions[s.cursor];
}

/** Step forward after an undo. Null when already at the newest version. */
export function redo(convId: string): SpecVersion | null {
  const s = sessions.get(convId);
  if (!s || s.cursor >= s.versions.length - 1) return null;
  s.cursor += 1;
  return s.versions[s.cursor];
}

/** The rolling decisions, rendered for the planner prompt. */
export function decisionsText(convId?: string): string | null {
  if (!convId) return null;
  const s = sessions.get(convId);
  if (!s || !s.decisions.length) return null;
  return "DECISIONS SO FAR (each shaped the current dashboard — do not silently undo them):\n" +
    s.decisions.map((d, i) => `${i + 1}. ${d}`).join("\n");
}

/** Deterministic history intents — undo/redo must be instant and exact, never a
 *  model's paraphrase of "make it like before". Kept intentionally narrow: only
 *  a bare command counts ("undo", "undo that", "revert", "go back", "redo");
 *  anything with real content ("undo the color but keep the chart") is an edit. */
export function detectHistoryIntent(prompt: string): "undo" | "redo" | null {
  const p = prompt.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(undo( that| this| it| last( change)?)?|revert( that| this| it)?|go back|previous version|undo the last change)$/.test(p)) return "undo";
  if (/^(redo( that| this| it)?|restore|go forward)$/.test(p)) return "redo";
  return null;
}

/** Test/maintenance helper. */
export function resetSession(convId: string): void { sessions.delete(convId); }
