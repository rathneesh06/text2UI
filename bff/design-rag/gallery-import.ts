// bff/design-rag/gallery-import.ts — CLI to import the curated galleries.
//   npm run import:gallery -- recharts     # or: echarts | all (default)
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { makeGalleryAdapter, type GallerySpec } from "./gallery";
import { RECHARTS_SPECS } from "./gallery-recharts";
import { ECHARTS_SPECS } from "./gallery-echarts";
import { runImport } from "./import";

export const GALLERIES: Record<string, GallerySpec[]> = {
  recharts: RECHARTS_SPECS,
  echarts: ECHARTS_SPECS,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const which = process.argv[2] ?? "all";
  const names = which === "all" ? Object.keys(GALLERIES) : [which];
  if (names.some((n) => !GALLERIES[n])) {
    console.error(`usage: import:gallery -- <recharts|echarts|all>`);
    process.exit(1);
  }
  if ((process.env.STORAGE ?? "").toLowerCase() !== "postgres" || !process.env.PG_URL || !process.env.GEMINI_API_KEY) {
    console.error("import:gallery needs STORAGE=postgres, PG_URL, and GEMINI_API_KEY");
    process.exit(1);
  }
  (async () => {
    for (const name of names) {
      const adapter = makeGalleryAdapter(name, GALLERIES[name], { onError: (id, e) => console.warn(`  ${id} render failed: ${e.message}`) });
      const s = await runImport(adapter, { onItemError: (e) => console.warn(`  ingest failed: ${e.message}`) });
      console.log(`[design-rag] gallery ${name}: imported ${s.imported}, skipped ${s.skipped}, rejected ${s.rejected}, failed ${s.failed}`);
    }
    process.exit(0);
  })().catch((e) => { console.error(`gallery import failed: ${(e as Error).message}`); process.exit(1); });
}
