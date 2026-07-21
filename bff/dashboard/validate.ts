// bff/dashboard/validate.ts — the pre-render policy layer. It checks a DashboardSpec
// against the real data profile BEFORE anything renders, and repairs what it safely
// can (drop a missing column, coerce a numeric agg on a text column to count, strip a
// timeGrain from a non-temporal axis, keep one series for pie). Whatever can't be
// repaired is dropped with a warning, so a single bad node can never blank the board.
import type { Dataset } from "../../shared/types";
import type { DashboardSpec, Section, Widget, Metric, Agg, BaseMetric } from "../../shared/dashboard-spec";

type ColMap = Map<string, string>; // colName -> profile type (integer|number|boolean|date|string)
const NUMERIC = new Set(["integer", "number"]);
const TEMPORAL = new Set(["date"]);
const NUMERIC_AGGS: Agg[] = ["sum", "avg", "min", "max", "median"];

function tableIndex(profiles: Dataset[]): Map<string, ColMap> {
  const idx = new Map<string, ColMap>();
  for (const d of profiles) {
    const m: ColMap = new Map();
    for (const c of d.profile.columns) m.set(c.name, c.type);
    idx.set(d.tableName, m);
  }
  return idx;
}

export interface ValidationResult { spec: DashboardSpec; warnings: string[] }

export function validateSpec(spec: DashboardSpec, profiles: Dataset[]): ValidationResult {
  const idx = tableIndex(profiles);
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  // Coerce a metric to something the data supports; returns null if unfixable.
  const fixMetric = (cols: ColMap, table: string, m: Metric, where: string): Metric | null => {
    // A2: derived expressions — validate BOTH sides with the same rules; a bad
    // side drops the whole metric (an honest gap beats a silently-wrong ratio).
    if (m.expr) {
      const ops = ["ratio", "pct", "diff"];
      if (!ops.includes(m.expr.op) || !m.expr.num || !m.expr.den) {
        warn(`${where}: malformed expr — dropped`); return null;
      }
      const OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "not_null", "is_null"];
      const side = (b: BaseMetric, name: string): BaseMetric | null => {
        let out: BaseMetric;
        if (b.agg === "count") out = { col: b.col ?? "", agg: "count" };
        else if (!NUMERIC_AGGS.includes(b.agg) && b.agg !== "count_distinct") { warn(`${where}: expr.${name} agg "${b.agg}" invalid — dropped`); return null; }
        else if (!cols.has(b.col)) { warn(`${where}: expr.${name} column "${b.col}" not in ${table} — dropped`); return null; }
        else if (NUMERIC_AGGS.includes(b.agg) && !NUMERIC.has(cols.get(b.col)!)) {
          warn(`${where}: expr.${name} ${b.agg}("${b.col}") needs a numeric column — using count`);
          out = { col: b.col, agg: "count" };
        } else out = { col: b.col, agg: b.agg };
        // Conditional side: every where-filter must reference a real column
        // with a known op; a bad condition drops the metric (an honest gap
        // beats a rate over the wrong rows).
        if (b.where !== undefined && b.where !== null) {
          if (!Array.isArray(b.where)) { warn(`${where}: expr.${name}.where must be an array — dropped`); return null; }
          for (const f of b.where) {
            if (!f || !OPS.includes(f.op) || !cols.has(f.col)) {
              warn(`${where}: expr.${name} condition on "${f?.col}" invalid — dropped`); return null;
            }
          }
          if (b.where.length) out.where = b.where;
        }
        return out;
      };
      const num = side(m.expr.num, "num");
      const den = side(m.expr.den, "den");
      if (!num || !den) return null;
      // DEGENERATE-RATIO GUARD: a ratio/pct whose numerator compiles
      // identically to its denominator is structurally constant (always 1 /
      // 100%) — the "SLA attainment 100.0%" class. A conditional numerator
      // (where) is what makes the sides differ; without one, identical sides
      // mean the model dressed up a tautology as a rate. Drop it.
      if ((m.expr.op === "ratio" || m.expr.op === "pct")
        && num.agg === den.agg && num.col === den.col
        && JSON.stringify(num.where ?? []) === JSON.stringify(den.where ?? [])) {
        warn(`${where}: degenerate ${m.expr.op} — numerator equals denominator (always ${m.expr.op === "pct" ? "100%" : "1"}). Use a conditional numerator (where) to express a real rate — dropped`);
        return null;
      }
      const out: Metric = { ...m, expr: { op: m.expr.op, num, den } };
      // pct means "this IS a percentage" — make the display format agree.
      if (m.expr.op === "pct" && !out.format) out.format = "percent";
      if (m.expr.op === "ratio" && out.format === "percent") out.format = "number";
      return out;
    }
    // A2 guard: the fake-percent class ("5559.0%") = an additive aggregate
    // dressed up as a percentage. Percent display requires a real ratio (expr)
    // or an average/median of an already-percent column — never sum/count.
    if (m.format === "percent" && (m.agg === "sum" || m.agg === "count" || m.agg === "count_distinct")) {
      warn(`${where}: percent format on ${m.agg}() is not a rate — use expr {op:"pct"} for real percentages; showing as number`);
      m = { ...m, format: "number" };
    }
    if (m.agg === "count") return m; // count(*) needs no column
    if (!cols.has(m.col)) { warn(`${where}: column "${m.col}" not in ${table} — dropped`); return null; }
    const t = cols.get(m.col)!;
    if (NUMERIC_AGGS.includes(m.agg) && !NUMERIC.has(t)) {
      warn(`${where}: ${m.agg}("${m.col}") needs a numeric column (it is ${t}) — using count instead`);
      return { ...m, agg: "count" };
    }
    return m;
  };

  const fixWidget = (w: Widget): Widget | null => {
    const cols = idx.get(w.table);
    if (!cols) { warn(`widget "${w.id}": table "${w.table}" not found — dropped`); return null; }

    if (w.kind === "kpi") {
      if (!w.metric) { warn(`kpi "${w.id}": no metric — dropped`); return null; }
      const m = fixMetric(cols, w.table, w.metric, `kpi "${w.id}"`);
      return m ? { ...w, metric: m } : null;
    }

    if (w.kind === "table") {
      if (!Array.isArray(w.columns) || !w.columns.length) { warn(`table "${w.id}": no columns — dropped`); return null; }
      const columns = w.columns.filter((c) => c.col && (c.agg === "count" || cols.has(c.col)));
      if (columns.length !== w.columns.length) warn(`table "${w.id}": dropped column(s) not in ${w.table}`);
      const groupBy = (w.groupBy ?? []).filter((g) => cols.has(g.col));
      if (!columns.length) { warn(`table "${w.id}": no valid columns — dropped`); return null; }
      return { ...w, columns, groupBy };
    }

    // chart kinds: line|bar|area|pie|donut
    if (!w.x || !w.x.col) { warn(`chart "${w.id}": no x dimension — dropped`); return null; }
    if (!cols.has(w.x.col)) { warn(`chart "${w.id}": x column "${w.x.col}" not in ${w.table} — dropped`); return null; }
    let x = w.x;
    if (x.timeGrain && !TEMPORAL.has(cols.get(x.col)!)) {
      warn(`chart "${w.id}": timeGrain on non-temporal "${x.col}" — removed`);
      x = { ...x, timeGrain: undefined };
    }
    if (!Array.isArray(w.series) || !w.series.length) { warn(`chart "${w.id}": no series — dropped`); return null; }
    let series = w.series
      .map((m) => fixMetric(cols, w.table, m, `chart "${w.id}"`))
      .filter((m): m is Metric => !!m);
    if (!series.length) { warn(`chart "${w.id}": no valid series — dropped`); return null; }
    if ((w.kind === "pie" || w.kind === "donut") && series.length > 1) {
      warn(`chart "${w.id}": pie/donut shows one measure — kept the first`);
      series = series.slice(0, 1);
    }
    return { ...w, x, series };
  };

  const sections: Section[] = [];
  for (const s of spec.sections) {
    const widgets = s.widgets.map(fixWidget).filter((w): w is Widget => !!w);
    if (widgets.length) sections.push({ ...s, widgets });
    else warn(`section "${s.id}": empty after validation — dropped`);
  }

  return { spec: { ...spec, sections }, warnings };
}