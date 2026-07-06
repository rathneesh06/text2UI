// bff/sources/db-conn.ts — the dialect layer for the SQL Workbench. One interface,
// two engines: MySQL (delegating to the battle-tested mysql.ts) and Postgres
// (DuckDB's `postgres` extension, which mirrors the `mysql` one: SECRET + ATTACH
// READ_ONLY as `src`).
//
// Two things live here on purpose:
//   1. REFS, not guesses — introspection returns each table's exact SQL reference
//      (src."schema"."table"). Postgres needs the schema (public.orders), and
//      being explicit hardens the MySQL path too: the planner copies the ref
//      verbatim instead of inferring how DuckDB resolves two-part names.
//   2. A dialect-agnostic whole-table snapshot for extracts. The workbench never
//      date-windows (that's the colo CLI's job in mysql-snapshot.ts) — it pulls
//      the selected tables whole into a local DuckDB file, capped.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  parseMysqlUrl, attachMysql, introspectMysql, qstr, qid, duckTypeToColumnType,
  type MysqlConn, type AttachHandle, type AttachOptions, type IntrospectOptions,
} from "./mysql";
import type { ColumnProfile, Dataset } from "../../shared/types";

export type Dialect = "mysql" | "postgres";

export interface DbConn extends MysqlConn {
  dialect: Dialect;
}

export interface DbTableInfo {
  name: string;          // display name: bare for the default schema, "schema.table" otherwise
  schema: string;        // catalog schema inside the attached `src`
  table: string;         // bare table name
  ref: string;           // the EXACT reference to use in SQL: src."schema"."table"
  approxRows: number;
}

export interface DbIntrospectResult {
  datasets: Dataset[];
  allTables: DbTableInfo[];
  warnings: string[];
}

const PG_SCHEME_RE = /^postgres(?:ql)?(?:\+[a-z0-9]+)?:\/\//i;
const HIDDEN_PG_SCHEMAS = new Set(["information_schema", "pg_catalog", "pg_toast"]);

export const refFor = (schema: string, table: string) => `src.${qid(schema)}.${qid(table)}`;

/** Which engine a connection string is for. Explicit only: a postgres:// or
 *  postgresql:// scheme, or dialect=/driver=postgres in key=value form.
 *  Everything else stays MySQL — exactly the pre-Postgres behavior. */
export function detectDialect(input: string): Dialect {
  const s = (input ?? "").trim();
  if (PG_SCHEME_RE.test(s)) return "postgres";
  if (!/:\/\//.test(s) && /(^|\s)(dialect|driver|engine)=postgres(ql)?(\s|$)/i.test(s)) return "postgres";
  return "mysql";
}

/** Percent-decode one URL component IF it is valid percent-encoding; otherwise
 *  return it untouched. Postgres URIs are percent-encoded per the libpq spec
 *  (pgAdmin/SQLAlchemy emit e.g. p%40ss for p@ss), so both conventions work:
 *    encoded (the standard):        p%40ss123   -> p@ss123
 *    raw (the original hardening):  p@ss%word!  -> p@ss%word!  (decode throws -> raw)
 *  A password whose LITERAL text is a valid escape (e.g. "%40") is the one
 *  ambiguity — the URL standard wins; use the structured Postgres form or the
 *  key=value string to pass fully raw credentials. */
export function safeDecode(component: string): string {
  if (!component.includes("%")) return component;
  try { return decodeURIComponent(component); } catch { return component; }
}

/** Parse either dialect's connection string. Reuses the hardened mysql.ts parser
 *  (raw @ # $ ! passwords survive), then fixes the defaults the MySQL parser
 *  applied when the string didn't state them: port 5432, user "postgres".
 *
 *  Encoding: percent-decoding applies to POSTGRES URLs only (the libpq spec says
 *  URIs are encoded). MySQL keeps the existing raw-passthrough behavior byte-exact
 *  — strings already in production .envs must not silently change meaning. */
export function parseDbUrl(input: string): DbConn {
  const dialect = detectDialect(input);
  const base = parseMysqlUrl(input);
  const s = (input ?? "").trim();
  const scheme = s.match(/^[a-z][a-z0-9]*(?:\+[a-z0-9]+)?:\/\//i);
  if (dialect === "postgres" && scheme) {
    // URL form: honor standard percent-encoding in the credential/database parts.
    base.user = safeDecode(base.user);
    base.password = safeDecode(base.password);
    base.database = safeDecode(base.database);
  }
  if (dialect === "postgres") {
    if (scheme) {
      const rest = s.slice(scheme[0].length);
      const slash = rest.indexOf("/");
      const authority = slash >= 0 ? rest.slice(0, slash) : rest;
      const hostport = authority.slice(authority.lastIndexOf("@") + 1);
      const hasPort = /:\d+$/.test(hostport);
      const hasUser = authority.includes("@");
      if (!hasPort) base.port = 5432;
      if (!hasUser) base.user = "postgres";
    } else {
      // key=value form: parseMysqlUrl already honored explicit port=/user=;
      // only the fallbacks it injected need re-aiming at Postgres.
      if (!/(^|\s)port=/i.test(input)) base.port = 5432;
      if (!/(^|\s)(user|username)=/i.test(input)) base.user = "postgres";
    }
  }
  return { ...base, dialect };
}

/** Mask a connection for safe logging/UI — never reveals the password. */
export function describeDbConn(c: DbConn): string {
  return `${c.dialect}://${c.user}:***@${c.host}:${c.port}/${c.database}${c.ssl ? " (ssl)" : ""}`;
}

export interface DbConnParts {
  dialect?: Dialect;     // default "postgres" — the structured form is the PG page's path
  host: string;
  port?: number | string;
  database: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

/** Build a connection from structured fields — NO string parsing, NO encoding
 *  rules. This is the dedicated Postgres page's connect path: every field is
 *  taken literally, so passwords with @ % # $ ! need zero escaping. */
export function connFromParts(parts: DbConnParts): DbConn {
  const dialect: Dialect = parts.dialect === "mysql" ? "mysql" : "postgres";
  const host = String(parts.host ?? "").trim();
  const database = String(parts.database ?? "").trim();
  if (!host) throw new Error("host is required");
  if (!database) throw new Error("database is required");
  const portN = Number(parts.port ?? (dialect === "postgres" ? 5432 : 3306));
  if (!Number.isInteger(portN) || portN <= 0 || portN > 65535) throw new Error("port must be a number between 1 and 65535");
  return {
    dialect,
    host,
    port: portN,
    database,
    user: String(parts.user ?? "").trim() || (dialect === "postgres" ? "postgres" : "root"),
    password: String(parts.password ?? ""),   // literal — never trimmed, never decoded
    ssl: Boolean(parts.ssl),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/** Attach either engine READ_ONLY as `src`. MySQL delegates to attachMysql
 *  verbatim; Postgres mirrors its structure with the `postgres` extension. */
export async function attachDb(conn: DbConn, opts: AttachOptions = {}): Promise<AttachHandle> {
  if (conn.dialect === "mysql") return attachMysql(conn, opts);

  const log = opts.onPhase ?? (() => {});
  const installMs = opts.installTimeoutMs ?? 90_000;
  const attachMs = opts.attachTimeoutMs ?? 25_000;
  const queryMs = opts.queryTimeoutMs ?? 30_000;

  log(`creating DuckDB engine${opts.dbPath && opts.dbPath !== ":memory:" ? ` (${opts.dbPath})` : ""}…`);
  const { DuckDBInstance } = await import("@duckdb/node-api");
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
    const ext = await readAll(`SELECT installed FROM duckdb_extensions() WHERE extension_name = 'postgres'`, "extension check");
    installed = ext.length > 0 && Boolean((ext[0] as any).installed);
  } catch { /* fall through to INSTALL */ }
  if (!installed) {
    log("installing the 'postgres' extension (first run downloads it from extensions.duckdb.org — needs internet egress)…");
    await run("INSTALL postgres", installMs, "INSTALL postgres");
  } else {
    log("'postgres' extension already installed (cached).");
  }
  log("loading the 'postgres' extension…");
  await run("LOAD postgres", 30_000, "LOAD postgres");

  log("registering credentials (DuckDB SECRET)…");
  await c.run(
    `CREATE OR REPLACE SECRET t2ui_postgres (TYPE postgres, HOST ${qstr(conn.host)}, PORT ${conn.port}, ` +
    `USER ${qstr(conn.user)}, PASSWORD ${qstr(conn.password)}, DATABASE ${qstr(conn.database)});`,
  );
  log(`attaching Postgres ${conn.host}:${conn.port}/${conn.database} (READ_ONLY)…`);
  // The ATTACH path string overrides/extends the secret — used only for sslmode.
  const attachStr = conn.ssl ? "sslmode=require" : "";
  await run(`ATTACH ${qstr(attachStr)} AS src (TYPE postgres, READ_ONLY, SECRET t2ui_postgres)`, attachMs, "ATTACH (Postgres handshake)");

  return { instance, c, readAll, run, close: () => c.disconnectSync() };
}

/** Introspect either engine into one uniform result with exact SQL refs. */
export async function introspectDb(conn: DbConn, opts: IntrospectOptions = {}): Promise<DbIntrospectResult> {
  if (conn.dialect === "mysql") {
    // Delegate to the proven implementation, then attach refs. The MySQL attach
    // exposes the connected database as the schema of the same name inside `src`.
    const r = await introspectMysql(conn, opts);
    return {
      datasets: r.datasets,
      warnings: r.warnings,
      allTables: r.allTables.map((t) => ({
        name: t.name, schema: conn.database, table: t.name,
        ref: refFor(conn.database, t.name), approxRows: t.approxRows,
      })),
    };
  }
  return introspectPostgres(conn, opts);
}

async function introspectPostgres(conn: DbConn, opts: IntrospectOptions = {}): Promise<DbIntrospectResult> {
  const sampleN = Math.max(1, opts.sampleRows ?? 5);
  const warnings: string[] = [];
  const log = opts.onPhase ?? (() => {});
  const h = await attachDb(conn, opts);
  const { readAll } = h;
  try {
    // Tables + columns + row estimates straight from DuckDB's catalog view of the
    // attached database — estimated_size comes from pg reltuples (cheap, no scan).
    log("listing tables and columns…");
    const tableRows = await readAll(
      `SELECT schema_name AS schema, table_name AS name, estimated_size AS est FROM duckdb_tables() WHERE database_name = 'src' ORDER BY schema_name, table_name`,
      "list tables",
    );
    const colRows = await readAll(
      `SELECT schema_name AS schema, table_name AS name, column_name AS col, data_type AS type FROM duckdb_columns() WHERE database_name = 'src' ORDER BY table_name, column_index`,
      "list columns",
    );
    const visible = tableRows.filter((t) => !HIDDEN_PG_SCHEMAS.has(String(t.schema)));
    const key = (schema: unknown, name: unknown) => `${String(schema)}.${String(name)}`;
    const colsByTable = new Map<string, { col: string; type: string }[]>();
    for (const r of colRows) {
      const k = key(r.schema, r.name);
      if (!colsByTable.has(k)) colsByTable.set(k, []);
      colsByTable.get(k)!.push({ col: String(r.col), type: String(r.type) });
    }

    const allTables: DbTableInfo[] = visible.map((t) => {
      const schema = String(t.schema);
      const table = String(t.name);
      return {
        name: schema === "public" ? table : `${schema}.${table}`,
        schema, table, ref: refFor(schema, table),
        approxRows: Math.max(0, Number(t.est ?? 0)),
      };
    });
    log(`discovered ${allTables.length} table(s).`);

    // Which tables to profile (sampling is one query per table — cap it).
    let toProfile: DbTableInfo[];
    if (opts.listOnly) {
      toProfile = [];
    } else if (opts.tables && opts.tables.length) {
      const wanted = new Set(opts.tables.map((s) => s.toLowerCase()));
      toProfile = allTables.filter((t) => wanted.has(t.name.toLowerCase()) || wanted.has(t.table.toLowerCase()));
      for (const w of opts.tables) {
        if (!toProfile.some((t) => t.name.toLowerCase() === w.toLowerCase() || t.table.toLowerCase() === w.toLowerCase())) {
          warnings.push(`requested table not found: ${w}`);
        }
      }
    } else {
      const cap = opts.maxTables ?? 25;
      toProfile = allTables.slice(0, cap);
      if (allTables.length > cap) warnings.push(`profiled the first ${cap} of ${allTables.length} tables — pass specific table names to profile others`);
    }

    const datasets: Dataset[] = [];
    if (toProfile.length) log(`profiling ${toProfile.length} table(s) — sampling ${sampleN} rows each…`);
    for (const t of toProfile) {
      let sample: Record<string, unknown>[] = [];
      try {
        sample = await readAll(`SELECT * FROM ${t.ref} LIMIT ${sampleN}`, `sample ${t.name}`);
      } catch (e) {
        warnings.push(`sample failed for ${t.name}: ${(e as Error).message}`);
      }
      const cols = colsByTable.get(key(t.schema, t.table)) ?? [];
      const columns: ColumnProfile[] = cols.map(({ col, type }) => {
        const values = sample.map((r) => r[col]).filter((v) => v !== null && v !== undefined);
        return {
          name: col,
          type: duckTypeToColumnType(type),
          nullable: sample.some((r) => r[col] === null || r[col] === undefined),
          uniqueCount: new Set(values.map((v) => String(v))).size,
          sampleValues: values.slice(0, 5),
        };
      });
      datasets.push({
        tableName: t.name,
        profile: {
          source: { filename: `postgres:${t.schema}.${t.table}`, format: "json" },
          rowCount: t.approxRows || sample.length,
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

// ---- workbench extraction: whole-table snapshot, dialect-agnostic ----------------

export interface WbSnapshotOptions {
  tables: string[];          // display names or bare table names, as the user said them
  dbPath: string;            // DuckDB file to create
  rowCap?: number;           // safety LIMIT per table (default 2,000,000)
  sampleRows?: number;
  onPhase?: (msg: string) => void;
  snapshotTimeoutMs?: number;
}

export interface WbSnapshotResult {
  dbPath: string;
  datasets: Dataset[];
  warnings: string[];
  skipped: string[];
}

const localName = (table: string) =>
  table.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "t";

/** Pull the named tables WHOLE (capped) from either engine into a local DuckDB
 *  file, profiling each as it lands. The snapshot reads straight through the
 *  read-only attach — production is touched exactly once per table. */
export async function snapshotTables(conn: DbConn, opts: WbSnapshotOptions): Promise<WbSnapshotResult> {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const h = await attachDb(conn, { dbPath: opts.dbPath, onPhase: opts.onPhase });
  try {
    return await snapshotFromHandle(h, conn.dialect, opts);
  } finally {
    h.close();
  }
}

/** The engine-agnostic core: works on ANY handle whose `src` catalog holds the
 *  source tables (live MySQL/Postgres attach in production; a plain DuckDB
 *  attach in tests). Exported for testability — same injectable-deps posture as
 *  the pure route handlers. */
export async function snapshotFromHandle(
  h: Pick<AttachHandle, "readAll" | "run">,
  dialect: Dialect,
  opts: WbSnapshotOptions,
): Promise<WbSnapshotResult> {
  const rowCap = opts.rowCap ?? 2_000_000;
  const sampleN = Math.max(1, opts.sampleRows ?? 5);
  const snapMs = opts.snapshotTimeoutMs ?? 120_000;
  const log = opts.onPhase ?? (() => {});
  const warnings: string[] = [];
  const skipped: string[] = [];
  const { readAll, run } = h;

  // Resolve the requested names against what actually exists in `src`.
  const catalog = (await readAll(
    `SELECT schema_name AS schema, table_name AS name FROM duckdb_tables() WHERE database_name = 'src'`,
    "list tables",
  )).map((r) => ({ schema: String(r.schema), table: String(r.name) }))
    .filter((t) => !HIDDEN_PG_SCHEMAS.has(t.schema));

  const resolve = (want: string) => {
    const w = want.trim().toLowerCase();
    return catalog.find((t) => t.table.toLowerCase() === w)
      ?? catalog.find((t) => `${t.schema}.${t.table}`.toLowerCase() === w)
      ?? null;
  };

  const datasets: Dataset[] = [];
  const used = new Set<string>();
  for (const want of opts.tables) {
    const hit = resolve(want);
    if (!hit) { skipped.push(`${want}: table not found`); continue; }
    let local = localName(hit.table);
    for (let i = 2; used.has(local); i++) local = `${localName(hit.table)}_${i}`;
    used.add(local);

    log(`snapshotting ${hit.schema}.${hit.table} — entire table…`);
    const dest = `${qid("main")}.${qid(local)}`;
    try {
      await run(`CREATE OR REPLACE TABLE ${dest} AS SELECT * FROM ${refFor(hit.schema, hit.table)} LIMIT ${rowCap}`, snapMs, `snapshot ${want}`);
    } catch (e) {
      skipped.push(`${want}: ${(e as Error).message}`);
      continue;
    }
    const cnt = await readAll(`SELECT count(*) AS n FROM ${dest}`, `count ${want}`);
    const rowCount = Number((cnt[0] as any)?.n ?? 0);
    if (rowCount >= rowCap) warnings.push(`${want}: hit ${rowCap.toLocaleString()} row cap`);
    const sample = await readAll(`SELECT * FROM ${dest} LIMIT ${sampleN}`, `sample ${want}`);
    const described = await readAll(`DESCRIBE ${dest}`, `describe ${want}`);
    const columns: ColumnProfile[] = described.map((d) => {
      const col = String((d as any).column_name);
      const values = sample.map((r) => r[col]).filter((v) => v !== null && v !== undefined);
      return {
        name: col,
        type: duckTypeToColumnType(String((d as any).column_type)),
        nullable: sample.some((r) => r[col] === null || r[col] === undefined),
        uniqueCount: new Set(values.map((v) => String(v))).size,
        sampleValues: values.slice(0, 5),
      };
    });
    datasets.push({
      tableName: local,
      profile: {
        source: { filename: `${dialect}:${hit.schema}.${hit.table} (full)`, format: "json" },
        rowCount, columns, sampleRows: sample,
      },
    });
  }
  return { dbPath: opts.dbPath, datasets, warnings, skipped };
}
