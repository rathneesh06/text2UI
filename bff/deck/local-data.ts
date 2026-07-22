// bff/deck/local-data.ts — makes UPLOADED data a first-class source for the deck (and
// dashboard) pipelines. It loads CSV files or in-memory rows into an ephemeral DuckDB,
// profiles each table, and hands back a query function with the SAME shape as coloQuery.
// So the pipeline doesn't care whether the data is the colo snapshot or a file the user
// just dropped in — both resolve real charts server-side. Call close() when done.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Dataset, DataProfile, ColumnProfile, ColumnType } from "../../shared/types";
import { enrichColumns } from "../../shared/profile-enrich";

const qid = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
const qstr = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const toNum = (v: unknown) => (typeof v === "bigint" ? Number(v) : v);

function mapType(duck: string): ColumnType {
  const t = duck.toUpperCase();
  if (/(INT|HUGEINT|SERIAL)/.test(t)) return "integer";
  if (/(DOUBLE|DECIMAL|FLOAT|REAL|NUMERIC)/.test(t)) return "number";
  if (/BOOL/.test(t)) return "boolean";
  if (/(DATE|TIMESTAMP|TIME)/.test(t)) return "date";
  return "string";
}

export interface LocalData {
  datasets: Dataset[];
  query: (sql: string) => Promise<Record<string, unknown>[]>;
  close: () => void;
}

async function readRows(conn: DuckDBConnection, sql: string, cap = 100_000): Promise<Record<string, unknown>[]> {
  const reader = await conn.runAndReadUntil(sql, cap);
  return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((r) => {
    for (const k in r) r[k] = toNum(r[k]);
    return r;
  });
}

async function profileTable(conn: DuckDBConnection, table: string, format: DataProfile["source"]["format"]): Promise<Dataset> {
  const desc = await readRows(conn, `DESCRIBE ${qid(table)}`);
  const colNames = desc.map((d) => String(d.column_name));
  const [{ n: rowCount }] = await readRows(conn, `SELECT count(*) AS n FROM ${qid(table)}`);
  const distinct = colNames.length
    ? (await readRows(conn, `SELECT ${colNames.map((c) => `approx_count_distinct(${qid(c)}) AS ${qid(c)}`).join(", ")} FROM ${qid(table)}`))[0]
    : {};
  const sample = await readRows(conn, `SELECT * FROM ${qid(table)} LIMIT 20`);

  let columns: ColumnProfile[] = desc.map((d) => {
    const name = String(d.column_name);
    return {
      name,
      type: mapType(String(d.column_type)),
      nullable: true,
      uniqueCount: Number(distinct[name] ?? 0),
      sampleValues: sample.slice(0, 5).map((r) => r[name]),
    };
  });

  columns = enrichColumns(columns, sample);
  const profile: DataProfile = {
    source: { filename: `upload:${table}`, format },  // upload: marker → never treated as colo
    rowCount: Number(rowCount ?? 0),
    columns,
    sampleRows: sample,
  };
  return { tableName: table, profile };
}

function makeHandle(inst: DuckDBInstance, conn: DuckDBConnection, datasets: Dataset[]): LocalData {
  return { datasets, query: (sql) => readRows(conn, sql), close: () => { try { conn.disconnectSync(); } catch { /* */ } } };
}

/** Load one or more CSV files into an ephemeral DuckDB. tableName is the logical name
 *  the prompt/spec will reference. */
export async function loadCsvFiles(files: { tableName: string; path: string }[]): Promise<LocalData> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const datasets: Dataset[] = [];
  for (const f of files) {
    await conn.run(`CREATE TABLE ${qid(f.tableName)} AS SELECT * FROM read_csv_auto(${qstr(f.path)}, header=true, sample_size=-1)`);
    datasets.push(await profileTable(conn, f.tableName, "csv"));
  }
  return makeHandle(inst, conn, datasets);
}

/** Load in-memory rows (what the client uploads) into an ephemeral DuckDB. */
export async function loadRows(tables: { tableName: string; rows: Record<string, unknown>[] }[]): Promise<LocalData> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const dir = mkdtempSync(join(tmpdir(), "t2ui-"));
  const datasets: Dataset[] = [];
  try {
    for (const t of tables) {
      const p = join(dir, `${t.tableName}.json`);
      writeFileSync(p, JSON.stringify(t.rows ?? []));
      await conn.run(`CREATE TABLE ${qid(t.tableName)} AS SELECT * FROM read_json_auto(${qstr(p)})`);
      datasets.push(await profileTable(conn, t.tableName, "json"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return makeHandle(inst, conn, datasets);
}