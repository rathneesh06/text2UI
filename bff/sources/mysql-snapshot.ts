// sources/mysql-snapshot.ts — STEP 2 of the MySQL track (helpdesk/Kayako-aware).
//
// Pull the chosen FACT tables IN FULL (the default), plus the full (small)
// LOOKUP/dimension tables, into a local DuckDB file. Optionally narrow the fact
// tables to the last N days by passing DAYS=<n>; otherwise the entire table is
// copied. Production is read once, read-only, and never touched at dashboard time.
//
// Handles real-world date storage: true DATETIME/TIMESTAMP/DATE columns AND the
// common helpdesk pattern of epoch integers (e.g. `dateline`, `createdon`), plus
// sortable date strings. Supports cross-database tables via `db.table`.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { attachMysql, qstr, qid, duckTypeToColumnType, type MysqlConn } from "./mysql";
import type { Dataset, ColumnProfile } from "../../shared/types";
import { enrichColumns } from "../../shared/profile-enrich";
import { exactColumnStats } from "./exact-stats";
import { attachMeasuredForeignKeys } from "./relationships";

const bt = (s: string) => "`" + String(s).replace(/`/g, "``") + "`"; // MySQL identifier

type DateMode = "datetime" | "epoch_s" | "epoch_ms" | "string";

const DATE_NAME_PREFERENCE = [
  "createdon", "created_at", "createdat", "date_created", "datecreated", "created", "create_time",
  "dateline", "timestamp", "datetime", "event_time", "logged_at", "occurredon", "occurred_at",
  "updatedon", "updated_at", "updated", "modifiedon", "modified", "started_at", "start_time",
  "date", "time", "closedon", "closed_at",
];

const MYSQL_DATE_TYPES = /^(datetime|timestamp|date|time)$/i;
const MYSQL_INT_TYPES = /^(tinyint|smallint|mediumint|int|integer|bigint)$/i;

interface Col { col: string; type: string }

/** Pick the column to filter on + how it stores time. Prefers true date types,
 *  then name-matched epoch/string columns (helpdesk pattern). */
function pickDateColumn(cols: Col[], override?: string, overrideType?: DateMode): { col: string; type: string } | null {
  if (override) {
    const hit = cols.find((c) => c.col.toLowerCase() === override.toLowerCase());
    return hit ? { col: hit.col, type: hit.type } : null;
  }
  // 1) true date/time typed columns, by name preference
  const dated = cols.filter((c) => MYSQL_DATE_TYPES.test(c.type));
  for (const pref of DATE_NAME_PREFERENCE) {
    const hit = dated.find((c) => c.col.toLowerCase() === pref) ?? dated.find((c) => c.col.toLowerCase().includes(pref));
    if (hit) return hit;
  }
  if (dated.length) return dated[0];
  // 2) name-matched columns of any type (epoch ints / date strings)
  for (const pref of DATE_NAME_PREFERENCE) {
    const hit = cols.find((c) => c.col.toLowerCase() === pref) ?? cols.find((c) => c.col.toLowerCase().includes(pref));
    if (hit) return hit;
  }
  return null;
}

function inferMode(type: string, sampleValue: unknown, overrideType?: DateMode): DateMode {
  if (overrideType) return overrideType;
  if (MYSQL_DATE_TYPES.test(type)) return "datetime";
  if (MYSQL_INT_TYPES.test(type)) {
    const n = Number(sampleValue);
    return Number.isFinite(n) && n > 1e12 ? "epoch_ms" : "epoch_s";
  }
  return "string"; // varchar/char/text holding a sortable date string
}

function datePredicate(col: string, mode: DateMode, days: number): string {
  const id = bt(col);
  switch (mode) {
    case "datetime": return `${id} >= (NOW() - INTERVAL ${days} DAY)`;
    case "epoch_s":  return `${id} >= UNIX_TIMESTAMP(NOW() - INTERVAL ${days} DAY)`;
    case "epoch_ms": return `${id} >= UNIX_TIMESTAMP(NOW() - INTERVAL ${days} DAY) * 1000`;
    case "string":   return `${id} >= DATE_FORMAT(NOW() - INTERVAL ${days} DAY, '%Y-%m-%d %H:%i:%s')`;
  }
}

/** "db.table" -> {db, table}; "table" -> {db: defaultDb, table}. */
function splitTable(spec: string, defaultDb: string): { db: string; table: string; local: string } {
  const i = spec.indexOf(".");
  if (i > 0) {
    const db = spec.slice(0, i), table = spec.slice(i + 1);
    return { db, table, local: db === defaultDb ? table : `${db}__${table}` };
  }
  return { db: defaultDb, table: spec, local: spec };
}

export interface SnapshotOptions {
  tables: string[];        // FACT tables to date-filter (each "table" or "db.table")
  fullTables?: string[];   // LOOKUP/dimension tables to pull whole (small)
  days?: number;           // window size (default 7)
  dateColumn?: string;     // force this date column on every fact table
  dateType?: DateMode;     // force how the date column stores time
  dbPath?: string;         // DuckDB file to write (default ./.t2ui/snapshot.duckdb)
  sampleRows?: number;     // sample for the profile (default 5)
  rowCap?: number;         // safety LIMIT per table (default 2,000,000)
  onPhase?: (msg: string) => void;
  installTimeoutMs?: number;
  attachTimeoutMs?: number;
  snapshotTimeoutMs?: number;
}

export interface TableSnapshot {
  table: string;
  kind: "fact" | "lookup";
  dateColumn: string | null;
  dateMode?: DateMode;
  days: number;
  rowCount: number;
  dataset?: Dataset;
  skipped?: string;
}
export interface SnapshotResult {
  dbPath: string;
  snapshots: TableSnapshot[];
  warnings: string[];
}

export async function snapshotMysql(conn: MysqlConn, opts: SnapshotOptions): Promise<SnapshotResult> {
  // days <= 0 (or unset) means UNBOUNDED — pull the entire table. A positive value
  // narrows fact tables to the last N days; the default here is "all data".
  const days = opts.days && opts.days > 0 ? Math.floor(opts.days) : 0;
  const unbounded = days === 0;
  const sampleN = Math.max(1, opts.sampleRows ?? 5);
  const rowCap = opts.rowCap ?? 2_000_000;
  const dbPath = opts.dbPath ?? "./.t2ui/snapshot.duckdb";
  const snapMs = opts.snapshotTimeoutMs ?? 120_000;
  const warnings: string[] = [];
  const log = opts.onPhase ?? (() => {});
  mkdirSync(dirname(dbPath), { recursive: true });

  const h = await attachMysql(conn, {
    dbPath, onPhase: log,
    installTimeoutMs: opts.installTimeoutMs, attachTimeoutMs: opts.attachTimeoutMs,
  });
  const { readAll, c } = h;
  const snapshots: TableSnapshot[] = [];

  // run a query INSIDE MySQL via the attached connection (works cross-database)
  const mysql = (sql: string, label: string) => readAll(`SELECT * FROM mysql_query('src', ${qstr(sql)})`, label);
  const columnsOf = async (db: string, table: string): Promise<Col[]> => {
    const rows = await mysql(
      `SELECT column_name AS col, data_type AS type FROM information_schema.columns ` +
      `WHERE table_schema = '${db.replace(/'/g, "''")}' AND table_name = '${table.replace(/'/g, "''")}' ORDER BY ordinal_position`,
      `columns ${db}.${table}`,
    );
    return rows.map((r) => ({ col: String((r as any).col), type: String((r as any).type) }));
  };
  const profileFrom = async (local: string, cols: Col[], sample: Record<string, unknown>[], rowCount: number, label: string): Promise<Dataset> => {
    let columns: ColumnProfile[] = cols.map(({ col, type }) => {
      const values = sample.map((r) => r[col]).filter((v) => v !== null && v !== undefined);
      return {
        name: col, type: duckTypeToColumnType(type),
        nullable: sample.some((r) => r[col] === null || r[col] === undefined),
        uniqueCount: new Set(values.map((v) => String(v))).size, sampleValues: values.slice(0, 5),
      };
    });
    columns = enrichColumns(columns, sample);
    // The snapshot table lives in OUR DuckDB — exact stats are cheap and make
    // exhaustiveness truthful (statsExact).
    try { columns = await exactColumnStats((q, l) => readAll(q, l ?? "stats"), qid(local), columns); } catch { /* floor stands */ }
    return { tableName: local, profile: { source: { filename: label, format: "json" }, rowCount, columns, sampleRows: sample } };
  };

  try {
    // ---- FACT tables: entire data by default (or last N days if DAYS is set) ----
    for (const spec of opts.tables) {
      const { db, table, local } = splitTable(spec, conn.database);
      const cols = await columnsOf(db, table);
      if (!cols.length) { snapshots.push({ table: spec, kind: "fact", dateColumn: null, days, rowCount: 0, skipped: "table not found / no columns" }); warnings.push(`not found: ${spec}`); continue; }

      // A date column is only REQUIRED when narrowing to a window. For the default
      // unbounded pull it's optional (used just to record what we snapshotted).
      const picked = pickDateColumn(cols, opts.dateColumn, opts.dateType);
      if (!picked && !unbounded) {
        const types = cols.map((c) => `${c.col}:${c.type}`).join(", ");
        const reason = `no date column found on ${spec}. Pass DATE_COL=<col> (and DATE_TYPE=epoch|datetime|string), or omit DAYS to pull the whole table. Columns: ${types}`;
        snapshots.push({ table: spec, kind: "fact", dateColumn: null, days, rowCount: 0, skipped: reason });
        warnings.push(reason);
        continue;
      }

      // When windowing, sample one value to tell epoch seconds from milliseconds.
      let mode: DateMode | undefined;
      if (picked) {
        let sampleVal: unknown = undefined;
        try {
          const sv = await mysql(`SELECT ${bt(picked.col)} AS v FROM ${bt(db)}.${bt(table)} WHERE ${bt(picked.col)} IS NOT NULL LIMIT 1`, `probe ${table}`);
          sampleVal = sv[0]?.v;
        } catch { /* fall back to type-based mode */ }
        mode = inferMode(picked.type, sampleVal, opts.dateType);
      }

      const where = unbounded || !picked ? "" : ` WHERE ${datePredicate(picked.col, mode!, days)}`;
      log(unbounded
        ? `snapshotting ${spec} — entire table…`
        : `snapshotting ${spec} — last ${days}d on '${picked!.col}' (${mode})…`);
      const inner = `SELECT * FROM ${bt(db)}.${bt(table)}${where} LIMIT ${rowCap}`;
      const dest = `${qid("main")}.${qid(local)}`;
      await h.run(`CREATE OR REPLACE TABLE ${dest} AS SELECT * FROM mysql_query('src', ${qstr(inner)})`, snapMs, `snapshot ${table}`);

      const cnt = await readAll(`SELECT count(*) AS n FROM ${dest}`, `count ${table}`);
      const rowCount = Number((cnt[0] as any).n ?? 0);
      if (rowCount >= rowCap) warnings.push(`${spec}: hit ${rowCap.toLocaleString()} row cap`);
      const sample = await readAll(`SELECT * FROM ${dest} LIMIT ${sampleN}`, `sample ${table}`);
      const label = unbounded || !picked
        ? `mysql:${db}.${table} (full)`
        : `mysql:${db}.${table} (last ${days}d on ${picked.col})`;
      snapshots.push({
        table: spec, kind: "fact", dateColumn: picked?.col ?? null, dateMode: mode, days, rowCount,
        dataset: await profileFrom(local, cols, sample, rowCount, label),
      });
    }

    // ---- LOOKUP tables: pull whole (small dimensions, cross-db ok) ----
    for (const spec of opts.fullTables ?? []) {
      const { db, table, local } = splitTable(spec, conn.database);
      const cols = await columnsOf(db, table);
      if (!cols.length) { snapshots.push({ table: spec, kind: "lookup", dateColumn: null, days, rowCount: 0, skipped: "table not found" }); warnings.push(`not found: ${spec}`); continue; }
      log(`pulling lookup ${spec} (full)…`);
      const inner = `SELECT * FROM ${bt(db)}.${bt(table)} LIMIT ${rowCap}`;
      const dest = `${qid("main")}.${qid(local)}`;
      await h.run(`CREATE OR REPLACE TABLE ${dest} AS SELECT * FROM mysql_query('src', ${qstr(inner)})`, snapMs, `lookup ${table}`);
      const cnt = await readAll(`SELECT count(*) AS n FROM ${dest}`, `count ${table}`);
      const rowCount = Number((cnt[0] as any).n ?? 0);
      const sample = await readAll(`SELECT * FROM ${dest} LIMIT ${sampleN}`, `sample ${table}`);
      snapshots.push({
        table: spec, kind: "lookup", dateColumn: null, days, rowCount,
        dataset: await profileFrom(local, cols, sample, rowCount, `mysql:${db}.${table} (full)`),
      });
    }

    // A3: measured relationship edges across the snapshotted tables.
    try { await attachMeasuredForeignKeys((q, l) => readAll(q, l ?? "fk"), snapshots.map((sn) => sn.dataset).filter((d): d is NonNullable<typeof d> => !!d)); } catch { /* no edges */ }
    try { await c.run("CHECKPOINT"); } catch { /* best-effort */ }
    return { dbPath, snapshots, warnings };
  } finally {
    h.close();
  }
}