// sources/mysql-cli.ts — STEP 1 probe. Run against your real connection string
// to confirm we can see the schema, before we wire any of this into the app.
//
//   npm run db:introspect -- "mysql://user:pass@host:3306/dbname"
//   (or put MYSQL_URL=mysql://... in your .env and run with no argument — safer,
//    since it keeps the production secret out of your shell history)
//   JSON=1 npm run db:introspect -- "..."   # also dump the DataProfile[] JSON
//
// Prints only schema, types, approximate counts and a sample row. The password
// is never printed.
import "dotenv/config";
import { parseMysqlUrl, introspectMysql, describeConn } from "./mysql";

async function main() {
  const arg = process.argv.slice(2).join(" ").trim() || process.env.MYSQL_URL || "";
  if (!arg) {
    console.error('Usage: npm run db:introspect -- "mysql://user:pass@host:port/db"   (or set MYSQL_URL)');
    process.exit(2);
  }

  let conn;
  try {
    conn = parseMysqlUrl(arg);
  } catch (e) {
    console.error(`Bad connection string: ${(e as Error).message}`);
    process.exit(2);
  }

  console.log(`\nConnecting to ${describeConn(conn)} …\n`);
  const listOnly = process.env.LIST === "1";
  const tables = (process.env.TABLES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const maxTables = process.env.MAX_TABLES ? Number(process.env.MAX_TABLES) : undefined;
  const windowDays = process.env.DAYS !== undefined ? Number(process.env.DAYS) : 7; // default: last 7 days
  const dateColumn = process.env.DATE_COL || undefined;

  try {
    const { datasets, allTables, warnings } = await introspectMysql(conn, {
      sampleRows: 5,
      listOnly,
      tables: tables.length ? tables : undefined,
      maxTables,
      windowDays: windowDays > 0 ? windowDays : undefined,
      dateColumn,
      onPhase: (m) => console.log(`  … ${m}`),
    });

    console.log(`\nDiscovered ${allTables.length.toLocaleString()} table(s) in ${conn.database}.`);

    if (listOnly || (allTables.length > datasets.length && !tables.length)) {
      // Show the catalog (names + approx rows) so you can choose what to profile.
      const top = [...allTables].sort((a, b) => b.approxRows - a.approxRows).slice(0, 60);
      console.log(`\nTables (showing ${top.length} of ${allTables.length}, by approx. row count):\n`);
      for (const t of top) console.log(`  ${t.name.padEnd(48)} ~${t.approxRows.toLocaleString()} rows`);
      console.log(`\nTo profile specific tables:  TABLES=tbl_a,tbl_b npm run db:introspect`);
    }

    if (datasets.length) {
      console.log(`\nProfiled ${datasets.length} table(s):\n`);
      for (const d of datasets) {
        console.log(`  ▸ ${d.tableName}  (~${d.profile.rowCount.toLocaleString()} rows, ${d.profile.columns.length} cols)`);
        for (const col of d.profile.columns) console.log(`      - ${col.name}: ${col.type}`);
        if (d.profile.sampleRows[0]) console.log(`      sample: ${JSON.stringify(d.profile.sampleRows[0])}`);
        console.log();
      }
    }
    for (const w of warnings) console.log(`  ! ${w}`);
    if (process.env.JSON === "1") console.log(`\n--- DataProfile[] ---\n${JSON.stringify(datasets, null, 2)}`);
    console.log("\n✓ Step 1 OK — schema read. (Nothing was copied or modified; READ_ONLY.)\n");
    process.exit(0);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`\n✗ Introspection failed: ${msg}`);
    if (/INSTALL mysql timed out/i.test(msg)) {
      console.error("  → The extension download is blocked. Your box reaches MySQL (internal) but");
      console.error("    likely has no egress to extensions.duckdb.org. Options: allow that host,");
      console.error("    set a proxy, or do an offline install of mysql.duckdb_extension. Tell me and");
      console.error("    I'll give you the exact offline-install steps for your DuckDB version.");
    } else if (/ATTACH .*timed out/i.test(msg)) {
      console.error("  → TCP is open but the MySQL handshake stalled. Usual causes: the server");
      console.error("    requires SSL (try adding ?ssl=true to the URL), or an auth-plugin issue.");
    } else {
      console.error("  Common causes: extension download blocked, SSL required, or grants for the read-only user.");
    }
    console.error("");
    process.exit(1);
  }
}

void main();
