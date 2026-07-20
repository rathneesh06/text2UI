// bff/dashboard/sql.ts — the deterministic SQL compiler. Turns a typed widget into
// DuckDB SQL. This is the ONE place SQL is written, so an entire class of bugs (the
// `to_char` dialect mismatch, hallucinated columns, malformed aggregates) is removed
// by construction: the model picks columns/aggregations as data; the SQL grammar is
// fixed and always valid DuckDB.
import type {
  Agg, Dimension, Filter, KpiWidget, ChartWidget, TableWidget, Metric, TimeGrain,
} from "../../shared/dashboard-spec";

/** Quote an identifier for DuckDB. */
export const qid = (s: string) => `"${String(s).replace(/"/g, '""')}"`;

/** A SQL literal for a filter value. */
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Aggregate expression. `count` -> count(*); everything else uses the column. */
export function aggExpr(agg: Agg, col: string): string {
  switch (agg) {
    case "count": return "count(*)";
    case "count_distinct": return `count(DISTINCT ${qid(col)})`;
    case "median": return `median(${qid(col)})`;
    case "sum": case "avg": case "min": case "max": return `${agg}(${qid(col)})`;
    default: return "count(*)";
  }
}

/** A2: the full metric expression — plain aggregate OR the closed derived AST.
 *  Ratios always divide through nullif(den, 0): a zero denominator yields NULL
 *  ("—" in the renderer), and the fake-percent class (sum(col) dressed up as a
 *  percentage) is impossible to express — pct/ratio REQUIRE a real division. */
export function metricExpr(m: Metric): string {
  if (m.expr) {
    const n = aggExpr(m.expr.num.agg, m.expr.num.col);
    const d = aggExpr(m.expr.den.agg, m.expr.den.col);
    if (m.expr.op === "diff") return `(${n} - ${d})`;
    const scale = m.expr.op === "pct" ? "100.0" : "1.0";
    return `(${n} * ${scale} / nullif(${d}, 0))`;
  }
  return aggExpr(m.agg, m.col);
}

/** DuckDB date_trunc — NEVER to_char. Returns a real temporal value the renderer formats. */
const GRAINS: Record<TimeGrain, string> = {
  day: "day", week: "week", month: "month", quarter: "quarter", year: "year",
};
export function dimExpr(d: Dimension): string {
  if (d.timeGrain && GRAINS[d.timeGrain]) return `date_trunc('${GRAINS[d.timeGrain]}', ${qid(d.col)})`;
  return qid(d.col);
}

function oneFilter(f: Filter): string {
  const c = qid(f.col);
  switch (f.op) {
    case "is_null": return `${c} IS NULL`;
    case "not_null": return `${c} IS NOT NULL`;
    case "in": {
      const arr = Array.isArray(f.value) ? f.value : [f.value as any];
      return arr.length ? `${c} IN (${arr.map(lit).join(", ")})` : "1=1";
    }
    case "=": case "!=": case ">": case ">=": case "<": case "<=":
      return `${c} ${f.op} ${lit(f.value)}`;
    default: return "1=1";
  }
}
/** WHERE from widget filters plus optional EXTRA pre-built conditions (A1:
 *  global-filter conditions, built server-side by filters.ts with the same
 *  qid/lit escaping — never client-supplied SQL). */
export function whereClause(filters?: Filter[], extra?: string[]): string {
  const parts = [...(filters ?? []).map(oneFilter), ...(extra ?? [])].filter(Boolean);
  if (!parts.length) return "";
  return " WHERE " + parts.join(" AND ");
}

/** A safe, unique result alias for a series. */
export function seriesKey(m: Metric, i: number): string {
  const base = (m.label || `${m.agg}_${m.col}`)
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "value";
  return `${base}_${i}`;
}

// ---- builders --------------------------------------------------------------

export function buildKpiSql(w: KpiWidget, extraWhere?: string[]): string {
  return `SELECT ${metricExpr(w.metric)} AS value FROM ${qid(w.table)}${whereClause(w.filters, extraWhere)}`;
}

export function buildChartSql(w: ChartWidget, extraWhere?: string[]): { sql: string; seriesKeys: { key: string; label: string }[] } {
  const isPie = w.kind === "pie" || w.kind === "donut";
  const series = isPie ? w.series.slice(0, 1) : w.series;
  const keys = series.map((m, i) => ({ key: seriesKey(m, i), label: m.label || `${m.agg}(${m.col})` }));
  const selectSeries = series.map((m, i) => `${metricExpr(m)} AS ${qid(keys[i].key)}`).join(", ");

  // Ordering: time axes ascend by x; categorical charts default to the first series desc.
  let orderBy = "ORDER BY x ASC";
  if (w.sort) orderBy = `ORDER BY ${w.sort.by === "y" ? qid(keys[0].key) : "x"} ${w.sort.dir.toUpperCase()}`;
  else if (!w.x.timeGrain) orderBy = `ORDER BY ${qid(keys[0].key)} DESC`;

  const limit = w.limit && w.limit > 0 ? ` LIMIT ${Math.floor(w.limit)}` : (isPie || !w.x.timeGrain ? " LIMIT 50" : "");
  const sql =
    `SELECT ${dimExpr(w.x)} AS x, ${selectSeries} FROM ${qid(w.table)}${whereClause(w.filters, extraWhere)} ` +
    `GROUP BY 1 ${orderBy}${limit}`;
  return { sql, seriesKeys: keys };
}

export function buildTableSql(w: TableWidget, extraWhere?: string[]): { sql: string; cols: { key: string; label: string }[] } {
  const grouped = (w.groupBy?.length ?? 0) > 0;
  const selects: string[] = [];
  const cols: { key: string; label: string }[] = [];

  for (const g of w.groupBy ?? []) {
    const key = (g.label || g.col).toLowerCase().replace(/[^a-z0-9]+/g, "_") || g.col;
    selects.push(`${dimExpr(g)} AS ${qid(key)}`);
    cols.push({ key, label: g.label || g.col });
  }
  w.columns.forEach((c, i) => {
    const key = (c.label || c.col).toLowerCase().replace(/[^a-z0-9]+/g, "_") + `_${i}`;
    const expr = grouped && c.agg ? aggExpr(c.agg, c.col) : qid(c.col);
    selects.push(`${expr} AS ${qid(key)}`);
    cols.push({ key, label: c.label || c.col });
  });

  let sql = `SELECT ${selects.join(", ")} FROM ${qid(w.table)}${whereClause(w.filters, extraWhere)}`;
  if (grouped) sql += ` GROUP BY ${(w.groupBy ?? []).map((_, i) => i + 1).join(", ")}`;
  if (w.sort) {
    const found = cols.find((c) => c.label === w.sort!.by || c.key.startsWith(w.sort!.by.toLowerCase()));
    if (found) sql += ` ORDER BY ${qid(found.key)} ${w.sort.dir.toUpperCase()}`;
  }
  sql += ` LIMIT ${w.limit && w.limit > 0 ? Math.floor(w.limit) : 100}`;
  return { sql, cols };
}