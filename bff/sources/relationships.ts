// bff/sources/relationships.ts — VERIFIED relationship edges (Phase A3).
//
// widget.join compiles ONLY against edges produced here. Two rungs:
//   "constraint" — declared FKs read from the source database's catalog
//                  (live Postgres / attached MySQL).
//   "measured"   — a name-heuristic candidate PROVEN by executing two checks
//                  on the actual data: the right column is unique + non-null
//                  (a real key) and the left column is contained in it (zero
//                  orphans beyond a tolerance). Available wherever we own a
//                  query handle (colo DuckDB, wb/MySQL snapshots, uploads).
// Name-heuristic candidates that fail (or are never) measured stay advisory —
// the semantic layer may mention them, the compiler must never use them.
//
// Everything here is best-effort: any failing query simply yields no edge.
import type { Dataset, ForeignKeyEdge } from "../../shared/types";
import type { JoinCandidate } from "../datasources/semantic";
import { joinCandidates } from "../datasources/semantic";

export type ReadAll = (sql: string, label?: string) => Promise<Record<string, unknown>[]>;

const qid = (s: string) => `"${String(s).replace(/"/g, '""')}"`;

/** Orphan tolerance: real snapshots have stragglers (a deleted status row);
 *  ≤0.5% orphans still proves the relationship for lookup-join purposes. */
const ORPHAN_TOLERANCE = 0.005;
/** Don't measure absurdly large right sides — a lookup table isn't 5M rows. */
const MAX_REF_ROWS = 500_000;

/** Prove (or refute) one candidate edge by querying the actual data. */
export interface MeasureOpts {
  /** table name → SQL reference (defaults to double-quoted name; live sources
   *  pass their attached refs like src."public"."orders"). */
  tableRef?: (name: string) => string;
  /** column identifier quoting (defaults to double quotes). */
  quoteId?: (s: string) => string;
}

export async function measureCandidate(
  readAll: ReadAll,
  c: JoinCandidate,
  refRowCount: number,
  opts: MeasureOpts = {},
): Promise<ForeignKeyEdge | null> {
  if (refRowCount <= 0 || refRowCount > MAX_REF_ROWS) return null;
  const tref = opts.tableRef ?? qid;
  const quoteId = opts.quoteId ?? qid;
  const L = tref(c.leftTable), R = tref(c.rightTable);
  const lc = quoteId(c.leftCol), rc = quoteId(c.rightCol);
  try {
    // 1. Right side must be a KEY: unique and non-null.
    const [k] = await readAll(
      `SELECT count(*) AS n, count(DISTINCT ${rc}) AS d, count(*) - count(${rc}) AS nulls FROM ${R}`,
      `key check ${c.rightTable}.${c.rightCol}`,
    );
    if (!k || Number(k.nulls) > 0 || Number(k.d) !== Number(k.n) || Number(k.n) === 0) return null;
    // 2. Left side must be CONTAINED: (almost) no orphans.
    const [o] = await readAll(
      `SELECT count(*) AS total, count(*) FILTER (WHERE ${lc} IS NOT NULL AND ${lc} NOT IN (SELECT ${rc} FROM ${R})) AS orphans FROM ${L}`,
      `containment ${c.leftTable}.${c.leftCol}`,
    );
    if (!o || Number(o.total) === 0) return null;
    if (Number(o.orphans) / Number(o.total) > ORPHAN_TOLERANCE) return null;
    return { col: c.leftCol, refTable: c.rightTable, refCol: c.rightCol, verified: "measured" };
  } catch {
    return null;
  }
}

/** Candidate edges = the semantic layer's name-heuristics PLUS a direct
 *  `<stem>_id -> <stem-ish table>.id` rule the semantic bareId matcher misses.
 *  Generation is deliberately LOOSE — measurement is the strict filter, so a
 *  wrong candidate costs one refuted query, never a wrong join. */
export function candidateEdges(datasets: Dataset[]): JoinCandidate[] {
  const out = [...joinCandidates(datasets)];
  const seen = new Set(out.map((c) => [c.leftTable, c.leftCol, c.rightTable, c.rightCol].join("|")));
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const d of datasets) {
    for (const c of d.profile.columns) {
      const m = /^(.+?)_?id$/i.exec(c.name);
      if (!m || !m[1]) continue;
      const stem = flat(m[1]);
      for (const other of datasets) {
        if (other.tableName === d.tableName) continue;
        const t = flat(other.tableName);
        const matches = t === stem || t === stem + "s" || t === stem + "es" || t + "s" === stem
          || (stem.length >= 4 && (t.endsWith(stem) || t.startsWith(stem)));
        if (!matches) continue;
        const idCol = other.profile.columns.find((oc) => /^id$/i.test(oc.name));
        if (!idCol) continue;
        const key = [d.tableName, c.name, other.tableName, idCol.name].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ leftTable: d.tableName, leftCol: c.name, rightTable: other.tableName, rightCol: idCol.name, confidence: "medium", reason: "stem_id -> table.id" });
      }
    }
  }
  return out;
}

/** Measure every name-heuristic candidate among `datasets`, attach the proven
 *  edges to each base table's profile.foreignKeys. Mutates copies; returns
 *  the same array for chaining. Skips candidates already covered by a
 *  constraint edge. */
export async function attachMeasuredForeignKeys(
  readAll: ReadAll,
  datasets: Dataset[],
  opts: MeasureOpts = {},
): Promise<Dataset[]> {
  const byName = new Map(datasets.map((d) => [d.tableName, d]));
  const candidates = candidateEdges(datasets);
  for (const c of candidates) {
    const base = byName.get(c.leftTable);
    const ref = byName.get(c.rightTable);
    if (!base || !ref) continue;
    const existing = base.profile.foreignKeys ?? [];
    if (existing.some((e) => e.col === c.leftCol && e.refTable === c.rightTable && e.refCol === c.rightCol)) continue;
    const edge = await measureCandidate(readAll, c, ref.profile.rowCount, opts);
    if (edge) base.profile.foreignKeys = [...existing, edge];
  }
  return datasets;
}

/** Declared FKs from a live Postgres catalog (readAll runs against Postgres,
 *  either directly or through DuckDB's postgres extension). Table names are
 *  matched to dataset table names by the caller's mapping. */
export async function postgresConstraintEdges(
  readAll: ReadAll,
  schema: string,
): Promise<{ table: string; edge: ForeignKeyEdge }[]> {
  const sql = `SELECT tc.table_name AS t, kcu.column_name AS c, ccu.table_name AS rt, ccu.column_name AS rc
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '${schema.replace(/'/g, "''")}'`;
  try {
    const rows = await readAll(sql, "pg foreign keys");
    return rows.map((r) => ({
      table: String(r.t),
      edge: { col: String(r.c), refTable: String(r.rt), refCol: String(r.rc), verified: "constraint" as const },
    }));
  } catch {
    return [];
  }
}

/** Declared FKs from MySQL's catalog via the mysql_query bridge. */
export async function mysqlConstraintEdges(
  mysql: (sql: string, label: string) => Promise<Record<string, unknown>[]>,
  database: string,
): Promise<{ table: string; edge: ForeignKeyEdge }[]> {
  const sql = `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = '${database.replace(/'/g, "''")}' AND REFERENCED_TABLE_NAME IS NOT NULL`;
  try {
    const rows = await mysql(sql, "mysql foreign keys");
    return rows.map((r) => ({
      table: String(r.t),
      edge: { col: String(r.c), refTable: String(r.rt), refCol: String(r.rc), verified: "constraint" as const },
    }));
  } catch {
    return [];
  }
}

/** Attach a batch of constraint edges to their datasets (name-mapped). */
export function attachConstraintEdges(
  datasets: Dataset[],
  edges: { table: string; edge: ForeignKeyEdge }[],
  nameOf: (sourceTable: string) => string = (t) => t,
): Dataset[] {
  const byName = new Map(datasets.map((d) => [d.tableName, d]));
  for (const { table, edge } of edges) {
    const base = byName.get(nameOf(table));
    const ref = byName.get(nameOf(edge.refTable));
    if (!base || !ref) continue; // edge points outside the loaded set
    const mapped = { ...edge, refTable: ref.tableName };
    const existing = base.profile.foreignKeys ?? [];
    if (existing.some((e) => e.col === mapped.col && e.refTable === mapped.refTable && e.refCol === mapped.refCol)) continue;
    base.profile.foreignKeys = [...existing, mapped];
  }
  return datasets;
}
