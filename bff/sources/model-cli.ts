// sources/model-cli.ts — STEP 3 probe. Build the curated analytics views over
// the 7-day snapshot and print what the dashboard will chart.
//
//   npm run db:model                  # uses ./.t2ui/snapshot.duckdb
//   SNAPSHOT_DB=path npm run db:model
import { applyModel } from "./model";

async function main() {
  const dbPath = process.env.SNAPSHOT_DB || "./.t2ui/snapshot.duckdb";
  console.log(`\nBuilding analytics model over ${dbPath} …\n`);
  try {
    const { datasets, created, warnings } = await applyModel(dbPath, { onPhase: (m) => console.log(`  … ${m}`) });
    console.log(`\nCreated ${created.length} view(s):\n`);
    for (const d of datasets) {
      console.log(`  ▸ ${d.tableName}  (${d.profile.rowCount.toLocaleString()} rows)`);
      for (const col of d.profile.columns) console.log(`      - ${col.name}: ${col.type}`);
      if (d.profile.sampleRows[0]) {
        const s = d.profile.sampleRows[0];
        const trimmed = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : v]));
        console.log(`      sample: ${JSON.stringify(trimmed)}`);
      }
      console.log();
    }
    for (const w of warnings) console.log(`  ! ${w}`);
    if (process.env.JSON === "1") console.log(`\n--- DataProfile[] ---\n${JSON.stringify(datasets, null, 2)}`);
    console.log("\n✓ Step 3 OK — the curated views are ready in the snapshot. These are what the dashboard will plot.\n");
    process.exit(0);
  } catch (e) {
    console.error(`\n✗ Model build failed: ${(e as Error).message}`);
    console.error("  Make sure you ran db:snapshot first so ./.t2ui/snapshot.duckdb exists with the source tables.\n");
    process.exit(1);
  }
}

void main();
