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
const OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "between", "contains", "not_null", "is_null"];
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
  const fkIndex = new Map(profiles.map((d) => [d.tableName, d.profile.foreignKeys ?? []]));
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
  // OPEN-GRAMMAR: normalize the schemas' `values` array into the Filter value
  // shape (agents coerce this already; the raw-pass planner and patch merges may
  // not), and shape-check the pair/scalar ops. Returns null only for structurally
  // unusable conditions (a half `between`, an empty `contains`), never for
  // data-content reasons — content issues annotate and render.
  const normalizeFilter = (f: Filter, where: string): Filter | null => {
    const vals = Array.isArray((f as any).values) ? (f as any).values : undefined;
    let out: Filter = { col: f.col, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) };
    if (f.op === "between") {
      const pair = vals ?? (Array.isArray(f.value) ? f.value : undefined);
      if (!pair || pair.length !== 2) { warn(`${where}: between needs exactly [lo, hi] — condition unusable`); return null; }
      out = { ...out, value: [pair[0], pair[1]] as any };
    } else if ((f.op === "in" || f.op === "not_in") && vals && !Array.isArray(f.value)) {
      out = { ...out, value: vals as any };
    } else if (f.op === "contains") {
      const v = Array.isArray(f.value) ? f.value[0] : f.value ?? (vals ? vals[0] : undefined);
      if (v === undefined || String(v) === "") { warn(`${where}: contains needs a search text — condition unusable`); return null; }
      out = { ...out, value: String(v) };
    }
    return out;
  };

  const checkValues = (table: string, f0: Filter, where: string): Filter | null => {
    const f = normalizeFilter(f0, where);
    if (f === null) return null;
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
        // OPEN-GRAMMAR: the question stays askable — render the honest zero/empty
        // result instead of dropping the widget, and say why it is empty.
        warn(`${where}: "${f.col}" = "${String(f.value)}" matches NO observed value (observed: ${observed.slice(0, 8).join(", ")}) — rendered honestly; expect an empty/zero result`);
        return f;
      }
      warn(`${where}: "${f.col}" = "${String(f.value)}" is not among the top observed values — result may be empty`);
      return f;
    }
    // op === "in"
    const arr = (Array.isArray(f.value) ? f.value : [f.value]).map(fixOne);
    const kept = arr.filter((r) => r.ok).map((r) => r.v);
    const missed = arr.filter((r) => !r.ok).map((r) => r.v);
    if (missed.length && exhaustive) warn(`${where}: IN values [${missed.join(", ")}] match no observed value — kept; they will match no rows`);
    // OPEN-GRAMMAR: keep even provably-missing IN values — the compiled IN
    // simply matches nothing for them, and the warning above names the facts.
    const final = [...kept, ...missed];
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
        // OPEN-GRAMMAR repair: identical sides are structurally constant. With a
        // condition on both sides, the plausible intent was "share of all rows" —
        // keep the conditional numerator over count(*). With no condition anywhere,
        // unwrap to the numerator's plain aggregate. Either way the widget
        // survives and the tautological 100% stays impossible to render.
        if (num.where && num.where.length) {
          warn(`${where}: degenerate ${ex.op} — numerator equals denominator; denominator repaired to count(*) (share of all rows)`);
          const rm: Metric = { ...m, expr: { op: ex.op, num, den: { col: "", agg: "count" } } };
          if (ex.op === "pct" && !rm.format) rm.format = "percent";
          return rm;
        }
        warn(`${where}: degenerate ${ex.op} — numerator equals denominator (always ${ex.op === "pct" ? "100%" : "1"}); unwrapped to the plain ${num.agg} value`);
        return { col: num.col, agg: num.agg, ...(m.label ? { label: m.label } : {}), format: "number" };
      }
      const out: Metric = { ...m, expr: { op: ex.op, num, den } };
      // pct means "this IS a percentage" — make the display format agree.
      if (ex.op === "pct" && !out.format) out.format = "percent";
      if (ex.op === "ratio" && out.format === "percent") out.format = "number";
      return out;
    }
    // A3.1 guard (the "itilticketid over time" incident): summing or
    // averaging an ID-LIKE column is semantically meaningless — sum(ticket_id)
    // rendered a 1M-scale line that survived a retitle to "Average Ticket
    // Age". Id-likeness: the name says id, or distincts approach the row
    // count on an integer column. Honest gap over a garbage number.
    if (NUMERIC_AGGS.includes(m.agg) && m.col) {
      const cp2 = pidx.get(table)?.get(m.col);
      const rows = profiles.find((d) => d.tableName === table)?.profile.rowCount ?? 0;
      const idName = /(^|_)id$/i.test(m.col);
      const idCard = cp2 && rows > 20 && cp2.type === "integer" && cp2.uniqueCount >= rows * 0.9;
      if (cp2 && (idName || idCard)) {
        // OPEN-GRAMMAR repair: the question ("how many X") is answerable — the
        // meaningless sum/avg of ids is not. count_distinct preserves both.
        warn(`${where}: ${m.agg}("${m.col}") aggregates an id-like column — repaired to count_distinct("${m.col}")`);
        return { ...m, agg: "count_distinct", ...(m.format === "percent" ? { format: "number" as const } : {}) };
      }
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

  // A3 — WIDGET JOIN: verified-edge enforcement + column resolution.
  // The edge (base.on[0] -> join.table.on[1]) must exist in the base table's
  // verified foreignKeys (constraint or measured) — a name-plausible but
  // unproven join is dropped with the available relationships named. On
  // success, the widget's column universe becomes base ∪ joined, and
  // join.cols records which referenced columns live ONLY on the joined table
  // so compile can qualify deterministically (base wins ties).
  const fixJoin = <W extends Widget>(w: W): { w: W; cols: ColMap } | null => {
    const base = idx.get(w.table)!;
    const j = (w as any).join;
    if (j === undefined || j === null) return { w, cols: base };
    if (!j.table || !Array.isArray(j.on) || j.on.length !== 2) {
      warn(`${w.kind} "${w.id}": malformed join — dropped`); return null;
    }
    const jcols = idx.get(String(j.table));
    if (!jcols) { warn(`${w.kind} "${w.id}": join table "${j.table}" not found — dropped`); return null; }
    const [lc, rc] = [String(j.on[0]), String(j.on[1])];
    if (!base.has(lc)) { warn(`${w.kind} "${w.id}": join column "${lc}" not in ${w.table} — dropped`); return null; }
    if (!jcols.has(rc)) { warn(`${w.kind} "${w.id}": join column "${rc}" not in ${j.table} — dropped`); return null; }
    const edges = fkIndex.get(w.table) ?? [];
    const verified = edges.some((e) => e.col === lc && e.refTable === String(j.table) && e.refCol === rc);
    if (!verified) {
      const avail = edges.length
        ? `verified relationships from ${w.table}: ${edges.map((e) => `${e.col} -> ${e.refTable}.${e.refCol}`).join(", ")}`
        : `no verified relationships exist from ${w.table}`;
      warn(`${w.kind} "${w.id}": join ${w.table}.${lc} -> ${j.table}.${rc} is not a VERIFIED relationship (${avail}) — dropped`);
      return null;
    }
    // Union column map + record join-only columns for the compiler.
    const union: ColMap = new Map(base);
    const joinOnly: string[] = [];
    for (const [name, type] of jcols) {
      if (!union.has(name)) { union.set(name, type); joinOnly.push(name); }
    }
    const jw = { ...(w as any), join: { table: String(j.table), on: [lc, rc] as [string, string], cols: joinOnly } } as W;
    return { w: jw, cols: union };
  };

  const fixWidget = (w0: Widget): Widget | null => {
    const cols0 = idx.get(w0.table);
    if (!cols0) { warn(`widget "${w0.id}": table "${w0.table}" not found — dropped`); return null; }
    const joined = fixJoin(w0);
    if (!joined) return null;
    const wf = fixWidgetFilters(joined.w, joined.cols);
    if (!wf) return null;
    const w = wf;
    const cols = joined.cols;

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
        // OPEN-GRAMMAR repair: fix the LABEL to match the number instead of
        // dropping the number. The screen never claims a rate it didn't compute.
        const honest = m.label
          ? m.label
          : m.agg === "sum" ? `Total ${m.col}` : m.agg === "count_distinct" ? `Distinct ${m.col}` : `Total records`;
        warn(`kpi "${w.id}" ("${w.title}"): titled as a rate but computes ${m.agg}(${m.col || "*"}) — retitled to "${honest}". Use expr {op:"pct"} with a conditional numerator for a real rate`);
        return { ...w, title: honest, metric: m };
      }
      // A4: compare — valid only against a real temporal column on the KPI's
      // table. Wrong dateCol → repaired from the table's temporal column;
      // none exists → compare stripped WITH a warning (the KPI survives).
      let met = m;
      if (met.compare) {
        // cols here maps column name → TYPE string.
        const isDateType = (ty: unknown) => String(ty ?? "").toLowerCase().includes("date");
        if (!isDateType(cols.get(met.compare.dateCol))) {
          const t = [...cols.entries()].find(([, ty]) => isDateType(ty));
          if (t) {
            warn(`kpi "${w.id}": compare.dateCol "${met.compare.dateCol}" is not a temporal column — repaired to "${t[0]}"`);
            met = { ...met, compare: { ...met.compare, dateCol: t[0] } };
          } else {
            warn(`kpi "${w.id}": compare needs a temporal column and ${w.table} has none — comparison removed (the KPI itself stays)`);
            const { compare: _drop, ...rest } = met; met = rest as Metric;
          }
        }
      }
      return { ...w, metric: met };
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