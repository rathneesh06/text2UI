// bff/sources/exact-stats.ts — EXACT column statistics for DB-backed profilers.
//
// Sample-based enrichment (shared/profile-enrich) is a floor; when we hold a
// live handle (colo DuckDB, wb snapshot, Postgres/MySQL connections) we can do
// better: full-table GROUP BY for categorical topValues (which also yields an
// EXACT uniqueCount when the group count fits the limit — that exactness is
// what lets the observed-value guard say "provably empty" without lying) and
// one min/max sweep per table for numeric + date columns. Every query is
// best-effort: a failure leaves the sample-derived floor in place.
import type { ColumnProfile } from "../../shared/types";
import { TOP_VALUES_LIMIT } from "../../shared/profile-enrich";

export type ReadAll = (sql: string, label?: string) => Promise<Record<string, unknown>[]>;

/** Quote an identifier DuckDB/Postgres-style. */
const qid = (s: string) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * Enrich `columns` in place-copy with exact stats from the live table.
 * `tableRef` must already be a safe/qualified reference (the caller built it).
 */
export async function exactColumnStats(
  readAll: ReadAll,
  tableRef: string,
  columns: ColumnProfile[],
  opts: { maxDistinctForTop?: number } = {},
): Promise<ColumnProfile[]> {
  const maxDistinct = opts.maxDistinctForTop ?? 50;
  const out = columns.map((c) => ({ ...c }));

  // 1. Categorical topValues + exact uniqueCount, one query per string column
  //    that isn't obviously id-like (sample floor already estimated that).
  for (const c of out) {
    if (c.type !== "string") continue;
    if (c.uniqueCount > maxDistinct && c.topValues === undefined) continue; // sample says id-like/free text
    try {
      const rows = await readAll(
        `SELECT ${qid(c.name)} AS v, count(*) AS c FROM ${tableRef} WHERE ${qid(c.name)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${TOP_VALUES_LIMIT + 1}`,
        `topValues ${c.name}`,
      );
      if (!rows.length) continue;
      if (rows.length <= TOP_VALUES_LIMIT) {
        // We saw EVERY distinct value — uniqueCount becomes exact, and the
        // observed-value guard's exhaustiveness inference (uniqueCount <=
        // topValues.length) is now truthful.
        c.topValues = rows.map((r) => ({ value: String(r.v), count: Number(r.c) }));
        c.uniqueCount = rows.length;
      } else {
        // More values exist than we list: keep the top slice, and make sure
        // uniqueCount says NON-exhaustive so the guard only warns, never drops.
        c.topValues = rows.slice(0, TOP_VALUES_LIMIT).map((r) => ({ value: String(r.v), count: Number(r.c) }));
        c.uniqueCount = Math.max(c.uniqueCount, TOP_VALUES_LIMIT + 1);
      }
    } catch { /* keep the sample floor */ }
  }

  // 2. min/max for numeric + date columns — one sweep per table.
  const ranged = out.filter((c) => c.type === "integer" || c.type === "number" || c.type === "date");
  if (ranged.length) {
    const selects = ranged.flatMap((c, i) => [
      `min(${qid(c.name)}) AS lo${i}`,
      `max(${qid(c.name)}) AS hi${i}`,
    ]);
    try {
      const [row] = await readAll(`SELECT ${selects.join(", ")} FROM ${tableRef}`, "min/max sweep");
      if (row) {
        ranged.forEach((c, i) => {
          const lo = row[`lo${i}`], hi = row[`hi${i}`];
          if (lo === null || lo === undefined) return;
          if (c.type === "date") {
            c.min = lo instanceof Date ? lo.toISOString() : String(lo);
            c.max = hi instanceof Date ? hi.toISOString() : String(hi);
          } else {
            const nlo = Number(lo), nhi = Number(hi);
            if (Number.isFinite(nlo)) { c.min = nlo; c.max = Number.isFinite(nhi) ? nhi : nlo; }
          }
        });
      }
    } catch { /* keep the sample floor */ }
  }

  return out;
}
