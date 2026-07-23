// bff/dashboard/sql.ts — the deterministic SQL compiler. Turns a typed widget into
// DuckDB SQL. This is the ONE place SQL is written, so an entire class of bugs (the
// `to_char` dialect mismatch, hallucinated columns, malformed aggregates) is removed
// by construction: the model picks columns/aggregations as data; the SQL grammar is
// fixed and always valid DuckDB.
import type {
  Agg, Dimension, Filter, KpiWidget, ChartWidget, TableWidget, Metric, TimeGrain, ValueFormat, WidgetJoin } from "../../shared/dashboard-spec";

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
// A3 — column qualification for joined widgets. The builders are fully
// synchronous, so a scoped set/reset qualifier is safe: inside withJoin(),
// columns recorded by validation as join-only resolve to the join alias and
// everything else to the base alias; outside, plain quoting.
let COLQ: (col: string) => string = qid;
const qcol = (col: string) => COLQ(col);
function withJoin<T>(w: { join?: WidgetJoin }, fn: () => T): T {
  if (!w.join) return fn();
  const joinOnly = new Set(w.join.cols ?? []);
  COLQ = (c) => (joinOnly.has(c) ? `j.${qid(c)}` : `b.${qid(c)}`);
  try { return fn(); } finally { COLQ = qid; }
}
/** FROM clause: plain table, or base LEFT JOIN ref on the verified edge. */
export function fromClause(w: { table: string; join?: WidgetJoin }): string {
  if (!w.join) return qid(w.table);
  return `${qid(w.table)} b LEFT JOIN ${qid(w.join.table)} j ON b.${qid(w.join.on[0])} = j.${qid(w.join.on[1])}`;
}

export function aggExpr(agg: Agg, col: string): string {
  switch (agg) {
    case "count": return "count(*)";
    case "count_distinct": return `count(DISTINCT ${qcol(col)})`;
    case "median": return `median(${qcol(col)})`;
    case "sum": case "avg": case "min": case "max": return `${agg}(${qcol(col)})`;
    default: return "count(*)";
  }
}

/** A2: the full metric expression — plain aggregate OR the closed derived AST.
 *  Ratios always divide through nullif(den, 0): a zero denominator yields NULL
 *  ("—" in the renderer), and the fake-percent class (sum(col) dressed up as a
 *  percentage) is impossible to express — pct/ratio REQUIRE a real division.
 *  Sides with `where` compile to `agg(...) FILTER (WHERE ...)` using the SAME
 *  oneFilter grammar (qid/lit escaping) as widget filters. */
function sideExpr(b: { col: string; agg: Agg; where?: Filter[] }): string {
  const base = aggExpr(b.agg, b.col);
  if (!b.where || !b.where.length) return base;
  return `${base} FILTER (WHERE ${b.where.map(oneFilter).join(" AND ")})`;
}

export function metricExpr(m: Metric): string {
  if (m.expr) {
    const n = sideExpr(m.expr.num);
    const d = sideExpr(m.expr.den);
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
  if (d.timeGrain && GRAINS[d.timeGrain]) return `date_trunc('${GRAINS[d.timeGrain]}', ${qcol(d.col)})`;
  return qcol(d.col);
}

/** ILIKE pattern literal for `contains`: the VALUE's own %/_/\ are escaped so
 *  user text can never smuggle wildcards; the surrounding %…% are ours. */
function likeLit(v: unknown): string {
  const escaped = String(v ?? "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return lit(`%${escaped}%`);
}

function oneFilter(f: Filter): string {
  const c = qcol(f.col);
  switch (f.op) {
    case "is_null": return `${c} IS NULL`;
    case "not_null": return `${c} IS NOT NULL`;
    case "contains": return `CAST(${c} AS VARCHAR) ILIKE ${likeLit(f.value)} ESCAPE '\\'`;
    case "between": {
      const arr = Array.isArray(f.value) ? f.value : [];
      if (arr.length !== 2) return "1=1"; // validation enforces the pair; never compile a half-range
      return `${c} BETWEEN ${lit(arr[0])} AND ${lit(arr[1])}`;
    }
    case "in": case "not_in": {
      const arr = Array.isArray(f.value) ? f.value : [f.value as any];
      if (!arr.length) return "1=1";
      const neg = f.op === "not_in" ? " NOT" : "";
      return `${c}${neg} IN (${arr.map(lit).join(", ")})`;
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
  return withJoin(w, () => `SELECT ${metricExpr(w.metric)} AS value FROM ${fromClause(w)}${whereClause(w.filters, extraWhere)}`);
}

export function buildChartSql(w: ChartWidget, extraWhere?: string[]): { sql: string; seriesKeys: { key: string; label: string }[] } {
  const isPie = w.kind === "pie" || w.kind === "donut";
  const series = isPie ? w.series.slice(0, 1) : w.series;
  const keys = series.map((m, i) => ({ key: seriesKey(m, i), label: m.label || `${m.agg}(${m.col})` }));

  // Ordering: time axes ascend by x; categorical charts default to the first series desc.
  let orderBy = "ORDER BY x ASC";
  if (w.sort) orderBy = `ORDER BY ${w.sort.by === "y" ? qid(keys[0].key) : "x"} ${w.sort.dir.toUpperCase()}`;
  else if (!w.x.timeGrain) orderBy = `ORDER BY ${qid(keys[0].key)} DESC`;

  const limit = w.limit && w.limit > 0 ? ` LIMIT ${Math.floor(w.limit)}` : (isPie || !w.x.timeGrain ? " LIMIT 50" : "");
  const sql = withJoin(w, () =>
    `SELECT ${dimExpr(w.x)} AS x, ${series.map((m, i) => `${metricExpr(m)} AS ${qid(keys[i].key)}`).join(", ")} FROM ${fromClause(w)}${whereClause(w.filters, extraWhere)} ` +
    `GROUP BY 1 ${orderBy}${limit}`);
  return { sql, seriesKeys: keys };
}

export function buildTableSql(w: TableWidget, extraWhere?: string[]): { sql: string; cols: { key: string; label: string; format?: ValueFormat }[] } {
  return withJoin(w, () => buildTableSqlInner(w, extraWhere));
}
function buildTableSqlInner(w: TableWidget, extraWhere?: string[]): { sql: string; cols: { key: string; label: string; format?: ValueFormat }[] } {
  const grouped = (w.groupBy?.length ?? 0) > 0;
  const selects: string[] = [];
  const cols: { key: string; label: string; format?: ValueFormat }[] = [];

  for (const g of w.groupBy ?? []) {
    const key = (g.label || g.col).toLowerCase().replace(/[^a-z0-9]+/g, "_") || g.col;
    selects.push(`${dimExpr(g)} AS ${qid(key)}`);
    cols.push({ key, label: g.label || g.col });
  }
  w.columns.forEach((c, i) => {
    const key = (c.label || c.col).toLowerCase().replace(/[^a-z0-9]+/g, "_") + `_${i}`;
    const expr = grouped && c.agg ? aggExpr(c.agg, c.col) : qcol(c.col);
    selects.push(`${expr} AS ${qid(key)}`);
    cols.push({ key, label: c.label || c.col, ...(c.format ? { format: c.format } : {}) });
  });

  let sql = `SELECT ${selects.join(", ")} FROM ${fromClause(w)}${whereClause(w.filters, extraWhere)}`;
  if (grouped) sql += ` GROUP BY ${(w.groupBy ?? []).map((_, i) => i + 1).join(", ")}`;
  if (w.sort) {
    const found = cols.find((c) => c.label === w.sort!.by || c.key.startsWith(w.sort!.by.toLowerCase()));
    if (found) sql += ` ORDER BY ${qid(found.key)} ${w.sort.dir.toUpperCase()}`;
  }
  sql += ` LIMIT ${w.limit && w.limit > 0 ? Math.floor(w.limit) : 100}`;
  return { sql, cols };
}