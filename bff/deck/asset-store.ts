// bff/deck/asset-store.ts — the Asset Store. Holds uploaded assets (logos, images) so a
// deck spec can reference one by id and the renderer can embed it. Assets are scoped to a
// deck/session so they survive across edit turns. In-memory behind a small interface; swap
// for object storage later without touching callers.
import type { Asset } from "../../shared/ingest";

const byDeck = new Map<string, Map<string, Asset>>();
const MAX_PER_DECK = 40;

function bucket(scope: string): Map<string, Asset> {
  let m = byDeck.get(scope);
  if (!m) { m = new Map(); byDeck.set(scope, m); }
  return m;
}

/** Store an asset under a scope (deckId or session id). Returns its id. */
export function putAsset(scope: string, asset: Asset): string {
  const m = bucket(scope);
  if (m.size >= MAX_PER_DECK) m.delete(m.keys().next().value as string);
  m.set(asset.id, asset);
  return asset.id;
}

export function getAsset(scope: string, id: string): Asset | undefined { return byDeck.get(scope)?.get(id); }
export function listAssets(scope: string): Asset[] { return [...(byDeck.get(scope)?.values() ?? [])]; }
export function moveScope(from: string, to: string): void {
  const src = byDeck.get(from); if (!src) return;
  const dst = bucket(to);
  for (const [id, a] of src) dst.set(id, a);
  byDeck.delete(from);
}