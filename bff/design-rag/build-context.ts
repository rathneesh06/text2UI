// bff/design-rag/build-context.ts — the seam between async retrieval and the
// (sync) assembler. The server calls this on a build turn; it returns the note
// block to inject (in place of the text exemplar) plus the reference images to
// attach to the model call.
//
// Flag-gated (DESIGN_RAG_ENABLED), build-turn-only, dashboard-only, and never
// throws — EMPTY on flag-off / no store / no refs / any failure means the build
// falls back to exemplarBlock() exactly as today. Collaborators are injectable
// so the orchestration is fully offline-testable.

import { promises as fs } from "node:fs";
import type { AssembleInput } from "../../shared/types";
import type { ImagePart } from "../aiflow";
import { buildEnrichment, schemaSummary } from "../domain";
import { DESIGN_RAG_ENABLED } from "./config";
import { makeEmbeddingClient, type EmbeddingClient } from "./embeddings";
import { makePgVectorStore } from "./store";
import { retrieveReferences, type RetrievalStore, type DesignRef } from "./retrieve";

export interface BuildReferences {
  referenceBlock: string;          // injected into the build prompt (text notes)
  images: ImagePart[];             // attached to the model call (the visuals)
  refs: DesignRef[];               // refs whose images were actually attached
}

const EMPTY: BuildReferences = { referenceBlock: "", images: [], refs: [] };

export interface BuildRefDeps {
  enabled?: boolean;
  store?: RetrievalStore | null;   // undefined -> makePgVectorStore(); null -> degrade
  embed?: EmbeddingClient;
  retrieve?: typeof retrieveReferences;
  readImage?: (path: string) => Promise<Buffer>;
  domainOf?: (input: AssembleInput) => string;
  schemaOf?: (input: AssembleInput) => string;
}

function isBuildTurn(input: AssembleInput): boolean {
  return !input.currentCode && !input.lastError;
}

export async function retrieveForBuild(
  input: AssembleInput,
  deps: BuildRefDeps = {},
): Promise<BuildReferences> {
  const enabled = deps.enabled ?? DESIGN_RAG_ENABLED;
  if (!enabled || !isBuildTurn(input)) return EMPTY;
  try {
    const store = deps.store !== undefined ? deps.store : makePgVectorStore();
    if (!store) return EMPTY;
    const embed = deps.embed ?? makeEmbeddingClient();
    const retrieve = deps.retrieve ?? retrieveReferences;
    const readImage = deps.readImage ?? ((path: string) => fs.readFile(path));
    const domain = (deps.domainOf ?? ((i) => buildEnrichment(i.datasets, i.modelDomain).domain))(input);
    const schema = (deps.schemaOf ?? ((i) => schemaSummary(i.datasets)))(input);

    const refs = await retrieve({
      domain,
      mode: "dashboard",
      userPrompt: input.userPrompt,
      schemaSummary: schema,
      store,
      embed,
    });
    if (!refs.length) return EMPTY;

    // Load each ref's PNG; keep only refs whose image we can attach so the notes
    // stay aligned with the images. A missing/unreadable file just drops that ref.
    const images: ImagePart[] = [];
    const kept: DesignRef[] = [];
    for (const ref of refs) {
      try {
        const png = await readImage(ref.imagePath);
        images.push({ mimeType: "image/png", dataB64: png.toString("base64") });
        kept.push(ref);
      } catch { /* unreadable image -> skip this ref */ }
    }
    if (!images.length) return EMPTY;

    const referenceBlock = [
      "",
      "Reference designs to MATCH for visual quality, layout, and composition.",
      "DO NOT copy their data, labels, or any text content — use the user's real data:",
      ...kept.map((r, i) => `- [reference ${i + 1}] ${r.caption || "(no note)"}`),
    ].join("\n");

    console.log(`[design-rag] injected ${images.length} reference(s) for domain=${domain} (ids: ${kept.map((r) => r.id).join(", ")})`);
    return { referenceBlock, images, refs: kept };
  } catch (err) {
    console.warn(`[design-rag] build-context failed, using text exemplar: ${(err as Error).message}`);
    return EMPTY;
  }
}
