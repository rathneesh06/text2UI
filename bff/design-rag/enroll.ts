// bff/design-rag/enroll.ts — the eval-gated enrollment flywheel (§5.7).
//
// After a successful dashboard build, the server calls this (fire-and-forget).
// It scores the app with the P7 scorers and, only if it clears the gate, renders
// + captions + embeds + stores it as a new reference (source:'generation').
//
// Two safety properties:
//   1. The gate IS the eval — all HARD dims pass, the leakage dim passes, and the
//      score clears the quality floor. Garbage can't enter the corpus.
//   2. Rendering goes through the mock-data harness, so enrolled screenshots use
//      SYNTHETIC data — never real tenant rows (the KT PII risk).
//
// Never throws; returns a status. Everything is injected for offline testing.

import { scoreApp, mainFileContent, type AppScore, type ScoreContext } from "../eval/scorers";
import type { Dataset, GeneratedApp } from "../../shared/types";
import { DESIGN_RAG_ENABLED, DESIGN_RAG_MIN_QUALITY } from "./config";
import { makePgVectorStore } from "./store";
import { makeEmbeddingClient, type EmbeddingClient } from "./embeddings";
import { renderExemplarToPng } from "./render";
import { ingestOne, type IngestStore } from "./ingest";

export type EnrollResult = "enrolled" | "skipped" | "rejected" | "failed";

export interface EnrollDeps {
  enabled?: boolean;
  store?: IngestStore | null;
  embed?: EmbeddingClient;
  scorer?: (app: GeneratedApp, ctx: ScoreContext) => AppScore;
  render?: (code: string) => Promise<Buffer>;
  ingest?: typeof ingestOne;
  minQuality?: number;
  exemplarCode?: string;   // injected exemplar/reference text, for the leakage dim
  source?: string;         // provenance tag for ingest (default "generation"; e.g. "synth:sales")
}

function toScoreDatasets(datasets: Dataset[]): ScoreContext["datasets"] {
  return datasets.map((d) => ({
    tableName: d.tableName,
    columns: (d.profile?.columns ?? []).map((c) => c.name),
  }));
}

function softDimPassed(score: AppScore, dimension: string): boolean {
  const dim = score.results.find((r) => r.dimension === dimension);
  return dim ? dim.pass : true;
}

export async function enrollGeneration(
  app: GeneratedApp,
  datasets: Dataset[],
  domain: string,
  deps: EnrollDeps = {},
): Promise<EnrollResult> {
  const enabled = deps.enabled ?? DESIGN_RAG_ENABLED;
  if (!enabled) return "skipped";
  try {
    const store = deps.store !== undefined ? deps.store : makePgVectorStore();
    if (!store) return "skipped";

    const scorer = deps.scorer ?? scoreApp;
    const minQuality = deps.minQuality ?? DESIGN_RAG_MIN_QUALITY;
    const score = scorer(app, { datasets: toScoreDatasets(datasets), exemplarCode: deps.exemplarCode });

    // The gate: all HARD dims pass, the leakage AND layout (density) dims pass,
    // and the score clears the floor. The layout check keeps sprawling designs
    // out of the corpus so they can't propagate via retrieval.
    const gated = score.pass && softDimPassed(score, "leakage") && softDimPassed(score, "layout") && score.score >= minQuality;
    if (!gated) {
      const why = !score.pass ? "hard" : !softDimPassed(score, "layout") ? "layout" : !softDimPassed(score, "leakage") ? "leakage" : "score";
      console.log(`[design-rag] enroll rejected domain=${domain} (reason=${why} score=${score.score.toFixed(2)})`);
      return "rejected";
    }

    const render = deps.render ?? renderExemplarToPng;
    const ingest = deps.ingest ?? ingestOne;
    const png = await render(mainFileContent(app));   // synthetic data -> no PII
    const result = await ingest(
      { png, source: deps.source ?? "generation", domainHint: domain, quality: score.score, mode: "dashboard" },
      { store, embed: deps.embed ?? makeEmbeddingClient() },
    );
    if (result === "inserted") {
      console.log(`[design-rag] enrolled a generation domain=${domain} quality=${score.score.toFixed(2)}`);
      return "enrolled";
    }
    return result === "skipped" ? "skipped" : "failed";
  } catch (err) {
    console.warn(`[design-rag] enroll failed (swallowed): ${(err as Error).message}`);
    return "failed";
  }
}
