// scripts/render-references.mts — re-render the built-in exemplars to clean PNGs.
//
//   npx tsx scripts/render-references.mts
//
// WHY: the 51 images in bff/design-rag/corpus/ were rendered by the synthetic
// data harness BEFORE it was fixed, so they carry $NaN, "Invalid Date", NATO
// callsigns in legends and impossible rates. Those are the images the model
// would be shown as design references. Fixing render-data.ts does not fix images
// already on disk — they have to be re-rendered.
//
// Unlike `npm run seed:designrag` this needs NO database and NO pgvector: it
// renders straight to PNG files for a human to look at and curate. Output goes
// to bff/design-rag/references/ (the curated set), not corpus/ (the RAG's
// working set), so enrollment can never quietly change what every build sees.
//
// Requires Playwright's chromium:  npx playwright install chromium
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REGISTRY } from "../bff/exemplars";
import { renderExemplarToPng } from "../bff/design-rag/render";

const OUT = process.env.DESIGN_REFS_DIR ?? "bff/design-rag/references";

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log(`rendering ${REGISTRY.length} exemplar(s) -> ${OUT}\n`);

  let ok = 0;
  for (const [i, ex] of REGISTRY.entries()) {
    const name = `${String(i + 1).padStart(2, "0")}-${ex.domain}-${ex.id}.png`;
    process.stdout.write(`  ${name} ... `);
    try {
      const png = await renderExemplarToPng(ex.code);
      await fs.writeFile(path.join(OUT, name), png);
      console.log(`${(png.length / 1024).toFixed(0)}kb`);
      ok++;
    } catch (err: any) {
      // One bad exemplar must not stop the batch — render the rest.
      console.log(`FAILED: ${err?.message ?? err}`);
    }
  }

  console.log(`\n${ok}/${REGISTRY.length} rendered.

Next:
  1. Open ${OUT} and LOOK at them. Delete any showing NaN, "Invalid Date",
     Alpha/Bravo/Charlie labels, or a layout you would not ship.
  2. Keep the best 3-5. Rename with a numeric prefix (01-, 02- ...) — they are
     attached in sorted order and the first matters most.
  3. Set DESIGN_REFS_ENABLED=1 in .env.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
