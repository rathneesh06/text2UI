// bff/deck/try-deck.ts — test harness for the spec-driven PPT pipeline.
// Runs the REAL pipeline (Gemini planners + validators + deterministic compiler) and
// writes deck-test.pptx. Works on UPLOADED data or the colo snapshot:
//
//   # uploaded CSV (the normal user flow):
//   $env:CSV="sample-sales.csv"; $env:TABLE="sales"
//   $env:PROMPT="Create a quarterly sales review deck"; npx tsx bff/deck/try-deck.ts
//
//   # colo data (optional built-in source):
//   $env:PROMPT="Executive helpdesk review"; npx tsx bff/deck/try-deck.ts
//
// Reads GEMINI/MYSQL creds from .env. Nothing is modified; just writes a .pptx.
import "dotenv/config";
import { writeFileSync } from "fs";
import { handleDeckBuild } from "./handler";
import { loadCsvFiles, type LocalData } from "./local-data";

const PROMPT = process.env.PROMPT ||
  "Create an 8-slide executive review: open with the headline KPIs, show the main trend over time, " +
  "the breakdown by category, and close with a recommendation.";

async function main() {
  let datasets, query: ((sql: string) => Promise<any[]>) | undefined, local: LocalData | undefined;

  if (process.env.CSV) {
    const table = process.env.TABLE || "data";
    local = await loadCsvFiles([{ tableName: table, path: process.env.CSV }]);
    datasets = local.datasets;
    query = local.query;
    console.log(`Loaded uploaded CSV "${process.env.CSV}" as table "${table}" (${datasets[0].profile.rowCount} rows).`);
  } else {
    const { coloProfiles, coloQuery } = await import("../sources/colo");
    datasets = await coloProfiles();
    query = (sql: string) => coloQuery(sql, { rowCap: 5000, timeoutMs: 20000 }).then((r) => r.rows);
    console.log(`Using colo data: ${datasets.map((d) => d.tableName).join(", ")}`);
  }

  console.log(`Prompt: ${PROMPT}\n`);
  const t0 = Date.now();
  const { status, body } = await handleDeckBuild({ datasets, userPrompt: PROMPT }, { query });
  if (status !== 200) { console.error(`FAILED (${status}):`, body); local?.close(); process.exit(1); }

  writeFileSync("deck-test.pptx", Buffer.from(body.pptxBase64, "base64"));
  console.log(`Deck: "${body.spec.meta.title}"  (audience: ${body.spec.meta.audience})  — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const s of body.spec.slides) console.log(`  - [${s.role}] ${s.title}  (${s.blocks.map((b: any) => b.type).join(", ") || "—"})`);
  if (body.warnings.length) console.log("\nWarnings:\n  " + body.warnings.join("\n  "));
  console.log("\n✓ Wrote deck-test.pptx — open it.");
  local?.close();
}
void main();