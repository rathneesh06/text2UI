// bff/design-rag/retire.ts — corpus maintenance: prune dead weight.
//
//   npm run retire:designrag
//
// Removes refs that are below the quality floor or have never been retrieved
// after a grace period (exemplar seeds are protected), then deletes their PNG
// files. The companion to dedup: dedup keeps duplicates out, retire keeps
// stale/low-value refs from accumulating and homogenizing retrieval.
import "dotenv/config";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { DESIGN_RAG_RETIRE_MIN_QUALITY, DESIGN_RAG_RETIRE_GRACE_DAYS } from "./config";
import { makePgVectorStore, type PgVectorStore } from "./store";

export type RetireStore = Pick<PgVectorStore, "retireRefs">;

export interface RetireDeps {
  store?: RetireStore | null;
  unlinkImage?: (path: string) => Promise<void>;
  minQuality?: number;
  graceDays?: number;
}

export interface RetireSummary { retired: number; imagesDeleted: number; imagesMissing: number; }

export async function runRetire(deps: RetireDeps = {}): Promise<RetireSummary> {
  const store = deps.store !== undefined ? deps.store : makePgVectorStore();
  if (!store) return { retired: 0, imagesDeleted: 0, imagesMissing: 0 };
  const minQuality = deps.minQuality ?? DESIGN_RAG_RETIRE_MIN_QUALITY;
  const graceDays = deps.graceDays ?? DESIGN_RAG_RETIRE_GRACE_DAYS;
  const unlinkImage = deps.unlinkImage ?? ((p: string) => fs.unlink(p));

  const removed = await store.retireRefs({ minQuality, graceDays });
  let imagesDeleted = 0, imagesMissing = 0;
  for (const r of removed) {
    try { await unlinkImage(r.imagePath); imagesDeleted++; }
    catch { imagesMissing++; }   // already gone / unreadable — fine
  }
  return { retired: removed.length, imagesDeleted, imagesMissing };
}

// CLI — runs only when executed directly (not when imported by the test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if ((process.env.STORAGE ?? "").toLowerCase() !== "postgres" || !process.env.PG_URL) {
    console.error("retire:designrag needs STORAGE=postgres and PG_URL");
    process.exit(1);
  }
  runRetire()
    .then((s) => {
      console.log(`[design-rag] retire: removed ${s.retired} ref(s); images deleted ${s.imagesDeleted}, missing ${s.imagesMissing}`);
      process.exit(0);
    })
    .catch((e) => { console.error(`retire failed: ${(e as Error).message}`); process.exit(1); });
}
