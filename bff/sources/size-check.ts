// sources/size-check.ts — one-off probe: how big is the FULL history (not just 7 days)?
//
//   npx tsx bff/sources/size-check.ts
//   (reads MYSQL_URL from .env — same as db:introspect; nothing is copied/modified, READ_ONLY)
//
// Uses DuckDB's mysql extension + the mysql_query() passthrough so all the heavy
// lifting (counts, date spans, storage sizes) runs server-side on MySQL.
import "dotenv/config";
import { parseMysqlUrl, attachMysql, describeConn } from "./mysql";

// The tables the snapshot pulls from. `kind` tells us how to read the date column:
//   epoch  → stored as Unix seconds (wrap in FROM_UNIXTIME for the span)
//   date   → a real DATE/DATETIME (read directly)
const FACTS: { table: string; dateCol: string; kind: "epoch" | "date" }[] = [
  { table: "my_tickets_sos",      dateCol: "createdon", kind: "epoch" },
  { table: "swticketposts_sos",   dateCol: "dateline",  kind: "epoch" },
  { table: "my_ticket_logs_sos",  dateCol: "createdon", kind: "epoch" },
  { table: "my_note_sos",         dateCol: "createdon", kind: "epoch" },
  { table: "my_resolution_sos",   dateCol: "createdon", kind: "epoch" },
  { table: "my_alltickets_sla",   dateCol: "createdon", kind: "date"  },
];

function fmt(n: number): string { return Number(n).toLocaleString(); }
function mb(bytes: number): string { return (bytes / 1024 / 1024).toFixed(1) + " MB"; }

async function main() {
  const url = process.env.MYSQL_URL || process.argv.slice(2).join(" ").trim();
  if (!url) { console.error("Set MYSQL_URL in .env (or pass it as an argument)."); process.exit(2); }
  const conn = parseMysqlUrl(url);
  console.log(`\nConnecting to ${describeConn(conn)} …\n`);

  const h = await attachMysql(conn, { onPhase: (m) => console.log(`  … ${m}`) });
  try {
    // sql() runs a raw query on the MySQL server via DuckDB's passthrough.
    // Single quotes in the inner query are doubled so it survives being wrapped
    // in the mysql_query('src', '…') string literal.
    const sql = (raw: string) =>
      h.readAll(`SELECT * FROM mysql_query('src', '${raw.replace(/'/g, "''")}')`, "mysql_query");

    // 1) Storage footprint + the server's own row estimate (instant — no scans).
    const names = FACTS.map((f) => `'${f.table}'`).join(",");
    const sizes = await sql(
      `SELECT table_name, table_rows, (data_length+index_length) AS bytes
         FROM information_schema.tables
        WHERE table_schema = '${conn.database}' AND table_name IN (${names})`,
    );
    const sizeBy: Record<string, { rows: number; bytes: number }> = {};
    for (const r of sizes as any[]) sizeBy[String(r.table_name)] = { rows: Number(r.table_rows ?? 0), bytes: Number(r.bytes ?? 0) };

    // 2) Exact count + true date span per table.
    console.log("\n" + "table".padEnd(24) + "exact rows".padStart(12) + "  storage".padStart(11) + "   earliest → latest");
    console.log("-".repeat(86));
    let totalRows = 0, totalBytes = 0;
    let globalMin = Number.POSITIVE_INFINITY, globalMax = 0;

    for (const f of FACTS) {
      try {
        const span = f.kind === "epoch"
          ? `SELECT COUNT(*) n, MIN(${f.dateCol}) lo, MAX(${f.dateCol}) hi FROM ${f.table}`
          : `SELECT COUNT(*) n, UNIX_TIMESTAMP(MIN(${f.dateCol})) lo, UNIX_TIMESTAMP(MAX(${f.dateCol})) hi FROM ${f.table}`;
        const [row] = (await sql(span)) as any[];
        const n = Number(row.n ?? 0);
        const lo = Number(row.lo ?? 0), hi = Number(row.hi ?? 0);
        const loD = lo ? new Date(lo * 1000).toISOString().slice(0, 10) : "—";
        const hiD = hi ? new Date(hi * 1000).toISOString().slice(0, 10) : "—";
        const bytes = sizeBy[f.table]?.bytes ?? 0;
        totalRows += n; totalBytes += bytes;
        if (lo) globalMin = Math.min(globalMin, lo);
        if (hi) globalMax = Math.max(globalMax, hi);
        console.log(f.table.padEnd(24) + fmt(n).padStart(12) + ("  " + mb(bytes)).padStart(13) + `   ${loD} → ${hiD}`);
      } catch (e) {
        console.log(f.table.padEnd(24) + "  (failed: " + (e as Error).message.split("\n")[0] + ")");
      }
    }

    console.log("-".repeat(86));
    const spanDays = globalMax > globalMin ? Math.round((globalMax - globalMin) / 86400) : 0;
    console.log(`TOTAL`.padEnd(24) + fmt(totalRows).padStart(12) + ("  " + mb(totalBytes)).padStart(13));
    console.log(`\nHistory span: ~${fmt(spanDays)} days (${(spanDays / 365).toFixed(1)} years).`);
    if (spanDays > 0) console.log(`Avg load: ~${fmt(Math.round(totalRows / spanDays))} fact rows/day across all tables.`);
    console.log(`\nFeasibility read: ${fmt(totalRows)} total rows / ${mb(totalBytes)} on disk. A daily-aggregated`);
    console.log(`time series is tiny regardless; only raw per-row plotting of the big tables would need care.\n`);
    console.log("✓ done — READ_ONLY, nothing copied or modified.\n");
  } finally {
    h.close();
  }
}
void main();