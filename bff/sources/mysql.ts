// sources/mysql.ts — STEP 1 of the "build a dashboard on a MySQL DB" track.
//
// A browser can't reach MySQL and credentials must never leave the server, so
// all MySQL access happens here on the BFF. We use DuckDB's `mysql` extension
// (server-side Node DuckDB only — it's unavailable in DuckDB-WASM) to ATTACH the
// database READ_ONLY and introspect it: list tables, columns/types, an
// approximate row count (read cheaply from MySQL's information_schema, NOT a
// count(*) over production), and a tiny LIMIT sample per table.
//
// Output is `Dataset[]` ({ tableName, profile: DataProfile }) — the exact shape
// the orchestrator already plans dashboards from. Nothing is materialized or
// built yet; this step only proves access + produces the schema profile.
//
// Credentials are passed via a DuckDB SECRET (never string-concatenated into the
// ATTACH connection string), and we never log or return the password.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { Dataset, ColumnProfile, ColumnType } from "../../shared/types";
import { enrichColumns } from "../../shared/profile-enrich";

export interface MysqlConn {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

export const qstr = (s: string) => `'${String(s).replace(/'/g, "''")}'`; // SQL string literal
export const qid = (s: string) => `"${String(s).replace(/"/g, '""')}"`;   // SQL identifier

/** Parse a `mysql://` or SQLAlchemy-style `mysql+pymysql://` URL, or a
 *  space-separated `key=value` string. Parsed manually (not via `new URL`) so
 *  raw, unescaped special characters in the password — `@ # $ ! :` etc., which
 *  are extremely common in DB passwords — survive intact. Throws on missing
 *  host/database. */
export function parseMysqlUrl(input: string): MysqlConn {
  const s = (input ?? "").trim();
  if (!s) throw new Error("empty connection string");

  // scheme like "mysql://", "mysql2://", "mysql+pymysql://" (driver suffix ignored)
  const scheme = s.match(/^[a-z][a-z0-9]*(?:\+[a-z0-9]+)?:\/\//i);
  if (scheme) {
    const rest = s.slice(scheme[0].length);

    // authority = everything up to the first '/'; the remainder is /database?query
    const slash = rest.indexOf("/");
    const authority = slash >= 0 ? rest.slice(0, slash) : rest;
    let tail = slash >= 0 ? rest.slice(slash + 1) : "";

    let database = tail, query = "";
    const qm = database.search(/[?#]/);
    if (qm >= 0) { query = database.slice(qm + 1); database = database.slice(0, qm); }

    // split userinfo from host on the LAST '@' (passwords may contain '@')
    const at = authority.lastIndexOf("@");
    const userinfo = at >= 0 ? authority.slice(0, at) : "";
    const hostport = at >= 0 ? authority.slice(at + 1) : authority;

    // user:password on the FIRST ':' — everything after is the literal password
    let user = "root", password = "";
    if (userinfo) {
      const colon = userinfo.indexOf(":");
      if (colon >= 0) { user = userinfo.slice(0, colon); password = userinfo.slice(colon + 1); }
      else user = userinfo;
    }

    // host:port — only treat a trailing :NNNN as a port; tolerate IPv6 brackets
    let host = hostport, port = 3306;
    const lastColon = hostport.lastIndexOf(":");
    if (lastColon >= 0 && /^\d+$/.test(hostport.slice(lastColon + 1))) {
      host = hostport.slice(0, lastColon);
      port = Number(hostport.slice(lastColon + 1));
    }
    host = host.replace(/^\[|\]$/g, "");

    if (!host) throw new Error("connection string is missing a host");
    if (!database) throw new Error("connection string is missing a database (the /name path)");

    let sslRaw = "";
    for (const kv of query.split("&")) {
      const eq = kv.indexOf("=");
      const k = eq >= 0 ? kv.slice(0, eq) : kv;
      if (/^(ssl|sslmode|ssl-mode)$/i.test(k)) sslRaw = eq >= 0 ? kv.slice(eq + 1) : "";
    }
    return { host, port, user, password, database, ssl: /^(1|true|require|required|verify.*|yes|on)$/i.test(sslRaw) };
  }

  // key=value fallback (host=... user=... password=... database=... port=...)
  const kv: Record<string, string> = {};
  for (const part of s.split(/\s+/)) {
    const i = part.indexOf("=");
    if (i > 0) kv[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
  }
  const host = kv.host ?? kv.hostname;
  const database = kv.database ?? kv.dbname ?? kv.db;
  if (!host || !database) throw new Error("key=value string must include host= and database=");
  return {
    host,
    port: kv.port ? Number(kv.port) : 3306,
    user: kv.user ?? kv.username ?? "root",
    password: kv.password ?? kv.pass ?? "",
    database,
    ssl: /^(1|true|require|required|verify.*|yes|on)$/i.test(kv.ssl ?? kv.sslmode ?? ""),
  };
}

/** Mask a connection for safe logging — never reveals the password. */
export function describeConn(c: MysqlConn): string {
  return `mysql://${c.user}:***@${c.host}:${c.port}/${c.database}${c.ssl ? " (ssl)" : ""}`;
}

export function duckTypeToColumnType(t: string): ColumnType {
  const u = (t || "").toUpperCase();
  if (/BOOL/.test(u)) return "boolean";
  if (/(TIMESTAMP|DATETIME|\bDATE\b|\bTIME\b)/.test(u)) return "date";
  if (/(TINYINT|SMALLINT|INTEGER|\bINT\b|BIGINT|HUGEINT|UINTEGER|UBIGINT)/.test(u)) return "integer";
  if (/(DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)/.test(u)) return "number";
  return "string";
}

/** Choose the column to window "last N days" on. Honors an explicit choice;
 *  otherwise prefers common audit columns, then any date/timestamp column. */
function pickDateColumn(cols: { col: string; type: string }[], preferred?: string): string | null {
  const dateCols = cols.filter((c) => duckTypeToColumnType(c.type) === "date");
  if (preferred) {
    const hit = cols.find((c) => c.col.toLowerCase() === preferred.toLowerCase());
    return hit ? hit.col : null; // explicit but missing → caller warns
  }
  if (!dateCols.length) return null;
  const priority = [/^created_?at$/i, /^updated_?at$/i, /(^|_)date$/i, /(^|_)datetime$/i, /(^|_)time(stamp)?$/i, /_at$/i];
  for (const re of priority) {
    const hit = dateCols.find((c) => re.test(c.col));
    if (hit) return hit.col;
  }
  return dateCols[0].col;
}

export interface IntrospectOptions {
  sampleRows?: number;   // rows to LIMIT-sample per profiled table (default 5)
  maxTables?: number;    // cap number of tables PROFILED (default 25)
  tables?: string[];     // profile only these specific tables (overrides maxTables)
  listOnly?: boolean;    // just list table names + approx counts; skip sampling
  windowDays?: number;   // only consider rows from the last N days (needs a date column)
  dateColumn?: string;   // the date/timestamp column to window on (auto-detected if omitted)
  onPhase?: (msg: string) => void;     // progress callback (which step we're on)
  installTimeoutMs?: number;           // extension download budget (default 90s)
  attachTimeoutMs?: number;            // MySQL handshake budget (default 25s)
  queryTimeoutMs?: number;             // per introspection query (default 30s)
}
export interface IntrospectResult {
  datasets: Dataset[];                                // full profiles (sampled) for the selected tables
  allTables: { name: string; approxRows: number }[];  // every table discovered (cheap), for selection
  warnings: string[];
}

/** Reject if a step exceeds its budget — turns an indefinite hang (blocked
 *  extension download, stalled MySQL handshake) into a clear, actionable error.
 *  Note: the underlying native call may keep running, but the probe exits. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/** Attach the MySQL DB read-only and produce a schema profile. Read-only and
 *  bounded: schema metadata + approximate counts + a tiny sample per table. */
export interface AttachOptions {
  dbPath?: string;            // ":memory:" (default) or a file path to persist the snapshot
  onPhase?: (msg: string) => void;
  installTimeoutMs?: number;
  attachTimeoutMs?: number;
  queryTimeoutMs?: number;
}
export interface AttachHandle {
  instance: DuckDBInstance;
  c: DuckDBConnection;
  readAll: (sql: string, label: string) => Promise<Record<string, unknown>[]>;
  run: (sql: string, ms: number, label: string) => Promise<void>;
  close: () => void;
}

/** Open a DuckDB engine, load the `mysql` extension, register credentials via a
 *  SECRET, and ATTACH the MySQL database READ_ONLY as `src`. Shared by both the
 *  introspector and the snapshotter. */
export async function attachMysql(conn: MysqlConn, opts: AttachOptions = {}): Promise<AttachHandle> {
  const log = opts.onPhase ?? (() => {});
  const installMs = opts.installTimeoutMs ?? 90_000;
  const attachMs = opts.attachTimeoutMs ?? 25_000;
  const queryMs = opts.queryTimeoutMs ?? 30_000;

  log(`creating DuckDB engine${opts.dbPath && opts.dbPath !== ":memory:" ? ` (${opts.dbPath})` : ""}…`);
  const instance = await DuckDBInstance.create(opts.dbPath ?? ":memory:");
  const c = await instance.connect();
  const readAll = async (sql: string, label: string) => {
    const reader = await withTimeout(c.runAndReadUntil(sql, 1_000_000), queryMs, label);
    return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((row) => {
      for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
      return row;
    });
  };
  const run = (sql: string, ms: number, label: string) => withTimeout(c.run(sql), ms, label).then(() => undefined);

  let installed = false;
  try {
    const ext = await readAll(`SELECT installed FROM duckdb_extensions() WHERE extension_name = 'mysql'`, "extension check");
    installed = ext.length > 0 && Boolean((ext[0] as any).installed);
  } catch { /* fall through to INSTALL */ }
  if (!installed) {
    log("installing the 'mysql' extension (first run downloads it from extensions.duckdb.org — needs internet egress)…");
    await run("INSTALL mysql", installMs, "INSTALL mysql");
  } else {
    log("'mysql' extension already installed (cached).");
  }
  log("loading the 'mysql' extension…");
  await run("LOAD mysql", 30_000, "LOAD mysql");

  log("registering credentials (DuckDB SECRET)…");
  await c.run(
    `CREATE OR REPLACE SECRET t2ui_mysql (TYPE mysql, HOST ${qstr(conn.host)}, PORT ${conn.port}, ` +
    `USER ${qstr(conn.user)}, PASSWORD ${qstr(conn.password)}, DATABASE ${qstr(conn.database)}` +
    `${conn.ssl ? `, SSL_MODE 'required'` : ""});`,
  );
  log(`attaching MySQL ${conn.host}:${conn.port}/${conn.database} (READ_ONLY)…`);
  await run(`ATTACH '' AS src (TYPE mysql, READ_ONLY, SECRET t2ui_mysql)`, attachMs, "ATTACH (MySQL handshake)");

  return { instance, c, readAll, run, close: () => {
    // Close the CONNECTION and the INSTANCE. Closing only the connection leaks
    // the file handle: on Windows the snapshot's stage .duckdb stays locked by
    // this process and every later open (runtime wbQuery) fails with
    // "being used by another process". Same lesson as model.ts's closeSync.
    try { c.disconnectSync(); } catch { /* already disconnected */ }
    try { (instance as any).closeSync?.(); } catch { /* already closed */ }
  } };
}

export async function introspectMysql(conn: MysqlConn, opts: IntrospectOptions = {}): Promise<IntrospectResult> {
  const sampleN = Math.max(1, opts.sampleRows ?? 5);
  const warnings: string[] = [];
  const log = opts.onPhase ?? (() => {});

  const h = await attachMysql(conn, opts);
  const { readAll } = h;
  try {
    // Tables + columns from DuckDB's catalog view of the attached MySQL db.
    log("listing tables and columns…");
    const tableRows = await readAll(
      `SELECT schema_name AS schema, table_name AS name FROM duckdb_tables() WHERE database_name = 'src' ORDER BY table_name`,
      "list tables",
    );
    const colRows = await readAll(
      `SELECT table_name AS name, column_name AS col, data_type AS type FROM duckdb_columns() WHERE database_name = 'src' ORDER BY table_name, column_index`,
      "list columns",
    );
    const colsByTable = new Map<string, { col: string; type: string }[]>();
    for (const r of colRows) {
      const n = String(r.name);
      if (!colsByTable.has(n)) colsByTable.set(n, []);
      colsByTable.get(n)!.push({ col: String(r.col), type: String(r.type) });
    }

    // Approximate row counts straight from MySQL's information_schema — cheap,
    // avoids a count(*) scan over production tables.
    const counts = new Map<string, number>();
    try {
      const innerSql = `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = ${qstr(conn.database).replace(/'/g, "''")}`;
      const cr = await readAll(`SELECT * FROM mysql_query('src', ${qstr(innerSql)})`, "row counts");
      for (const r of cr) {
        const tn = String((r.table_name ?? (r as any).TABLE_NAME) ?? "");
        counts.set(tn, Number((r.table_rows ?? (r as any).TABLE_ROWS) ?? 0));
      }
    } catch (e) {
      warnings.push(`approximate row counts unavailable (${(e as Error).message}); falling back to sample size`);
    }

    // Every discovered table (cheap; no per-table queries) — used for selection.
    const allTables = tableRows.map((t) => ({ name: String(t.name), approxRows: counts.get(String(t.name)) ?? 0 }));
    log(`discovered ${allTables.length} table(s).`);

    // Decide WHICH tables to actually profile (sample). Sampling is one query per
    // table, so on a 12k-table schema we must NOT sample everything.
    let toProfile: { name: string; schema: string }[];
    if (opts.listOnly) {
      toProfile = [];
    } else if (opts.tables && opts.tables.length) {
      const wanted = new Set(opts.tables.map((s) => s.toLowerCase()));
      toProfile = tableRows
        .filter((t) => wanted.has(String(t.name).toLowerCase()))
        .map((t) => ({ name: String(t.name), schema: String(t.schema) }));
      for (const w of opts.tables) {
        if (!allTables.some((t) => t.name.toLowerCase() === w.toLowerCase())) warnings.push(`requested table not found: ${w}`);
      }
    } else {
      const cap = opts.maxTables ?? 25;
      toProfile = tableRows.slice(0, cap).map((t) => ({ name: String(t.name), schema: String(t.schema) }));
      if (allTables.length > cap) warnings.push(`profiled the first ${cap} of ${allTables.length} tables — pass specific table names to profile others`);
    }

    const datasets: Dataset[] = [];
    if (toProfile.length) {
      log(`profiling ${toProfile.length} table(s) — sampling ${sampleN} rows each${opts.windowDays ? `, windowed to the last ${opts.windowDays} day(s)` : ""}…`);
    }
    for (const t of toProfile) {
      const name = t.name;
      const schema = t.schema;
      const cols = colsByTable.get(name) ?? [];
      const ref = `src.${qid(schema)}.${qid(name)}`;

      // Resolve the time window (if requested) to a WHERE clause on a date column.
      let where = "";
      let windowInfo = "";
      let windowedCount: number | undefined;
      if (opts.windowDays && opts.windowDays > 0) {
        const dateCol = pickDateColumn(cols, opts.dateColumn);
        if (!dateCol) {
          warnings.push(`${name}: no usable date column${opts.dateColumn ? ` ("${opts.dateColumn}" not found)` : ""} — returning unfiltered sample`);
        } else {
          where = ` WHERE ${qid(dateCol)} >= (CURRENT_DATE - INTERVAL '${Math.floor(opts.windowDays)} days')`;
          windowInfo = `${dateCol} ≥ today−${opts.windowDays}d`;
          try {
            const cr = await readAll(`SELECT count(*) AS n FROM ${ref}${where}`, `count ${name}`);
            windowedCount = Number((cr[0] as any)?.n ?? 0);
          } catch (e) {
            warnings.push(`windowed count failed for ${name}: ${(e as Error).message}`);
          }
        }
      }

      let sample: Record<string, unknown>[] = [];
      try {
        sample = await readAll(`SELECT * FROM ${ref}${where} LIMIT ${sampleN}`, `sample ${name}`);
      } catch (e) {
        warnings.push(`sample failed for ${name}: ${(e as Error).message}`);
      }
      if (windowInfo) log(`  ${name}: ${windowInfo} → ~${(windowedCount ?? sample.length).toLocaleString()} rows`);

      let columns: ColumnProfile[] = cols.map(({ col, type }) => {
        const values = sample.map((r) => r[col]).filter((v) => v !== null && v !== undefined);
        return {
          name: col,
          type: duckTypeToColumnType(type),
          nullable: sample.some((r) => r[col] === null || r[col] === undefined),
          uniqueCount: new Set(values.map((v) => String(v))).size,
          sampleValues: values.slice(0, 5),
        };
      });

      columns = enrichColumns(columns, sample);

      datasets.push({
        tableName: name,
        profile: {
          source: { filename: `mysql:${conn.database}.${name}${windowInfo ? ` [${windowInfo}]` : ""}`, format: "json" },
          rowCount: windowedCount ?? counts.get(name) ?? sample.length,
          columns,
          sampleRows: sample,
        },
      });
    }

    return { datasets, allTables, warnings };
  } finally {
    h.close();
  }
}
