// sources/mysql-snapshot-cli.ts — STEP 2 probe. Pull chosen tables IN FULL into a
// local DuckDB snapshot (the default). Optionally narrow fact tables with DAYS=<n>.
//
//   TABLES=shifts,events npm run db:snapshot            # entire tables, auto date col
//   TABLES=shifts DATE_COL=created_at DAYS=30 npm run db:snapshot   # last 30 days only
//   (reads MYSQL_URL from .env)
import "dotenv/config";
import { parseMysqlUrl, describeConn } from "./mysql";
import { snapshotMysql } from "./mysql-snapshot";

async function main() {
  const arg = process.argv.slice(2).join(" ").trim() || process.env.MYSQL_URL || "";
  if (!arg) { console.error('Set MYSQL_URL in .env (or pass the URL as an argument).'); process.exit(2); }

  const tables = (process.env.TABLES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const fullTables = (process.env.FULL_TABLES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!tables.length && !fullTables.length) {
    console.error('Specify tables to snapshot, e.g.:');
    console.error('  TABLES=my_tickets_sos,swticketposts_sos npm run db:snapshot           # entire tables');
    console.error('  FULL_TABLES=myshift.my_tickettypes,myshift.my_status npm run db:snapshot  # full lookups');
    console.error('(Use LIST=1 npm run db:introspect first to find table names.)');
    process.exit(2);
  }
  const days = (() => {
    const d = (process.env.DAYS ?? "").trim().toLowerCase();
    if (!d || d === "all" || d === "0") return 0;        // default: entire data
    const n = Number(d);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
  const dateColumn = process.env.DATE_COL || undefined;
  const dateType = (process.env.DATE_TYPE as any) || undefined;
  const dbPath = process.env.SNAPSHOT_DB || "./.t2ui/snapshot.duckdb";

  let conn;
  try { conn = parseMysqlUrl(arg); } catch (e) { console.error(`Bad connection string: ${(e as Error).message}`); process.exit(2); }

  console.log(`\nSnapshotting from ${describeConn(conn)}`);
  if (tables.length) console.log(`  fact (${days > 0 ? `last ${days}d` : "entire tables"}): ${tables.join(", ")}${dateColumn ? `  [date col: ${dateColumn}${dateType ? `/${dateType}` : ""}]` : "  [auto date col]"}`);
  if (fullTables.length) console.log(`  lookup (full): ${fullTables.join(", ")}`);
  console.log("");

  try {
    const { snapshots, dbPath: outPath, warnings } = await snapshotMysql(conn, {
      tables, fullTables, days, dateColumn, dateType, dbPath,
      onPhase: (m) => console.log(`  … ${m}`),
    });

    console.log("");
    for (const s of snapshots) {
      if (s.skipped) { console.log(`  ✗ ${s.table} — skipped: ${s.skipped}`); continue; }
      const how = s.kind === "fact"
        ? (s.days > 0 ? `last ${s.days}d on '${s.dateColumn}' (${s.dateMode})` : `all rows${s.dateColumn ? ` (date col '${s.dateColumn}')` : ""}`)
        : "full";
      console.log(`  ✓ ${s.table}  —  ${s.rowCount.toLocaleString()} rows  [${how}]`);
      for (const col of s.dataset!.profile.columns) console.log(`      - ${col.name}: ${col.type}`);
      if (s.dataset!.profile.sampleRows[0]) console.log(`      sample: ${JSON.stringify(s.dataset!.profile.sampleRows[0])}`);
      console.log();
    }
    for (const w of warnings) console.log(`  ! ${w}`);
    console.log(`\n✓ Step 2 OK — snapshot written to ${outPath}`);
    console.log(`  This local DuckDB file is what the dashboard will read (production is untouched).`);
    if (process.env.JSON === "1") {
      const datasets = snapshots.filter((s) => s.dataset).map((s) => s.dataset);
      console.log(`\n--- DataProfile[] ---\n${JSON.stringify(datasets, null, 2)}`);
    }
    console.log("");
    process.exit(0);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`\n✗ Snapshot failed: ${msg}`);
    if (/snapshot .* timed out/i.test(msg)) {
      console.error("  → The pull took too long. The table may be very large or the date column");
      console.error("    unindexed. Try narrowing with DAYS=<n>, or tell me the table and I'll tune it.");
    }
    console.error("");
    process.exit(1);
  }
}

void main();