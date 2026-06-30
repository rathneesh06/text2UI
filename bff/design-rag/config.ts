// bff/design-rag/config.ts — Design Retrieval (design-RAG) knobs.
//
// One place owns the dimensions/model/flags so the embedding client, the
// pgvector migration, and the store can never drift. Everything is
// env-overridable; defaults keep dev simple and the feature OFF until seeded.

/** Multimodal embedding model on the Gemini Developer API (same key as
 *  generation). gemini-embedding-2 maps text + images into ONE shared space,
 *  so a text/schema query can retrieve a screenshot. */
export const DESIGN_EMBED_MODEL = process.env.DESIGN_EMBED_MODEL ?? "gemini-embedding-2";

/** Output dimensionality. gemini-embedding-2 defaults to 3072 but supports
 *  Matryoshka truncation; 768 keeps pgvector compact at high quality. MUST equal
 *  the vector(...) column width in the _design_refs migration. */
export const DESIGN_EMBED_DIM = Number(process.env.DESIGN_EMBED_DIM ?? 768);

/** Master feature flag for retrieval at build time. OFF by default: until the
 *  corpus is seeded and A/B'd, builds use the existing text exemplar unchanged. */
export const DESIGN_RAG_ENABLED = (process.env.DESIGN_RAG_ENABLED ?? "0") === "1";

/** Default top-K references injected into a build prompt. Small on purpose
 *  (each image is real input-token cost — watch bff/metrics.ts). */
export const DESIGN_RAG_K = Number(process.env.DESIGN_RAG_K ?? 3);

/** Minimum P7 quality a reference must clear, both to be auto-enrolled (§5.7)
 *  and to be eligible for retrieval (§5.5 metadata filter). */
export const DESIGN_RAG_MIN_QUALITY = Number(process.env.DESIGN_RAG_MIN_QUALITY ?? 0.6);

/** Where reference PNGs live on disk (Phase A: local dir; object store later).
 *  _design_refs.image_path points into here. */
export const DESIGN_RAG_CORPUS_DIR = process.env.DESIGN_RAG_CORPUS_DIR ?? "bff/design-rag/corpus";

/** Max Hamming distance (out of 64 bits) for two perceptual hashes to count as
 *  the same design at dedup time. ~5 tolerates re-renders/AA noise without
 *  merging genuinely different layouts. */
export const DESIGN_RAG_PHASH_MAX_HAMMING = Number(process.env.DESIGN_RAG_PHASH_MAX_HAMMING ?? 5);

/** Retire pass: drop generation refs below this quality (e.g. enrolled under an
 *  older, looser gate). Exemplar seeds are never retired. */
export const DESIGN_RAG_RETIRE_MIN_QUALITY = Number(process.env.DESIGN_RAG_RETIRE_MIN_QUALITY ?? 0.6);

/** Retire pass: drop refs never retrieved after this many days (give new refs
 *  time to prove useful before pruning). */
export const DESIGN_RAG_RETIRE_GRACE_DAYS = Number(process.env.DESIGN_RAG_RETIRE_GRACE_DAYS ?? 30);

/** Render service: max concurrent headless renders against the shared browser.
 *  Caps resource use when many enrollments render at once. */
export const DESIGN_RAG_RENDER_CONCURRENCY = Math.max(1, Number(process.env.DESIGN_RAG_RENDER_CONCURRENCY ?? 2));

/** Render service: close the shared browser after this many ms idle (0 = keep
 *  open). Releases Chromium between bursts. */
export const DESIGN_RAG_RENDER_IDLE_MS = Number(process.env.DESIGN_RAG_RENDER_IDLE_MS ?? 30000);
