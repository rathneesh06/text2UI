// bff/dashboard/validate.ts — the pre-render policy layer. It checks a DashboardSpec
// against the real data profile BEFORE anything renders, and repairs what it safely
// can (drop a missing column, coerce a numeric agg on a text column to count, strip a
// timeGrain from a non-temporal axis, keep one series for pie). Whatever can't be
// repaired is dropped with a warning, so a single bad node can never blank the board.
import type { Dataset, ColumnProfile } from "../../shared/types";
import type { DashboardSpec, Section, Widget, Metric, Agg, BaseMetric, Filter } from "../../shared/dashboard-spec";

type ColMap = Map<string, string>; // colName -> profile type (integer|number|boolean|date|string)
const NUMERIC = new Set(["integer", "number"]);
const TEMPORAL = new Set(["date"]);
const NUMERIC_AGGS: Agg[] = ["sum", "avg", "min", "max", "median"];
const OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "not_null", "is_null"];
const VALUE_FORMATS = new Set(["number", "percent", "currency", "hours", "days", "compact"]);

function tableIndex(profiles: Dataset[]): Map<string, ColMap> {
  const idx = new Map<string, ColMap>();
  for (const d of profiles) {
    const m: ColMap = new Map();
    for (const c of d.profile.columns) m.set(c.name, c.type);
    idx.set(d.tableName, m);
  }
  return idx;
}

/** table -> colName -> full ColumnProfile (for observed-value checks). */
function profileIndex(profiles: Dataset[]): Map<string, Map<string, ColumnProfile>> {
  const idx = new Map<string, Map<string, ColumnProfile>>();
  for (const d of profiles) {
    const m = new Map<string, ColumnProfile>();
    for (const c of d.profile.columns) m.set(c.name, c);
    idx.set(d.tableName, m);
  }
  return idx;
}

export interface ValidationResult { spec: DashboardSpec; warnings: string[] }

export function validateSpec(spec: DashboardSpec, profiles: Dataset[]): ValidationResult {
  const idx = tableIndex(profiles);
  const pidx = profileIndex(profiles);
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  // A2.5 — OBSERVED-VALUE CHECK for equality conditions on categorical
  // columns. The 0.0% incident: the model GUESSES a category literal
  // ("met") that doesn't match the data's casing/wording ("Met") — exact
  // string equality then matches zero rows and the rate is structurally 0%,
  // the mirror image of the 100% tautology. The profile knows the observed
  // values (topValues), so: exact match → fine; case/trim-insensitive match
  // to exactly one observed value → REWRITE to the observed literal (warn);
  // no match while topValues are EXHAUSTIVE (uniqueCount ≤ observed count)
  // → the condition is provably empty → signal drop. Non-exhaustive columns
  // only warn, since the value may legitimately live outside the top values.
  const checkValues = (table: string, f: Filter, where: string): Filter | null => {
    if (f.op !== "=" && f.op !== "in") return f;
    const cp = pidx.get(table)?.get(f.col);
    const observed = (cp?.topValues ?? []).map((t) => String(t.value ?? ""));
    if (!cp || cp.type !== "string" || !observed.length) return f;
    // Exhaustiveness is UNFORGEABLE: only a full-pass producer (exact SQL
    // stats or full in-memory data) may set statsExact, and only then may a
    // no-match literal be declared provably empty and dropped. A sample-floor
    // profile (uniqueCount from 5 rows) would otherwise "prove" emptiness it
    // never observed — the A2.8 class one layer deeper. Floors only warn.
    const exhaustive = cp.statsExact === true && cp.uniqueCount <= observed.length;
    const fixOne = (v: unknown): { v: string; ok: boolean } => {
      const s = String(v ?? "");
      if (observed.includes(s)) return { v: s, ok: true };
      const loose = observed.filter((o) => o.trim().toLowerCase() === s.trim().toLowerCase());
      if (loose.length === 1) {
        warn(`${where}: condition value "${s}" rewritten to observed value "${loose[0]}" (case/spacing)`);
        return { v: loose[0], ok: true };
      }
      return { v: s, ok: false };
    };
    if (f.op === "=") {
      const r = fixOne(f.value);
      if (r.ok) return { ...f, value: r.v };
      if (exhaustive) {
        warn(`${where}: "${f.col}" = "${String(f.value)}" matches NO observed value (observed: ${observed.slice(0, 8).join(", ")}) — dropped to avoid a structurally-zero result`);
        return null;
      }
      warn(`${where}: "${f.col}" = "${String(f.value)}" is not among the top observed values — result may be empty`);
      return f;
    }
    // op === "in"
    const arr = (Array.isArray(f.value) ? f.value : [f.value]).map(fixOne);
    const kept = arr.filter((r) => r.ok).map((r) => r.v);
    const missed = arr.filter((r) => !r.ok).map((r) => r.v);
    if (missed.length && exhaustive) warn(`${where}: IN values [${missed.join(", ")}] match no observed value — removed`);
    const final = exhaustive ? kept : [...kept, ...missed];
    if (!final.length) {
      warn(`${where}: IN list has no valid values (observed: ${observed.slice(0, 8).join(", ")}) — dropped`);
      return null;
    }
    return { ...f, value: final as any };
  };

  // Coerce a metric to something the data supports; returns null if unfixable.
  const fixMetric = (cols: ColMap, table: string, m: Metric, where: string): Metric | null => {
    // A2: derived expressions — validate BOTH sides with the same rules; a bad
    // side drops the whole metric (an honest gap beats a silently-wrong ratio).
    if (m.expr) {
      // Self-consistency: compile ignores top-level agg/col on expr metrics —
      // backfill them so every downstream consumer (sanitizer, merge
      // signature, patch merges) sees a well-formed metric.
      if (!m.agg || (!NUMERIC_AGGS.includes(m.agg) && m.agg !== "count" && m.agg !== "count_distinct")) m = { ...m, agg: "count", col: m.col ?? "", expr: m.expr };
      const ops = ["ratio", "pct", "diff"];
      // REPAIR before rejecting: a missing denominator on a ratio/pct almost
      // always means "over all rows" — default it to count(*). (The live
      // "malformed expr" class was the patch model omitting den.) A missing
      // NUMERATOR is unrecoverable — we'd be inventing the metric.
      if (m.expr!.num && !m.expr!.den && (m.expr!.op === "ratio" || m.expr!.op === "pct")) {
        warn(`${where}: expr.den missing — defaulted to count(*)`);
        m = { ...m, expr: { ...m.expr!, den: { col: "", agg: "count" } } };
      }
      if (!ops.includes(m.expr!.op) || !m.expr!.num || !m.expr!.den) {
        warn(`${where}: malformed expr — dropped`); return null;
      }
      const ex = m.expr!;
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
          const checked: Filter[] = [];
          for (const f of b.where) {
            if (!f || !OPS.includes(f.op) || !cols.has(f.col)) {
              warn(`${where}: expr.${name} condition on "${f?.col}" invalid — dropped`); return null;
            }
            const cf = checkValues(table, f, `${where}: expr.${name}`);
            if (cf === null) return null; // provably-empty condition → honest gap over a fake 0%
            checked.push(cf);
          }
          if (checked.length) out.where = checked;
        }
        return out;
      };
      const num = side(ex.num, "num");
      const den = side(ex.den, "den");
      if (!num || !den) return null;
      // DEGENERATE-RATIO GUARD: a ratio/pct whose numerator compiles
      // identically to its denominator is structurally constant (always 1 /
      // 100%) — the "SLA attainment 100.0%" class. A conditional numerator
      // (where) is what makes the sides differ; without one, identical sides
      // mean the model dressed up a tautology as a rate. Drop it.
      if ((ex.op === "ratio" || ex.op === "pct")
        && num.agg === den.agg && num.col === den.col
        && JSON.stringify(num.where ?? []) === JSON.stringify(den.where ?? [])) {
        warn(`${where}: degenerate ${ex.op} — numerator equals denominator (always ${ex.op === "pct" ? "100%" : "1"}). Use a conditional numerator (where) to express a real rate — dropped`);
        return null;
      }
      const out: Metric = { ...m, expr: { op: ex.op, num, den } };
      // pct means "this IS a percentage" — make the display format agree.
      if (ex.op === "pct" && !out.format) out.format = "percent";
      if (ex.op === "ratio" && out.format === "percent") out.format = "number";
      return out;
    }
    // A2 guard: the fake-percent class ("5559.0%") = an additive aggregate
    // dressed up as a percentage. Percent display requires a real ratio (expr)
    // or an average/median of a GENUINELY percent-scaled column — the profile
    // must show the column's observed range fitting 0..100 (the "-26919.5%"
    // incident: avg of an HOURS column formatted as percent).
    if (m.format === "percent" && (m.agg === "sum" || m.agg === "count" || m.agg === "count_distinct")) {
      warn(`${where}: percent format on ${m.agg}() is not a rate — use expr {op:"pct"} for real percentages; showing as number`);
      m = { ...m, format: "number" };
    }
    if (m.format === "percent" && (m.agg === "avg" || m.agg === "median")) {
      const cp = pidx.get(table)?.get(m.col);
      const lo = Number(cp?.min), hi = Number(cp?.max);
      const looksPercent = Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi <= 100;
      if (!looksPercent) {
        warn(`${where}: percent format on ${m.agg}("${m.col}") — the column's observed range (${cp?.min ?? "?"}..${cp?.max ?? "?"}) is not 0..100, so this is not a percentage; showing as number`);
        m = { ...m, format: "number" };
      }
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

  // WIDGET-LEVEL FILTERS — closing a half-pipeline: `widget.filters` was
  // declared in the spec and compiled into SQL, but never validated. The same
  // honesty rules as expr conditions apply: a filter on a nonexistent column
  // or a provably-empty value would show a WRONG subset (or crash the query),
  // so the widget drops with a warning rather than rendering a lie; a
  // case-mismatched literal is rewritten to the observed spelling.
  const fixWidgetFilters = <W extends Widget>(w: W, cols: ColMap): W | null => {
    const wf = (w as any).filters;
    if (wf === undefined || wf === null) return w;
    if (!Array.isArray(wf)) {
      warn(`${w.kind} "${w.id}": filters must be an array — dropped`);
      return null;
    }
    if (!wf.length) { const { filters: _f, ...rest } = w as any; return rest as W; }
    const checked: Filter[] = [];
    for (const f of wf) {
      if (!f || typeof f.col !== "string" || !OPS.includes(f.op)) {
        warn(`${w.kind} "${w.id}": malformed filter — dropped`); return null;
      }
      if (!cols.has(f.col)) {
        warn(`${w.kind} "${w.id}": filter column "${f.col}" not in ${w.table} — dropped`); return null;
      }
      const cf = checkValues(w.table, f, `${w.kind} "${w.id}" filter`);
      if (cf === null) return null; // provably-empty subset → honest gap
      checked.push(cf);
    }
    return { ...(w as any), filters: checked } as W;
  };

  const fixWidget = (w0: Widget): Widget | null => {
    const cols0 = idx.get(w0.table);
    if (!cols0) { warn(`widget "${w0.id}": table "${w0.table}" not found — dropped`); return null; }
    const wf = fixWidgetFilters(w0, cols0);
    if (!wf) return null;
    const w = wf;
    const cols = cols0;

    if (w.kind === "kpi") {
      if (!w.metric) { warn(`kpi "${w.id}": no metric — dropped`); return null; }
      const m = fixMetric(cols, w.table, w.metric, `kpi "${w.id}"`);
      if (!m) return null;
      // TITLE HONESTY (the "SLA BREACH RATE: 7,888" incident): a KPI titled as
      // a rate/percentage/share whose metric is a plain additive aggregate is a
      // mislabeled count — the number on screen would not be what the title
      // claims. Percent-formatted averages pass (they ARE rates); everything
      // else needs a real expr ratio or a different title. Drop, don't lie.
      const RATEISH = /\b(rate|percentage|percent|share|ratio|attainment|compliance)\b|%/i;
      const additive = m.agg === "count" || m.agg === "count_distinct" || m.agg === "sum";
      if (!m.expr && additive && RATEISH.test(String(w.title ?? ""))) {
        warn(`kpi "${w.id}" ("${w.title}"): titled as a rate but computes ${m.agg}(${m.col || "*"}) — a plain ${m.agg === "sum" ? "sum" : "count"}, not a rate. Use expr {op:"pct"|"ratio"} with a conditional numerator, or retitle — dropped`);
        return null;
      }
      return { ...w, metric: m };
    }

    if (w.kind === "table") {
      if (!Array.isArray(w.columns) || !w.columns.length) { warn(`table "${w.id}": no columns — dropped`); return null; }
      const columns = w.columns
        .filter((c) => c.col && (c.agg === "count" || cols.has(c.col)))
        .map((c) => (c.format && !VALUE_FORMATS.has(c.format) ? { ...c, format: undefined } : c))
        .slice(0, 30); // D5b: same cap the query sanitizer enforces
      if (columns.length !== w.columns.length && w.columns.length <= 30) warn(`table "${w.id}": dropped column(s) not in ${w.table}`);
      const groupBy = (w.groupBy ?? []).filter((g) => cols.has(g.col)).slice(0, 5);
      if (!columns.length) { warn(`table "${w.id}": no valid columns — dropped`); return null; }
      const limit = Number.isInteger((w as any).limit) && (w as any).limit > 0 ? Math.min((w as any).limit, 10000) : (w as any).limit;
      return { ...w, columns, groupBy, ...(limit !== undefined ? { limit } : {}) };
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