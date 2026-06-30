// bff/design-rag/retrieve.ts — per-build design retrieval (KT §5.5).
//
// Turns a build request into the few most relevant design references:
//   query text (prompt + domain + schema) -> embed -> ANN search filtered by
//   metadata (mode/domain/quality) -> domain-then-generic fallback -> diversify
//   top-K by layout -> bump usage counters -> return refs.
//
// GRACEFUL DEGRADATION is the contract: any failure (no store, embed error,
// empty corpus, ANN error) returns [] and the build proceeds on the text
// exemplar exactly as today. Retrieval never throws into the build path.

import { DESIGN_RAG_K, DESIGN_RAG_MIN_QUALITY } from "./config";
import type { EmbeddingClient } from "./embeddings";
import type { PgVectorStore, DesignRefRow, DesignMode } from "./store";

/** Only the store methods retrieval needs — lets tests inject a fake. */
export type RetrievalStore = Pick<PgVectorStore, "annSearch" | "incRetrievals">;

/** Lean reference handed to the build path. `imagePath` is a pointer; the caller
 *  loads the PNG bytes and builds the image part. */
export interface DesignRef {
  id: string;
  imagePath: string;
  caption: string;
  domain: string;
  quality: number;
  distance: number;                 // cosine distance from the query (lower = closer)
  tags: Record<string, unknown>;
}

export interface RetrieveOpts {
  domain: string;
  mode: DesignMode;
  userPrompt: string;
  schemaSummary: string;            // from bff/domain.ts schemaSummary(datasets)
  store: RetrievalStore | null;     // null when Postgres/pgvector isn't configured
  embed: EmbeddingClient;
  k?: number;
  minQuality?: number;
}

/** The text we embed to search the shared multimodal space. */
export function buildQueryText(opts: { userPrompt: string; domain: string; schemaSummary: string }): string {
  return `${opts.userPrompt.trim()} | domain:${opts.domain} | schema:${opts.schemaSummary.trim()}`;
}

/** Greedily pick k refs preferring distinct layout buckets, then fill if short. */
function diversify(rows: DesignRefRow[], k: number): DesignRefRow[] {
  const bucketOf = (r: DesignRefRow): string => {
    const layout = typeof r.tags?.layout === "string" ? (r.tags.layout as string).trim().toLowerCase() : "";
    return layout || `id:${r.id}`; // no layout tag -> its own bucket (no grouping)
  };
  const picked: DesignRefRow[] = [];
  const usedBuckets = new Set<string>();
  for (const r of rows) {                         // pass 1: variety
    if (picked.length >= k) break;
    const b = bucketOf(r);
    if (!usedBuckets.has(b)) { usedBuckets.add(b); picked.push(r); }
  }
  if (picked.length < k) {                         // pass 2: fill remaining slots
    const have = new Set(picked.map((p) => p.id));
    for (const r of rows) {
      if (picked.length >= k) break;
      if (!have.has(r.id)) picked.push(r);
    }
  }
  return picked.slice(0, k);
}

function toDesignRef(r: DesignRefRow): DesignRef {
  return {
    id: r.id,
    imagePath: r.imagePath,
    caption: r.caption ?? "",
    domain: r.domain,
    quality: r.quality,
    distance: r.distance ?? 0,
    tags: r.tags ?? {},
  };
}

export async function retrieveReferences(opts: RetrieveOpts): Promise<DesignRef[]> {
  const { domain, mode, userPrompt, schemaSummary, store, embed } = opts;
  const k = Math.max(1, opts.k ?? DESIGN_RAG_K);
  const minQuality = opts.minQuality ?? DESIGN_RAG_MIN_QUALITY;
  if (!store) return [];                           // Postgres not configured -> text exemplar
  try {
    const qv = await embed.embedText(buildQueryText({ userPrompt, domain, schemaSummary }));
    const overfetch = k * 3;                        // headroom for diversification

    let candidates = await store.annSearch({ queryVec: qv, mode, domains: [domain], minQuality, k: overfetch });
    // Top up with generic refs if the domain corpus is thin (mirrors exemplar fallback).
    if (candidates.length < k && domain !== "generic") {
      const generic = await store.annSearch({ queryVec: qv, mode, domains: ["generic"], minQuality, k: overfetch });
      const have = new Set(candidates.map((c) => c.id));
      candidates = candidates.concat(generic.filter((g) => !have.has(g.id)));
    }
    if (!candidates.length) return [];

    const chosen = diversify(candidates, k);
    if (!chosen.length) return [];
    try { await store.incRetrievals(chosen.map((c) => c.id)); } catch { /* best-effort counter */ }
    return chosen.map(toDesignRef);
  } catch (err) {
    console.warn(`[design-rag] retrieval failed, using text exemplar: ${(err as Error).message}`);
    return [];
  }
}
