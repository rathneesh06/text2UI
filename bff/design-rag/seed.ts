// bff/design-rag/seed.ts — one-time cold-start seeding CLI.
//
//   npm run seed:designrag
//
// Renders each exemplar (Playwright) and ingests it as a gold-standard design
// reference. Requires Postgres+pgvector (STORAGE=postgres + PG_URL), a Gemini
// key (captions + embeddings), and Playwright's browser installed.
import "dotenv/config";
import { promises as fs } from "node:fs";
import { REGISTRY } from "../exemplars";
import { renderExemplarToPng } from "./render";
import { seedFromExemplars, type ExemplarSeed } from "./ingest";
import { makePgVectorStore } from "./store";
import { makeEmbeddingClient } from "./embeddings";
import { DESIGN_RAG_CORPUS_DIR } from "./config";

async function main(): Promise<void> {
  if ((process.env.STORAGE ?? "").toLowerCase() !== "postgres" || !process.env.PG_URL) {
    console.error("seed:designrag needs STORAGE=postgres and PG_URL in .env");
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("seed:designrag needs GEMINI_API_KEY (captions + embeddings)");
    process.exit(1);
  }
  const store = makePgVectorStore();
  if (!store) {
    console.error("seed:designrag: could not build the pgvector store");
    process.exit(1);
  }
  await fs.mkdir(DESIGN_RAG_CORPUS_DIR, { recursive: true });

  const live = REGISTRY.filter((e) => e.code.trim().length > 0);
  const seeds: ExemplarSeed[] = live.map((e) => ({
    domain: e.domain,
    render: () => renderExemplarToPng(e.code),
  }));

  console.log(`Seeding ${seeds.length} exemplar(s) into ${DESIGN_RAG_CORPUS_DIR} ...`);
  const summary = await seedFromExemplars(seeds, { store, embed: makeEmbeddingClient() });
  console.log(
    `Done: inserted=${summary.inserted} skipped=${summary.skipped} failed=${summary.failed} (total ${summary.total})`,
  );
  // Exit non-zero only if nothing made it in.
  process.exit(summary.inserted === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`seed:designrag failed: ${(err as Error).message}`);
  process.exit(1);
});
