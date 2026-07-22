// bff/dashboard/filters.ts — Phase A1: global dashboard filters.
//
// Three responsibilities, all deterministic:
//   1. deriveGlobalFilters — build the filter bar from the data profile
//      (temporal min/max → one date range; low-cardinality categoricals →
//      selects with options from topValues). No model involved.
//   2. filterConditions — turn client-sent AppliedFilter VALUES into SQL
//      conditions with strict validation + the same qid/lit escaping the rest
//      of the compiler uses. The client never sends SQL; it sends values, and
//      this is the ONE place they become WHERE fragments.
//   3. sanitizeWidget + buildWidgetSql — the runtime re-compile path for
//      /api/dashboard/query: rebuild a Widget from untrusted JSON by
//      whitelist (never pass the client object through), then compile SQL via
//      the existing deterministic builders. Anything outside the closed AST
//      throws → 400.
import type { Dataset, ColumnProfile } from "../../shared/types";
import type {
  AppliedFilter, CompiledGlobalFilter, DashboardSpec, Widget, Filter, FilterOp,
  KpiWidget, ChartWidget, TableWidget, Metric, Dimension, TableColumn,
  Agg, TimeGrain, ValueFormat, GlobalFilterKind,
} from "../../shared/dashboard-spec";
import { qid, buildKpiSql, buildChartSql, buildTableSql } from "./sql";

// ---- limits (bound query size; injection is handled by escaping, these guard cost)
const MAX_OPTIONS = 25;          // choices surfaced per select filter
const MAX_SELECT_FILTERS = 2;    // categorical filters in the bar
const MAX_VALUE_LEN = 500;       // one literal
const MAX_MULTI_VALUES = 50;     // IN-list size
const MAX_APPLIED = 10;          // filters per query
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ============================================================================
// 1. Derivation — profile → filter bar
// ============================================================================

function isoDay(v: unknown): string | undefined {
  const s = String(v ?? "");
  const d = s.slice(0, 10);
  return ISO_DATE.test(d) ? d : undefined;
}

function labelize(col: string): string {
  return col.split(/[_\s]+/).filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ") || col;
}

/** Tables whose profile has a column `col` of one of `types`. */
function tablesWithCol(profiles: Dataset[], col: string, types: Set<string>): string[] {
  const out: string[] = [];
  for (const d of profiles) {
    const c = d.profile.columns.find((x) => x.name === col);
    if (c && types.has(c.type)) out.push(d.tableName);
  }
  return out;
}

/** Derive the filter bar from the profile. Deterministic; safe on any data:
 *  no temporal column → no date range; no low-cardinality categorical → no
 *  selects; both absent → empty bar (renderer hides it). */
export function deriveGlobalFilters(profiles: Dataset[]): CompiledGlobalFilter[] {
  const filters: CompiledGlobalFilter[] = [];
  if (!profiles.length) return filters;

  // Date range: applies to EVERY table that has a temporal column, each on its
  // own best date column (highest cardinality ≈ the event timestamp). Tables
  // do NOT need to share a column name — without this, only widgets on the
  // anchor table would filter (the "only KPIs change" symptom). The anchor
  // (label + col) comes from the largest table; bounds are the union.
  const byRows = [...profiles].sort((a, b) => b.profile.rowCount - a.profile.rowCount);
  const dateColByTable: Record<string, ColumnProfile> = {};
  for (const d of byRows) {
    const dates = d.profile.columns.filter((c) => c.type === "date");
    if (!dates.length) continue;
    dateColByTable[d.tableName] = [...dates].sort((a, b) => b.uniqueCount - a.uniqueCount)[0];
  }
  const dateTables = Object.keys(dateColByTable);
  if (dateTables.length) {
    const anchorTable = byRows.find((d) => dateColByTable[d.tableName])!.tableName;
    const anchor = dateColByTable[anchorTable];
    let min: string | undefined, max: string | undefined;
    const cols: Record<string, string> = {};
    for (const t of dateTables) {
      cols[t] = dateColByTable[t].name;
      const lo = isoDay(dateColByTable[t].min), hi = isoDay(dateColByTable[t].max);
      if (lo && (!min || lo < min)) min = lo;
      if (hi && (!max || hi > max)) max = hi;
    }
    filters.push({
      id: `gf_date_${anchor.name}`,
      col: anchor.name,
      kind: "daterange",
      label: labelize(anchor.name),
      table: anchorTable,
      tables: dateTables,
      cols,
      ...(min ? { min } : {}), ...(max ? { max } : {}),
    });
  }

  // Selects: string columns with usable topValues, 2..MAX_OPTIONS distinct,
  // not id-like (distincts must not approach the row count). Ranked by how
  // much of the table the topValues cover (a real status/category column
  // covers ~everything; a free-text column doesn't).
  type Cand = { col: ColumnProfile; table: string; rowCount: number; coverage: number };
  const seen = new Set<string>(Object.values(dateColByTable).map((c) => c.name));
  const cands: Cand[] = [];
  for (const d of byRows) {
    for (const c of d.profile.columns) {
      if (c.type !== "string" || seen.has(c.name)) continue;
      if (!Array.isArray(c.topValues) || !c.topValues.length) continue;
      if (c.uniqueCount < 2 || c.uniqueCount > MAX_OPTIONS) continue;
      if (d.profile.rowCount > 0 && c.uniqueCount > d.profile.rowCount * 0.5) continue; // id-like
      const covered = c.topValues.reduce((n, t) => n + (typeof t.count === "number" ? t.count : 0), 0);
      const coverage = d.profile.rowCount > 0 ? covered / d.profile.rowCount : 0;
      cands.push({ col: c, table: d.tableName, rowCount: d.profile.rowCount, coverage });
      seen.add(c.name); // one filter per column name across tables
    }
  }
  cands.sort((a, b) => b.coverage - a.coverage || b.rowCount - a.rowCount || a.col.name.localeCompare(b.col.name));
  for (const cand of cands.slice(0, MAX_SELECT_FILTERS)) {
    const options = (cand.col.topValues ?? [])
      .map((t) => String(t.value ?? ""))
      .filter((v) => v.length > 0 && v.length <= MAX_VALUE_LEN)
      .slice(0, MAX_OPTIONS);
    if (options.length < 2) continue;
    filters.push({
      id: `gf_sel_${cand.col.name}`,
      col: cand.col.name,
      kind: "select",
      label: labelize(cand.col.name),
      table: cand.table,
      tables: tablesWithCol(profiles, cand.col.name, new Set(["string"])),
      options,
    });
  }
  return filters;
}

/** Resolve the filter bar for a compiled spec: honor spec.filters when the
 *  spec carries them (an edit may later add/remove filters), else derive.
 *  Either way, re-resolve options/bounds/applicability from the CURRENT
 *  profile, prune filters whose column no longer exists or that touch none of
 *  the rendered widgets' tables. */
export function resolveGlobalFilters(spec: DashboardSpec, profiles: Dataset[]): CompiledGlobalFilter[] {
  const derived = deriveGlobalFilters(profiles);
  let resolved: CompiledGlobalFilter[];
  if (Array.isArray(spec.filters)) {
    // Explicit list (possibly empty — user removed them). Enrich each from the
    // derived set when possible; otherwise re-resolve applicability directly.
    resolved = [];
    for (const f of spec.filters) {
      const hit = derived.find((d) => d.col === f.col && d.kind === f.kind);
      if (hit) { resolved.push({ ...hit, id: f.id || hit.id, label: f.label || hit.label }); continue; }
      const types = f.kind === "daterange" ? new Set(["date"]) : new Set(["string"]);
      if (f.kind === "daterange") {
        // Re-anchor on the derived daterange if one exists (it carries the
        // per-table cols map); else rebuild a minimal map for this column.
        const der = derived.find((d) => d.kind === "daterange");
        if (der) { resolved.push({ ...der, id: f.id || der.id, label: f.label || der.label }); continue; }
        const tables = tablesWithCol(profiles, f.col, types);
        if (!tables.length) continue;
        const cols: Record<string, string> = {};
        for (const t of tables) cols[t] = f.col;
        resolved.push({ ...f, tables, cols });
      } else {
        const tables = tablesWithCol(profiles, f.col, types);
        if (!tables.length) continue; // column gone from the data — prune
        // options from the first table's topValues
        const prof = profiles.find((d) => tables.includes(d.tableName));
        const cp = prof?.profile.columns.find((c) => c.name === f.col);
        const options = (cp?.topValues ?? []).map((t) => String(t.value ?? ""))
          .filter((v) => v.length > 0 && v.length <= MAX_VALUE_LEN).slice(0, MAX_OPTIONS);
        if (options.length >= 2) resolved.push({ ...f, tables, options });
      }
    }
  } else {
    resolved = derived;
  }
  // Prune filters that apply to none of the widgets actually on the board.
  const widgetTables = new Set<string>();
  for (const s of spec.sections) for (const w of s.widgets) widgetTables.add(w.table);
  return resolved
    .map((f) => {
      const tables = f.tables.filter((t) => widgetTables.has(t));
      if (!f.cols) return { ...f, tables };
      const cols: Record<string, string> = {};
      for (const t of tables) if (f.cols[t]) cols[t] = f.cols[t];
      return { ...f, tables, cols };
    })
    .filter((f) => f.tables.length > 0);
}

// ============================================================================
// 2. Applied values → SQL conditions (server-rebuilt WHERE)
// ============================================================================

/** Escape a string literal exactly like sql.ts lit() does. */
function esc(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function badValue(msg: string): never {
  const e: any = new Error(msg);
  e.status = 400;
  throw e;
}

function checkString(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.length) badValue(`${what} must be a non-empty string`);
  if ((v as string).length > MAX_VALUE_LEN) badValue(`${what} exceeds ${MAX_VALUE_LEN} chars`);
  return v as string;
}

/** Validate client-sent filter values and compile them to SQL conditions.
 *  THROWS (status 400) on anything malformed — a filter request is a security
 *  surface, so strictness beats silent repair here. Column names are quoted
 *  (qid) and values escaped (esc); a wrong column simply fails the query. */
export function filterConditions(applied: unknown): string[] {
  if (applied === undefined || applied === null) return [];
  if (!Array.isArray(applied)) badValue("filters must be an array");
  if (applied.length > MAX_APPLIED) badValue(`too many filters (max ${MAX_APPLIED})`);
  const out: string[] = [];
  for (const raw of applied as any[]) {
    if (!raw || typeof raw !== "object") badValue("each filter must be an object");
    const col = checkString(raw.col, "filter.col");
    if (col.length > 200) badValue("filter.col too long");
    const kind = raw.kind as GlobalFilterKind;
    const c = qid(col);
    if (kind === "daterange") {
      const v = raw.value;
      if (!v || typeof v !== "object" || Array.isArray(v)) badValue("daterange value must be { from?, to? }");
      const from = v.from === undefined || v.from === "" ? undefined : checkString(v.from, "daterange.from");
      const to = v.to === undefined || v.to === "" ? undefined : checkString(v.to, "daterange.to");
      if (from === undefined && to === undefined) continue; // nothing set — no constraint
      if (from !== undefined) {
        if (!ISO_DATE.test(from)) badValue("daterange.from must be YYYY-MM-DD");
        out.push(`${c} >= DATE ${esc(from)}`);
      }
      if (to !== undefined) {
        if (!ISO_DATE.test(to)) badValue("daterange.to must be YYYY-MM-DD");
        // inclusive of the end DAY even for timestamp columns
        out.push(`${c} < (DATE ${esc(to)} + INTERVAL 1 DAY)`);
      }
    } else if (kind === "select") {
      out.push(`${c} = ${esc(checkString(raw.value, "select value"))}`);
    } else if (kind === "multiselect") {
      const arr = raw.value;
      if (!Array.isArray(arr)) badValue("multiselect value must be an array");
      if (!arr.length) continue; // nothing chosen — no constraint
      if (arr.length > MAX_MULTI_VALUES) badValue(`multiselect exceeds ${MAX_MULTI_VALUES} values`);
      out.push(`${c} IN (${arr.map((x: unknown) => esc(checkString(x, "multiselect value"))).join(", ")})`);
    } else {
      badValue(`unknown filter kind "${String(raw.kind)}"`);
    }
  }
  return out;
}

// ============================================================================
// 3. Untrusted widget JSON → Widget → SQL (the /api/dashboard/query path)
// ============================================================================

const KINDS = new Set(["kpi", "line", "bar", "area", "pie", "donut", "table"]);
const AGGS = new Set<Agg>(["count", "count_distinct", "sum", "avg", "min", "max", "median"]);
const GRAINS = new Set<TimeGrain>(["day", "week", "month", "quarter", "year"]);
const FORMATS = new Set<ValueFormat>(["number", "compact", "percent", "currency", "hours", "days"]);
const OPS = new Set<FilterOp>(["=", "!=", ">", ">=", "<", "<=", "in", "not_null", "is_null"]);

function str(v: unknown, what: string, max = 200): string {
  if (typeof v !== "string" || !v.length) badValue(`${what} must be a non-empty string`);
  if ((v as string).length > max) badValue(`${what} too long`);
  return v as string;
}
function optStr(v: unknown, what: string, max = 200): string | undefined {
  return v === undefined || v === null ? undefined : str(v, what, max);
}
function scalar(v: unknown, what: string): string | number | boolean {
  if (typeof v === "number") { if (!Number.isFinite(v)) badValue(`${what} must be finite`); return v; }
  if (typeof v === "boolean") return v;
  return str(v, what, MAX_VALUE_LEN);
}

const EXPR_OPS = new Set(["ratio", "pct", "diff"]);

function sanMetric(m: any, what: string): Metric {
  if (!m || typeof m !== "object") badValue(`${what} must be an object`);
  // D5a: when a valid expr is present, compile IGNORES top-level agg/col
  // (metricExpr computes num/den only) — so the sanitizer must not demand
  // them. Requiring agg here 400-ed every rate/ratio KPI the moment a global
  // filter was applied, even though the same widget rendered fine on build.
  const hasExpr = m.expr !== undefined && m.expr !== null;
  const agg = (hasExpr && !AGGS.has(m.agg) ? "count" : m.agg) as Agg;
  if (!AGGS.has(agg)) badValue(`${what}.agg invalid`);
  const col = agg === "count" || hasExpr ? String(m.col ?? "") : str(m.col, `${what}.col`);
  const out: Metric = { col, agg };
  const label = optStr(m.label, `${what}.label`); if (label) out.label = label;
  if (m.format !== undefined) { if (!FORMATS.has(m.format)) badValue(`${what}.format invalid`); out.format = m.format; }
  // A2: derived expression — a closed AST; both sides re-validated, op whitelisted.
  if (m.expr !== undefined && m.expr !== null) {
    const e = m.expr;
    if (!e || typeof e !== "object" || !EXPR_OPS.has(e.op)) badValue(`${what}.expr.op invalid`);
    const side = (b: any, name: string) => {
      if (!b || typeof b !== "object" || !AGGS.has(b.agg)) badValue(`${what}.expr.${name} invalid`);
      const c = b.agg === "count" ? String(b.col ?? "") : str(b.col, `${what}.expr.${name}.col`);
      const out: { col: string; agg: Agg; where?: Filter[] } = { col: c, agg: b.agg as Agg };
      const w = sanFilters(b.where);
      if (w && w.length) out.where = w;
      return out;
    };
    out.expr = { op: e.op, num: side(e.num, "num"), den: side(e.den, "den") };
  }
  return out;
}
function sanDim(d: any, what: string): Dimension {
  if (!d || typeof d !== "object") badValue(`${what} must be an object`);
  const out: Dimension = { col: str(d.col, `${what}.col`) };
  if (d.timeGrain !== undefined) { if (!GRAINS.has(d.timeGrain)) badValue(`${what}.timeGrain invalid`); out.timeGrain = d.timeGrain; }
  const label = optStr(d.label, `${what}.label`); if (label) out.label = label;
  return out;
}
function sanFilters(f: any): Filter[] | undefined {
  if (f === undefined || f === null) return undefined;
  if (!Array.isArray(f)) badValue("widget.filters must be an array");
  if (f.length > 20) badValue("too many widget filters");
  return f.map((x: any, i: number) => {
    if (!x || typeof x !== "object") badValue(`filters[${i}] must be an object`);
    const op = x.op as FilterOp;
    if (!OPS.has(op)) badValue(`filters[${i}].op invalid`);
    const out: Filter = { col: str(x.col, `filters[${i}].col`), op };
    if (op === "in") {
      const arr = Array.isArray(x.value) ? x.value : [x.value];
      if (arr.length > MAX_MULTI_VALUES) badValue(`filters[${i}] IN list too long`);
      out.value = arr.map((v: unknown, j: number) => scalar(v, `filters[${i}].value[${j}]`)) as any;
    } else if (op !== "is_null" && op !== "not_null") {
      out.value = scalar(x.value, `filters[${i}].value`);
    }
    return out;
  });
}
function sanLimit(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 10_000) badValue("limit must be 1..10000");
  return Math.floor(n);
}
function sanDir(v: unknown): "asc" | "desc" {
  if (v !== "asc" && v !== "desc") badValue("sort.dir must be asc|desc");
  return v;
}

/** Rebuild a Widget from untrusted JSON by whitelist. Every field is copied
 *  through a validator; unknown fields are DROPPED (never spread). Throws
 *  (status 400) on anything outside the closed AST. */
export function sanitizeWidget(raw: unknown): Widget {
  const w = raw as any;
  if (!w || typeof w !== "object") badValue("widget must be an object");
  if (!KINDS.has(w.kind)) badValue(`widget.kind invalid`);
  const base = {
    id: str(w.id, "widget.id", 100),
    title: optStr(w.title, "widget.title", 300) ?? "",
    table: str(w.table, "widget.table"),
    filters: sanFilters(w.filters),
  };
  if (w.kind === "kpi") {
    const out: KpiWidget = { ...base, kind: "kpi", metric: sanMetric(w.metric, "metric") };
    return out;
  }
  if (w.kind === "table") {
    if (!Array.isArray(w.columns) || !w.columns.length) badValue("table.columns required");
    if (w.columns.length > 30) badValue("too many table columns");
    const columns: TableColumn[] = w.columns.map((c: any, i: number) => {
      if (!c || typeof c !== "object") badValue(`columns[${i}] must be an object`);
      const out: TableColumn = { col: str(c.col, `columns[${i}].col`) };
      const label = optStr(c.label, `columns[${i}].label`); if (label) out.label = label;
      if (c.agg !== undefined) { if (!AGGS.has(c.agg)) badValue(`columns[${i}].agg invalid`); out.agg = c.agg; }
      if (c.format !== undefined) { if (!FORMATS.has(c.format)) badValue(`columns[${i}].format invalid`); out.format = c.format; }
      return out;
    });
    const out: TableWidget = { ...base, kind: "table", columns };
    if (w.groupBy !== undefined && w.groupBy !== null) {
      if (!Array.isArray(w.groupBy) || w.groupBy.length > 5) badValue("groupBy must be an array of ≤5");
      out.groupBy = w.groupBy.map((g: any, i: number) => sanDim(g, `groupBy[${i}]`));
    }
    if (w.sort !== undefined && w.sort !== null) out.sort = { by: str(w.sort?.by, "sort.by"), dir: sanDir(w.sort?.dir) };
    const limit = sanLimit(w.limit); if (limit !== undefined) out.limit = limit;
    return out;
  }
  // chart
  if (!Array.isArray(w.series) || !w.series.length) badValue("chart.series required");
  if (w.series.length > 8) badValue("too many series");
  const out: ChartWidget = {
    ...base,
    kind: w.kind,
    x: sanDim(w.x, "x"),
    series: w.series.map((m: any, i: number) => sanMetric(m, `series[${i}]`)),
  };
  if (w.sort !== undefined && w.sort !== null) {
    const by = w.sort?.by;
    if (by !== "x" && by !== "y") badValue('chart sort.by must be "x"|"y"');
    out.sort = { by, dir: sanDir(w.sort?.dir) };
  }
  const limit = sanLimit(w.limit); if (limit !== undefined) out.limit = limit;
  return out;
}

/** The runtime compile: sanitized widget + validated filter values → SQL via
 *  the SAME deterministic builders the build turn uses. */
export function buildWidgetSql(rawWidget: unknown, appliedFilters: unknown): string {
  const w = sanitizeWidget(rawWidget);
  const extra = filterConditions(appliedFilters);
  if (w.kind === "kpi") return buildKpiSql(w, extra);
  if (w.kind === "table") return buildTableSql(w, extra).sql;
  return buildChartSql(w, extra).sql;
}
