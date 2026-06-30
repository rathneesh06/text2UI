// bff/design-rag/ingest.ts — put references INTO the corpus.
//
// ingestOne() runs the full pipeline for one screenshot:
//   hash -> pre-dedup (skip if phash seen) -> caption -> embed(image)+embed(note)
//   -> write PNG to the corpus dir -> store.insert.
// seedFromExemplars() drives it over the exemplar library for cold-start.
//
// Every collaborator is injectable (store, embed, caption, hash, writeImage,
// idgen, render) so the orchestration is fully offline-testable; the only piece
// that needs a real browser is the `render` function, supplied by the seed CLI
// (increment 6b). Best-effort by contract: a single bad design never aborts a
// batch — it's counted as failed and the seed continues.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DESIGN_RAG_CORPUS_DIR, DESIGN_RAG_PHASH_MAX_HAMMING } from "./config";
import { phash as defaultPhash } from "./hash";
import { captionDesign, formatDesignNote, type DesignNote } from "./caption";
import type { EmbeddingClient } from "./embeddings";
import type { PgVectorStore, DesignMode, DesignRefInsert } from "./store";

/** Just the store methods ingest needs — lets tests inject a fake. */
export type IngestStore = Pick<PgVectorStore, "insert" | "existsByPhash" | "findSimilarPhash">;

export interface IngestDeps {
  store: IngestStore;
  embed: EmbeddingClient;
  caption?: (png: Buffer, opts?: { domainHint?: string }) => Promise<DesignNote>;
  hash?: (png: Buffer) => string;
  writeImage?: (path: string, data: Buffer) => Promise<void>;
  idgen?: () => string;
  corpusDir?: string;
  maxHamming?: number;
}

export interface IngestInput {
  png: Buffer;
  source: string;            // 'exemplar-seed' | 'generation' | 'figma' | 'dataset:<name>'
  mode?: DesignMode;         // default 'dashboard'
  domainHint?: string;
  quality?: number;          // P7 score (1 for gold-standard exemplars)
  license?: string | null;
  attribution?: string | null; // human-readable credit (required for CC-BY)
  sourceUrl?: string | null;   // origin URL (repo/file)
}

export type IngestResult = "inserted" | "skipped" | "failed";

const defaultId = () => `ref_${randomUUID()}`;

/** Ingest a single design PNG. Never throws — returns a status. */
export async function ingestOne(input: IngestInput, deps: IngestDeps): Promise<IngestResult> {
  const hashOf = deps.hash ?? defaultPhash;
  const caption = deps.caption ?? ((png, o) => captionDesign(png, o));
  const writeImage = deps.writeImage ?? ((path, data) => fs.writeFile(path, data));
  const idgen = deps.idgen ?? defaultId;
  const corpusDir = deps.corpusDir ?? DESIGN_RAG_CORPUS_DIR;
  const maxHamming = deps.maxHamming ?? DESIGN_RAG_PHASH_MAX_HAMMING;
  try {
    const ph = hashOf(input.png);
    // Pre-dedup: an EXACT or perceptually-similar phash means skip the expensive
    // caption/embed/write. Catches near-identical re-renders, not just byte-dups.
    if (await deps.store.findSimilarPhash(ph, maxHamming, input.mode ?? "dashboard")) return "skipped";

    const note = await caption(input.png, { domainHint: input.domainHint });
    const noteText = formatDesignNote(note);
    const [imgEmbed, capEmbed] = await Promise.all([
      deps.embed.embedImage(input.png),
      deps.embed.embedText(noteText),
    ]);

    const id = idgen();
    const imagePath = join(corpusDir, `${id}.png`);
    await writeImage(imagePath, input.png);

    const ref: DesignRefInsert = {
      id,
      domain: note.domain || input.domainHint || "generic",
      mode: input.mode ?? "dashboard",
      imagePath,
      phash: ph,
      caption: noteText,
      tags: { chartTypes: note.chartTypes, layout: note.layout, density: note.density },
      source: input.source,
      license: input.license ?? null,
      attribution: input.attribution ?? null,
      sourceUrl: input.sourceUrl ?? null,
      quality: input.quality ?? 0,
      imgEmbed,
      capEmbed,
    };
    const inserted = await deps.store.insert(ref);   // false only on a phash race
    return inserted ? "inserted" : "skipped";
  } catch {
    return "failed";
  }
}

export interface ExemplarSeed {
  domain: string;
  render: () => Promise<Buffer>;   // produces the PNG (Playwright harness in 6b)
}

export interface SeedSummary {
  total: number;
  inserted: number;
  skipped: number;
  failed: number;
}

/** Cold-start: render + ingest each exemplar as a gold-standard reference. */
export async function seedFromExemplars(seeds: ExemplarSeed[], deps: IngestDeps): Promise<SeedSummary> {
  const summary: SeedSummary = { total: seeds.length, inserted: 0, skipped: 0, failed: 0 };
  for (const seed of seeds) {
    let png: Buffer;
    try {
      png = await seed.render();
    } catch {
      summary.failed++;                 // render failed -> count and continue
      continue;
    }
    const result = await ingestOne(
      { png, source: "exemplar-seed", domainHint: seed.domain, quality: 1, mode: "dashboard" },
      deps,
    );
    summary[result]++;
  }
  return summary;
}
