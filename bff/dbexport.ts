// bff/dbexport.ts — Wave 2 / N3, Step 1: portable SQL dump generator.
//
// Turns a project's tables (column types + rows) into portable SQL the user can
// load into their OWN database to power the exported app's remote data layer:
//   - schema.sql : CREATE TABLE statements (typed, quoted identifiers)
//   - seed.sql   : batched INSERTs (escaped values, dialect-correct literals)
// Pure + deterministic — no DB driver, no network — so it's fully testable, and
// the output is verified by actually loading it into DuckDB and SQLite.

export type SqlDialect = "duckdb" | "postgres" | "sqlite";

export interface DumpColumn { name: string; type?: string }
export interface DumpTable {
  tableName: string;
  columns?: DumpColumn[]; // if omitted, inferred from rows
  rows: Record<string, unknown>[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/;

/** Infer a coarse column type from row values when no profile is supplied. */
export function inferColumns(rows: Record<string, unknown>[]): DumpColumn[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); names.push(k); }
  return names.map((name) => {
    let t: string | undefined;
    for (const r of rows) {
      const v = r[name];
      if (v === null || v === undefined) continue;
      if (typeof v === "number") { t = pickWiderNumeric(t); }
      else if (typeof v === "boolean") { t = t && t !== "boolean" ? "string" : "boolean"; }
      else if (typeof v === "string" && ISO_DATE.test(v)) { t = t && t !== "date" ? "string" : "date"; }
      else { t = "string"; }
    }
    return { name, type: t ?? "string" };
  });
}
function pickWiderNumeric(prev: string | undefined): string {
  return prev && prev !== "number" ? "string" : "number";
}

function normalizeType(type: string | undefined): "string" | "number" | "boolean" | "date" {
  const t = (type ?? "string").toLowerCase();
  if (t.startsWith("num") || t === "integer" || t === "int" || t === "float" || t === "double" || t === "real") return "number";
  if (t.startsWith("bool")) return "boolean";
  if (t === "date" || t === "datetime" || t === "timestamp") return "date";
  return "string";
}

/** Map a logical type to a concrete SQL type for the dialect. */
export function sqlType(type: string | undefined, dialect: SqlDialect): string {
  const t = normalizeType(type);
  if (t === "number") return dialect === "postgres" ? "DOUBLE PRECISION" : dialect === "sqlite" ? "REAL" : "DOUBLE";
  if (t === "boolean") return dialect === "sqlite" ? "INTEGER" : "BOOLEAN";
  if (t === "date") return dialect === "sqlite" ? "TEXT" : "TIMESTAMP";
  return "TEXT";
}

/** Double-quote an identifier, escaping embedded double quotes. */
export function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Render a JS value as a SQL literal for the dialect. */
export function formatValue(v: unknown, type: string | undefined, dialect: SqlDialect): string {
  if (v === null || v === undefined) return "NULL";
  const t = normalizeType(type);
  if (t === "number" || typeof v === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : "NULL";
  }
  if (t === "boolean" || typeof v === "boolean") {
    const b = v === true || v === "true" || v === 1 || v === "1";
    return dialect === "sqlite" ? (b ? "1" : "0") : (b ? "TRUE" : "FALSE");
  }
  // strings, dates, and anything else -> quoted text (objects -> JSON)
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return "'" + s.replace(/'/g, "''") + "'";
}

const BATCH = 500;

export function toSchemaSql(tables: DumpTable[], dialect: SqlDialect = "duckdb"): string {
  const out: string[] = [];
  for (const tbl of tables) {
    const cols = tbl.columns?.length ? tbl.columns : inferColumns(tbl.rows);
    const defs = cols.map((c) => `  ${quoteIdent(c.name)} ${sqlType(c.type, dialect)}`).join(",\n");
    out.push(`DROP TABLE IF EXISTS ${quoteIdent(tbl.tableName)};`);
    out.push(`CREATE TABLE ${quoteIdent(tbl.tableName)} (\n${defs}\n);`);
    out.push("");
  }
  return out.join("\n");
}

export function toSeedSql(tables: DumpTable[], dialect: SqlDialect = "duckdb"): string {
  const out: string[] = [];
  for (const tbl of tables) {
    const cols = tbl.columns?.length ? tbl.columns : inferColumns(tbl.rows);
    if (!tbl.rows.length) continue;
    const colList = cols.map((c) => quoteIdent(c.name)).join(", ");
    for (let i = 0; i < tbl.rows.length; i += BATCH) {
      const batch = tbl.rows.slice(i, i + BATCH);
      const values = batch
        .map((row) => "(" + cols.map((c) => formatValue(row[c.name], c.type, dialect)).join(", ") + ")")
        .join(",\n  ");
      out.push(`INSERT INTO ${quoteIdent(tbl.tableName)} (${colList}) VALUES\n  ${values};`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** Full portable dump: schema then seed. */
export function toSqlDump(tables: DumpTable[], dialect: SqlDialect = "duckdb"): string {
  return [
    `-- text2UI data export (${dialect})`,
    `-- ${tables.length} table(s): ${tables.map((t) => t.tableName).join(", ")}`,
    "",
    toSchemaSql(tables, dialect),
    toSeedSql(tables, dialect),
  ].join("\n");
}
