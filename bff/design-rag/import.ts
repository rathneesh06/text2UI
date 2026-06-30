// bff/design-rag/import.ts — the spine for curated design-reference imports.
//
// Every external source (Tremor, TailAdmin, viz galleries, Figma) is just a
// DesignSourceAdapter that yields rendered ImportItems. runImport pushes each
// through the SAME pipeline as enrollment — perceptual dedup, caption, embed,
// store — plus a density gate so even curated imports can't introduce sprawl.
// Provenance (license/attribution/sourceUrl) is required and recorded per item.
//
// Adapters own "how do I get a PNG from this source"; the spine owns "how does a
// PNG become a clean corpus entry". Everything is injectable for offline tests.

import { ingestOne, type IngestStore } from "./ingest";
import { checkLayout } from "../eval/scorers";
import { makeEmbeddingClient, type EmbeddingClient } from "./embeddings";
import { makePgVectorStore } from "./store";
import type { DesignMode } from "./store";
import type { DesignNote } from "./caption";

export interface ImportItem {
  png: Buffer;
  domainHint?: string;
  mode?: DesignMode;            // default 'dashboard'
  license: string;             // REQUIRED for imports — e.g. 'MIT', 'CC-BY-4.0'
  attribution?: string | null; // human-readable credit (required by CC-BY)
  sourceUrl?: string | null;   // repo/file URL the item came from
  code?: string;               // the source that produced the png; enables the density gate
  tags?: Record<string, unknown>;
}

export interface DesignSourceAdapter {
  /** Short id, becomes the ref source: `import:<name>`. */
  name: string;
  /** Stream rendered reference items (async so adapters can fetch/render lazily). */
  items(): AsyncIterable<ImportItem>;
}

export interface ImportDeps {
  store?: IngestStore | null;
  embed?: EmbeddingClient;
  ingest?: typeof ingestOne;
  caption?: (png: Buffer, opts?: { domainHint?: string }) => Promise<DesignNote>;
  densityGate?: boolean;       // default true — reject sprawling layouts when code is available
  maxHamming?: number;
  /** Quality assigned to curated imports (gold-standard by default, like seeds,
   *  so they're never retired on quality — only on never-being-retrieved). */
  quality?: number;
  /** Called when an item fails to ingest — surfaces the real error for diagnosis. */
  onItemError?: (err: Error) => void;
}

export interface ImportSummary { imported: number; skipped: number; rejected: number; failed: number }

export async function runImport(adapter: DesignSourceAdapter, deps: ImportDeps = {}): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, skipped: 0, rejected: 0, failed: 0 };
  const store = deps.store !== undefined ? deps.store : makePgVectorStore();
  if (!store) return summary;

  const embed = deps.embed ?? makeEmbeddingClient();
  const ingest = deps.ingest ?? ingestOne;
  const densityGate = deps.densityGate ?? true;
  const quality = deps.quality ?? 1;
  const source = `import:${adapter.name}`;

  for await (const item of adapter.items()) {
    try {
      if (!item.license) { summary.failed++; continue; }                       // provenance is mandatory
      if (densityGate && item.code && !checkLayout(item.code).pass) { summary.rejected++; continue; }
      const res = await ingest(
        {
          png: item.png,
          source,
          mode: item.mode ?? "dashboard",
          domainHint: item.domainHint,
          license: item.license,
          attribution: item.attribution ?? null,
          sourceUrl: item.sourceUrl ?? null,
          quality,
        },
        { store, embed, caption: deps.caption, maxHamming: deps.maxHamming },
      );
      if (res === "inserted") summary.imported++;
      else if (res === "skipped") summary.skipped++;
      else summary.failed++;
    } catch (err) {
      summary.failed++;   // one bad item never aborts the batch
      deps.onItemError?.(err as Error);
    }
  }
  return summary;
}
