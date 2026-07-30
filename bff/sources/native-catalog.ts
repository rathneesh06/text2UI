// bff/sources/native-catalog.ts — browse a database the way MySQL Workbench,
// pgAdmin and DBeaver do: one native protocol connection, one cheap catalog
// query, everything else lazy.
//
// WHY THIS EXISTS
// The rest of this codebase reaches MySQL/Postgres through DuckDB's `ATTACH`,
// which is the right tool for *reading data* — it gives us one SQL dialect over
// every source and a columnar engine for the snapshot. It is the wrong tool for
// *browsing a catalog*. ATTACH materialises the entire remote catalog before it
// returns, and DuckDB's MySQL extension has no way to scope that to one schema
// (the Postgres extension has `SCHEMA 'x'`; the MySQL one does not). On a server
// with ~12,500 tables that is minutes of round trips before a single table name
// can be shown — this is the same complaint as duckdb/postgres_scanner#221,
// where ATTACH against a many-schema database took ~6 minutes.
//
// A GUI client doesn't do any of that. It does:
//   1. TCP connect + protocol handshake                        (~1 round trip)
//   2. one catalog query for the table list                    (~1 round trip)
//   3. columns/indexes ONLY when you expand a table            (lazy)
//   4. rows ONLY when you run a query                          (lazy)
// and it never asks for row counts up front, because on InnoDB that is the
// expensive part.
//
// So: this module is the browse path (fast, native, lazy), and DuckDB stays the
// extract path (columnar, one dialect, used once on the handful of tables the
// user actually chose). Each tool where it's strong.
import type { DbConn } from "./db-conn";

export interface NativeTable { name: string; approxRows: number | null }
export interface NativeColumn {
  name: string;
  type: string;
  nullable: boolean;
  key: string | null;      // PRI / UNI / MUL where the server reports it
  defaultValue: string | null;
}
export interface NativeTableDetail {
  tableName: string;
  rowCount: number | null;
  columns: NativeColumn[];
  sampleRows: Record<string, unknown>[];
}

const CONNECT_TIMEOUT_MS = Number(process.env.DB_NATIVE_CONNECT_TIMEOUT_MS ?? 8_000);
const QUERY_TIMEOUT_MS = Number(process.env.DB_NATIVE_QUERY_TIMEOUT_MS ?? 15_000);

/** Reject a hung query rather than letting a request hang forever. The socket is
 *  closed by the caller's finally block either way. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ---- MySQL ---------------------------------------------------------------------

/** mysql2 is imported lazily so that a Postgres-only deployment never pays for
 *  loading it, and so a missing optional dep degrades to a clear error. */
async function mysqlConnect(conn: DbConn) {
  const mysql = await import("mysql2/promise");
  return mysql.createConnection({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    connectTimeout: CONNECT_TIMEOUT_MS,
    ...(conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    // Keep the driver from coercing types we're only going to display.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

/**
 * The table list — ONE query, no per-table work, no row counts.
 *
 * Deliberately does not select TABLE_ROWS: on InnoDB, reading it makes the
 * server refresh statistics for every table in the result unless
 * innodb_stats_on_metadata is off, which is exactly the stall we're removing.
 * Counts arrive later, per table, from tableDetail().
 */
export async function nativeListTablesMysql(conn: DbConn): Promise<NativeTable[]> {
  const c = await withTimeout(mysqlConnect(conn), CONNECT_TIMEOUT_MS + 1_000, "MySQL connect");
  try {
    const [rows] = await withTimeout(
      c.query(
        "SELECT TABLE_NAME AS name FROM information_schema.TABLES " +
        "WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
        [conn.database],
      ),
      QUERY_TIMEOUT_MS,
      "list tables",
    );
    return (rows as any[]).map((r) => ({ name: String(r.name), approxRows: null }));
  } finally {
    await c.end().catch(() => { /* socket already gone */ });
  }
}

/** Columns + a small sample + this ONE table's row estimate. Three cheap queries
 *  against a single table — what a GUI runs when you expand a tree node. */
export async function nativeTableDetailMysql(conn: DbConn, tables: string[]): Promise<NativeTableDetail[]> {
  const c = await withTimeout(mysqlConnect(conn), CONNECT_TIMEOUT_MS + 1_000, "MySQL connect");
  const out: NativeTableDetail[] = [];
  try {
    for (const table of tables) {
      const [colRows] = await withTimeout(
        c.query(
          "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, " +
          "COLUMN_KEY AS ckey, COLUMN_DEFAULT AS dflt FROM information_schema.COLUMNS " +
          "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
          [conn.database, table],
        ),
        QUERY_TIMEOUT_MS,
        `columns of ${table}`,
      );
      const columns: NativeColumn[] = (colRows as any[]).map((r) => ({
        name: String(r.name),
        type: String(r.type),
        nullable: String(r.nullable).toUpperCase() === "YES",
        key: r.ckey ? String(r.ckey) : null,
        defaultValue: r.dflt == null ? null : String(r.dflt),
      }));
      if (!columns.length) continue; // table vanished or no permission

      // Backticks + doubled backticks: the only escaping MySQL identifiers need.
      const ident = "`" + String(table).replace(/`/g, "``") + "`";
      let sampleRows: Record<string, unknown>[] = [];
      try {
        const [sample] = await withTimeout(c.query(`SELECT * FROM ${ident} LIMIT 5`), QUERY_TIMEOUT_MS, `sample ${table}`);
        sampleRows = sample as Record<string, unknown>[];
      } catch { /* a view or a permission gap — columns alone are still useful */ }

      // Single-table TABLE_ROWS is cheap; the catalog-wide version is not.
      let rowCount: number | null = null;
      try {
        const [cnt] = await withTimeout(
          c.query("SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [conn.database, table]),
          QUERY_TIMEOUT_MS,
          `row estimate ${table}`,
        );
        const n = (cnt as any[])[0]?.n;
        rowCount = n == null ? null : Number(n);
      } catch { /* estimate is a nicety */ }

      out.push({ tableName: table, rowCount, columns, sampleRows });
    }
    return out;
  } finally {
    await c.end().catch(() => { /* socket already gone */ });
  }
}

// ---- Postgres -------------------------------------------------------------------

async function pgClient(conn: DbConn) {
  const { Client } = await import("pg");
  const client = new Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ...(conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  await client.connect();
  return client;
}

/** pg_class.reltuples is the planner's own estimate — free, no scan. This is
 *  what pgAdmin shows, and why its tree opens instantly. */
export async function nativeListTablesPostgres(conn: DbConn): Promise<NativeTable[]> {
  const c = await withTimeout(pgClient(conn), CONNECT_TIMEOUT_MS + 1_000, "Postgres connect");
  try {
    const r = await withTimeout(
      c.query(
        `SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS est
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','p','f','m')
            AND n.nspname NOT IN ('pg_catalog','information_schema')
            AND n.nspname NOT LIKE 'pg_toast%'
          ORDER BY n.nspname, c.relname`,
      ),
      QUERY_TIMEOUT_MS,
      "list tables",
    );
    return r.rows.map((row: any) => ({
      name: row.schema === "public" ? String(row.name) : `${row.schema}.${row.name}`,
      // reltuples is -1 on a table that has never been analysed.
      approxRows: Number(row.est) < 0 ? null : Number(row.est),
    }));
  } finally {
    await c.end().catch(() => { /* already closed */ });
  }
}

export async function nativeTableDetailPostgres(conn: DbConn, tables: string[]): Promise<NativeTableDetail[]> {
  const c = await withTimeout(pgClient(conn), CONNECT_TIMEOUT_MS + 1_000, "Postgres connect");
  const out: NativeTableDetail[] = [];
  try {
    for (const table of tables) {
      const dot = table.indexOf(".");
      const schema = dot > 0 ? table.slice(0, dot) : "public";
      const bare = dot > 0 ? table.slice(dot + 1) : table;
      const cols = await withTimeout(
        c.query(
          `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS dflt
             FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position`,
          [schema, bare],
        ),
        QUERY_TIMEOUT_MS,
        `columns of ${table}`,
      );
      const columns: NativeColumn[] = cols.rows.map((r: any) => ({
        name: String(r.name),
        type: String(r.type),
        nullable: String(r.nullable).toUpperCase() === "YES",
        key: null,
        defaultValue: r.dflt == null ? null : String(r.dflt),
      }));
      if (!columns.length) continue;

      const ident = `"${schema.replace(/"/g, '""')}"."${bare.replace(/"/g, '""')}"`;
      let sampleRows: Record<string, unknown>[] = [];
      try {
        const s = await withTimeout(c.query(`SELECT * FROM ${ident} LIMIT 5`), QUERY_TIMEOUT_MS, `sample ${table}`);
        sampleRows = s.rows as Record<string, unknown>[];
      } catch { /* permission or view */ }

      let rowCount: number | null = null;
      try {
        const e = await withTimeout(
          c.query(`SELECT c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, bare]),
          QUERY_TIMEOUT_MS,
          `row estimate ${table}`,
        );
        const n = e.rows[0]?.n;
        rowCount = n == null || Number(n) < 0 ? null : Number(n);
      } catch { /* estimate is a nicety */ }

      out.push({ tableName: table, rowCount, columns, sampleRows });
    }
    return out;
  } finally {
    await c.end().catch(() => { /* already closed */ });
  }
}

// ---- read-only query execution (for the analyst chat) --------------------------------
//
// The selection page answers questions about data the user has NOT extracted
// yet, so the query has to run against the source database. Three independent
// layers keep that safe, because one is not enough on someone's production box:
//   1. the caller passes SQL through guardSelect() first — static check + row cap
//   2. the transaction is opened READ ONLY, so the server itself refuses writes
//   3. a statement timeout, so a careless join can't pin a production CPU
// Layer 2 is the one that matters: it holds even if a clever string slips past
// the parser, because the database enforces it rather than us.

export interface NativeQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  elapsedMs: number;
}

const ANALYSIS_TIMEOUT_MS = Number(process.env.DB_ANALYSIS_TIMEOUT_MS ?? 20_000);

export async function nativeQuery(
  conn: DbConn,
  sql: string,
  rowCap = Number(process.env.DB_ANALYSIS_ROW_CAP ?? 200),
): Promise<NativeQueryResult> {
  const started = Date.now();
  if (conn.dialect === "mysql") {
    const c = await withTimeout(mysqlConnect(conn), CONNECT_TIMEOUT_MS + 1_000, "MySQL connect");
    try {
      await c.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await c.query(`SET SESSION max_execution_time = ${Math.max(1000, ANALYSIS_TIMEOUT_MS)}`).catch(() => { /* MariaDB / older MySQL */ });
      await c.query("START TRANSACTION READ ONLY");
      try {
        const [rows] = await withTimeout(c.query(sql), ANALYSIS_TIMEOUT_MS, "query");
        const list = (rows as Record<string, unknown>[]) ?? [];
        return {
          columns: list.length ? Object.keys(list[0]) : [],
          rows: list.slice(0, rowCap),
          truncated: list.length > rowCap,
          elapsedMs: Date.now() - started,
        };
      } finally {
        await c.query("ROLLBACK").catch(() => { /* nothing to undo — it was read only */ });
      }
    } finally {
      await c.end().catch(() => { /* socket gone */ });
    }
  }

  const c = await withTimeout(pgClient(conn), CONNECT_TIMEOUT_MS + 1_000, "Postgres connect");
  try {
    await c.query("BEGIN READ ONLY");
    try {
      await c.query(`SET LOCAL statement_timeout = ${Math.max(1000, ANALYSIS_TIMEOUT_MS)}`);
      const r = await withTimeout(c.query(sql), ANALYSIS_TIMEOUT_MS, "query");
      const list = (r.rows as Record<string, unknown>[]) ?? [];
      return {
        columns: r.fields?.map((f: any) => String(f.name)) ?? (list.length ? Object.keys(list[0]) : []),
        rows: list.slice(0, rowCap),
        truncated: list.length > rowCap,
        elapsedMs: Date.now() - started,
      };
    } finally {
      await c.query("ROLLBACK").catch(() => { /* read only */ });
    }
  } finally {
    await c.end().catch(() => { /* already closed */ });
  }
}

// ---- dialect dispatch --------------------------------------------------------------

export function nativeListTables(conn: DbConn): Promise<NativeTable[]> {
  return conn.dialect === "mysql" ? nativeListTablesMysql(conn) : nativeListTablesPostgres(conn);
}

export function nativeTableDetail(conn: DbConn, tables: string[]): Promise<NativeTableDetail[]> {
  return conn.dialect === "mysql" ? nativeTableDetailMysql(conn, tables) : nativeTableDetailPostgres(conn, tables);
}
