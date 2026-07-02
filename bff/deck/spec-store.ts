// bff/deck/spec-store.ts — the Presentation Spec Store + Deck State Observer + the
// foundation for Diff/Version History. Each deck gets an id and a linear version list;
// every build/edit commits a new version. This makes the spec the durable source of
// truth (survives refresh, addressable by id) instead of living only in React state, and
// gives us undo/revert for free. In-memory for now behind a tiny interface so it can be
// swapped for Postgres without touching callers.
import { randomUUID } from "crypto";
import type { DeckSpec } from "../../shared/deck-spec";

export interface DeckVersion { version: number; spec: DeckSpec; label: string; at: number }
interface StoredDeck { id: string; versions: DeckVersion[] }

const decks = new Map<string, StoredDeck>();
const MAX_VERSIONS = 50;

/** Create a new deck record from the first spec. Returns its id + version 1. */
export function createDeck(spec: DeckSpec, label = "Initial deck"): { deckId: string; version: number } {
  const id = randomUUID();
  decks.set(id, { id, versions: [{ version: 1, spec, label, at: Date.now() }] });
  return { deckId: id, version: 1 };
}

/** Latest spec for a deck, or undefined if unknown. */
export function currentSpec(deckId: string): DeckSpec | undefined {
  const d = decks.get(deckId);
  return d?.versions[d.versions.length - 1]?.spec;
}

/** Commit a new version (an applied edit or rebuild). */
export function commit(deckId: string, spec: DeckSpec, label: string): { version: number } | null {
  const d = decks.get(deckId);
  if (!d) return null;
  const version = (d.versions[d.versions.length - 1]?.version ?? 0) + 1;
  d.versions.push({ version, spec, label, at: Date.now() });
  if (d.versions.length > MAX_VERSIONS) d.versions.splice(0, d.versions.length - MAX_VERSIONS);
  return { version };
}

/** Revert to an earlier version by re-committing it as the newest (non-destructive undo). */
export function revert(deckId: string, toVersion: number): { spec: DeckSpec; version: number } | null {
  const d = decks.get(deckId);
  if (!d) return null;
  const target = d.versions.find((v) => v.version === toVersion);
  if (!target) return null;
  const version = (d.versions[d.versions.length - 1]?.version ?? 0) + 1;
  d.versions.push({ version, spec: target.spec, label: `Revert to v${toVersion}`, at: Date.now() });
  return { spec: target.spec, version };
}

/** Version history (labels + numbers) for the UI. */
export function history(deckId: string): { version: number; label: string; at: number }[] {
  return (decks.get(deckId)?.versions ?? []).map((v) => ({ version: v.version, label: v.label, at: v.at }));
}