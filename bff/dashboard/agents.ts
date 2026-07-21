// bff/dashboard/agents.ts — the specialist widget agents.
//
// Instead of one monolithic planner inventing the whole dashboard, each widget
// family gets its own focused agent: a narrow prompt, a narrow schema, and a
// DETERMINISTIC fallback computed from the data profile. The agents run in
// parallel; any one of them may fail (timeout, bad JSON, model outage) without
// taking the build down, because its fallback still contributes widgets. The
// merger (./merge) assembles the harvest into a DashboardSpec, which then flows
// through the existing validate → compile(SQL) → deterministic-render stages.
//
// Agents:
//   kpi    → 3-6 KpiWidgets (headline aggregates)
//   bar    → bar charts (rankings / categorical comparisons)
//   line   → line/area charts (temporal trends) — skipped when no date column
//   pie    → pie/donut charts (composition on low-cardinality categories)
//   table  → detail / grouped tables
import type { Dataset } from "../../shared/types";
import type { KpiWidget, ChartWidget, TableWidget, Widget } from "../../shared/dashboard-spec";
import { callGemini, ORCHESTRATE_OPTS, type GenResult, type GenOptions } from "../aiflow";
import { classifySchema, type SchemaRoles } from "./enhance";
import { tasksForAgent, taskDirective, type AnalysisTask } from "./decompose";

export type AgentRun = (system: string, user: string, opts?: GenOptions) => Promise<GenResult>;
const AGENT_TIMEOUT_MS = Number(process.env.DASHBOARD_AGENT_TIMEOUT_MS ?? 15000);

// ---------------------------------------------------------------------------
// Shared schema fragments (compact OpenAPI subset — Gemini-friendly)
// ---------------------------------------------------------------------------
const AGG = { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "median"] };
const FORMAT = { type: "string", enum: ["number", "compact", "percent", "currency", "hours", "days"] };
const FILTER_ITEM = { type: "object", properties: { col: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "in", "not_null", "is_null"] }, value: { type: "string", description: "literal value; pass numbers as strings" } }, required: ["col", "op"] };
const BASE_METRIC = { type: "object", properties: { col: { type: "string" }, agg: AGG, where: { type: "array", description: "conditions making this side CONDITIONAL, e.g. count where sla_status='met'", items: FILTER_ITEM } }, required: ["col", "agg"] };
const METRIC_EXPR = { type: "object", description: "derived metric: ratio=num/den, pct=num/den*100, diff=num-den. Use for rates, percentages, per-X averages. num and den MUST differ (identical sides = a meaningless constant 100%); make the numerator conditional with where when the qualifying rows are marked by a column value. NEVER label a plain sum as a percent.", properties: { op: { type: "string", enum: ["ratio", "pct", "diff"] }, num: BASE_METRIC, den: BASE_METRIC }, required: ["op", "num", "den"] };
const METRIC = { type: "object", properties: { col: { type: "string" }, agg: AGG, label: { type: "string" }, format: FORMAT, expr: METRIC_EXPR }, required: ["col", "agg"] };
const DIMENSION = { type: "object", properties: { col: { type: "string" }, timeGrain: { type: "string", enum: ["day", "week", "month", "quarter", "year"] }, label: { type: "string" } }, required: ["col"] };

const wrap = (item: unknown) => ({ type: "object", properties: { widgets: { type: "array", items: item } }, required: ["widgets"] });

const KPI_ITEM = { type: "object", properties: { title: { type: "string" }, subtitle: { type: "string", description: "short context line, e.g. 'All historical records'" }, table: { type: "string" }, metric: METRIC }, required: ["title", "table", "metric"] };
const CHART_ITEM = { type: "object", properties: { title: { type: "string" }, subtitle: { type: "string", description: "one line explaining what the chart shows" }, table: { type: "string" }, x: DIMENSION, series: { type: "array", items: METRIC }, limit: { type: "integer" }, kind: { type: "string", enum: ["line", "bar", "area", "pie", "donut"] } }, required: ["title", "table", "x", "series"] };
const TABLE_ITEM = { type: "object", properties: { title: { type: "string" }, subtitle: { type: "string" }, table: { type: "string" }, columns: { type: "array", items: { type: "object", properties: { col: { type: "string" }, label: { type: "string" }, agg: AGG }, required: ["col"] } }, groupBy: { type: "array", items: DIMENSION }, limit: { type: "integer" } }, required: ["title", "table", "columns"] };

// ---------------------------------------------------------------------------
// Prompt plumbing
// ---------------------------------------------------------------------------
function schemaText(datasets: Dataset[]): string {
  return datasets.map((d) => {
    const cols = d.profile.columns.map((c) => `${c.name}:${c.type}[distinct ${c.uniqueCount}]`);
    return `Table "${d.tableName}" (${d.profile.rowCount} rows): ${cols.join(", ")}`;
  }).join("\n");
}

const COMMON = `Give every widget a human title and a one-line subtitle that explains what it shows. You output ONLY the requested JSON. Ground every choice in columns that exist in the data profile — never invent a column or table. Follow the baseline instructions and analytical directive when given.`;

export interface AgentInput {
  datasets: Dataset[];
  userPrompt: string;
  /** the enhancement layer's combined instructions (baseline + directive) — always present */
  directive: string;
  /** decomposed analytical tasks (query breakdown layer) — routed per agent family */
  tasks?: AnalysisTask[];
}

function userPromptFor(input: AgentInput, ask: string, agentName?: string): string {
  const assigned = input.tasks && agentName ? taskDirective(tasksForAgent(agentName as any, input.tasks)) : null;
  return [
    "DATA PROFILE:", schemaText(input.datasets), "",
    "INSTRUCTIONS:", input.directive, "",
    ...(assigned ? [assigned, ""] : []),
    "USER REQUEST:", input.userPrompt, "",
    ask,
  ].join("\n");
}

function stripFences(t: string): string {
  return t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

// ---------------------------------------------------------------------------
// Coercers — normalize loose model JSON into typed widgets (full validation
// against the profile happens later in validateSpec; here we only shape-check)
// ---------------------------------------------------------------------------
let seq = 0;
const wid = (p: string) => `${p}${++seq}_${Math.random().toString(36).slice(2, 6)}`;

// A2: carry a well-formed derived expression through; drop malformed ones
// (validation re-checks columns against the profile later).
function coerceExpr(e: any): { expr?: import("../../shared/dashboard-spec").MetricExpr } {
  const ok = e && typeof e === "object" && ["ratio", "pct", "diff"].includes(e.op)
    && e.num?.agg && e.den?.agg;
  if (!ok) return {};
  return { expr: { op: e.op, num: { col: String(e.num.col ?? ""), agg: e.num.agg }, den: { col: String(e.den.col ?? ""), agg: e.den.agg } } };
}

function coerceKpis(parsed: any): KpiWidget[] {
  const arr = Array.isArray(parsed?.widgets) ? parsed.widgets : [];
  return arr.filter((w: any) => w?.title && w?.table && w?.metric?.col && w?.metric?.agg)
    .map((w: any): KpiWidget => ({ id: wid("kpi"), kind: "kpi", title: String(w.title), ...(w.subtitle ? { subtitle: String(w.subtitle) } : {}), table: String(w.table), metric: { col: String(w.metric.col), agg: w.metric.agg, label: w.metric.label, format: w.metric.format, ...coerceExpr(w.metric.expr) }, width: "quarter" }));
}

function coerceCharts(parsed: any, kinds: ChartWidget["kind"][], fallbackKind: ChartWidget["kind"]): ChartWidget[] {
  const arr = Array.isArray(parsed?.widgets) ? parsed.widgets : [];
  return arr.filter((w: any) => w?.title && w?.table && w?.x?.col && Array.isArray(w?.series) && w.series.length)
    .map((w: any): ChartWidget => ({
      id: wid(fallbackKind), kind: kinds.includes(w.kind) ? w.kind : fallbackKind,
      title: String(w.title), ...(w.subtitle ? { subtitle: String(w.subtitle) } : {}), table: String(w.table),
      x: { col: String(w.x.col), ...(w.x.timeGrain ? { timeGrain: w.x.timeGrain } : {}), ...(w.x.label ? { label: String(w.x.label) } : {}) },
      series: w.series.filter((m: any) => m?.col && m?.agg).map((m: any) => ({ col: String(m.col), agg: m.agg, label: m.label, format: m.format, ...coerceExpr(m.expr) })),
      ...(Number.isInteger(w.limit) && w.limit > 0 ? { limit: Math.min(w.limit, 50) } : {}),
      width: "half",
    }))
    .filter((w: ChartWidget) => w.series.length);
}

function coerceTables(parsed: any): TableWidget[] {
  const arr = Array.isArray(parsed?.widgets) ? parsed.widgets : [];
  return arr.filter((w: any) => w?.title && w?.table && Array.isArray(w?.columns) && w.columns.length)
    .map((w: any): TableWidget => ({
      id: wid("tbl"), kind: "table", title: String(w.title), ...(w.subtitle ? { subtitle: String(w.subtitle) } : {}), table: String(w.table),
      columns: w.columns.filter((c: any) => c?.col).map((c: any) => ({ col: String(c.col), ...(c.label ? { label: String(c.label) } : {}), ...(c.agg ? { agg: c.agg } : {}) })),
      ...(Array.isArray(w.groupBy) ? { groupBy: w.groupBy.filter((g: any) => g?.col).map((g: any) => ({ col: String(g.col), ...(g.timeGrain ? { timeGrain: g.timeGrain } : {}) })) } : {}),
      limit: Number.isInteger(w.limit) && w.limit > 0 ? Math.min(w.limit, 100) : 25,
      width: "full",
    }))
    .filter((w: TableWidget) => w.columns.length);
}

// ---------------------------------------------------------------------------
// Deterministic fallbacks — the reason a build can never come back empty
// ---------------------------------------------------------------------------
function tableOf(datasets: Dataset[], name: string): Dataset | undefined {
  return datasets.find((d) => d.tableName === name);
}

export function fallbackKpis(datasets: Dataset[], roles: SchemaRoles): KpiWidget[] {
  const out: KpiWidget[] = [];
  const main = datasets[0];
  if (main) out.push({ id: wid("kpi"), kind: "kpi", title: `Total ${main.tableName}`, table: main.tableName, metric: { col: main.profile.columns[0]?.name ?? "*", agg: "count", format: "compact" }, width: "quarter" });
  for (const m of roles.measures.slice(0, 3)) {
    out.push({ id: wid("kpi"), kind: "kpi", title: `Total ${m.col.name}`, table: m.table, metric: { col: m.col.name, agg: "sum", format: "compact" }, width: "quarter" });
    if (out.length >= 3) break;
  }
  const idc = roles.identifiers[0];
  if (idc && out.length < 5) out.push({ id: wid("kpi"), kind: "kpi", title: `Distinct ${idc.col.name}`, table: idc.table, metric: { col: idc.col.name, agg: "count_distinct", format: "compact" }, width: "quarter" });
  if (out.length < 3 && roles.measures[0]) {
    const m = roles.measures[0];
    out.push({ id: wid("kpi"), kind: "kpi", title: `Average ${m.col.name}`, table: m.table, metric: { col: m.col.name, agg: "avg", format: "number" }, width: "quarter" });
  }
  // A2: one HONEST derived-ratio KPI when the data supports it — so the ratio
  // machinery is exercised even without a model (degraded mode / offline tests).
  const ratio = fallbackRatioKpi(datasets, roles);
  if (ratio && out.length < 5) out.push(ratio);
  return out;
}

/** A ratio KPI derived deterministically from the profile, or null.
 *  Preference: (1) a 0/1 indicator column → "<col> rate" as a real pct
 *  (sum(indicator) over count(*)); (2) a low-cardinality dimension →
 *  "<rows> per <dim>" (count(*) over count_distinct(dim)). Both compile
 *  through the expr AST with nullif guards — never a dressed-up sum. */
export function fallbackRatioKpi(datasets: Dataset[], roles: SchemaRoles): KpiWidget | null {
  for (const d of datasets) {
    const ind = d.profile.columns.find((c) =>
      (c.type === "integer" || c.type === "boolean") &&
      c.uniqueCount >= 1 && c.uniqueCount <= 2 &&
      Number(c.min ?? 0) === 0 && Number(c.max ?? 1) === 1);
    if (ind && ind.type === "integer") {
      const pretty = ind.name.split("_").filter(Boolean).join(" ");
      return { id: wid("kpi"), kind: "kpi", title: `${pretty.charAt(0).toUpperCase() + pretty.slice(1)} rate`, table: d.tableName,
        metric: { col: ind.name, agg: "sum", format: "percent",
          expr: { op: "pct", num: { col: ind.name, agg: "sum" }, den: { col: "", agg: "count" } } }, width: "quarter" };
    }
  }
  const dim = roles.dimensions.find((r) => r.col.uniqueCount >= 2 && r.col.uniqueCount <= 50);
  if (dim) {
    return { id: wid("kpi"), kind: "kpi", title: `${dim.table} per ${dim.col.name}`, table: dim.table,
      metric: { col: "", agg: "count", format: "number",
        expr: { op: "ratio", num: { col: "", agg: "count" }, den: { col: dim.col.name, agg: "count_distinct" } } }, width: "quarter" };
  }
  return null;
}

export function fallbackBars(datasets: Dataset[], roles: SchemaRoles): ChartWidget[] {
  const dim = roles.dimensions.find((d) => d.col.uniqueCount >= 2);
  if (!dim) return [];
  const measure = roles.measures.find((m) => m.table === dim.table);
  const series = measure ? [{ col: measure.col.name, agg: "sum" as const, format: "compact" as const }] : [{ col: dim.col.name, agg: "count" as const }];
  const what = measure ? measure.col.name : "count";
  return [{ id: wid("bar"), kind: "bar", title: `${what} by ${dim.col.name}`, table: dim.table, x: { col: dim.col.name }, series, limit: 15, width: "half" }];
}

export function fallbackLines(datasets: Dataset[], roles: SchemaRoles): ChartWidget[] {
  const t = roles.temporals[0];
  if (!t) return [];
  const measure = roles.measures.find((m) => m.table === t.table);
  const series = measure ? [{ col: measure.col.name, agg: "sum" as const, format: "compact" as const }] : [{ col: t.col.name, agg: "count" as const }];
  const what = measure ? measure.col.name : "records";
  return [{ id: wid("line"), kind: "line", title: `${what} over time`, table: t.table, x: { col: t.col.name, timeGrain: t.suggestedGrain ?? "month" }, series, width: "half" }];
}

export function fallbackPies(datasets: Dataset[], roles: SchemaRoles): ChartWidget[] {
  const dim = roles.dimensions.find((d) => d.col.uniqueCount >= 2 && d.col.uniqueCount <= 8);
  if (!dim) return [];
  const measure = roles.measures.find((m) => m.table === dim.table);
  const series = measure ? [{ col: measure.col.name, agg: "sum" as const }] : [{ col: dim.col.name, agg: "count" as const }];
  return [{ id: wid("pie"), kind: "donut", title: `Share by ${dim.col.name}`, table: dim.table, x: { col: dim.col.name }, series, width: "half" }];
}

export function fallbackTables(datasets: Dataset[], roles: SchemaRoles): TableWidget[] {
  const dim = roles.dimensions[0];
  if (!dim) return [];
  const ds = tableOf(datasets, dim.table);
  if (!ds) return [];
  const measure = roles.measures.find((m) => m.table === dim.table);
  const columns = [
    { col: dim.col.name },
    { col: measure ? measure.col.name : (ds.profile.columns[0]?.name ?? dim.col.name), agg: (measure ? "sum" : "count") as "sum" | "count" },
  ];
  return [{ id: wid("tbl"), kind: "table", title: `${dim.col.name} summary`, table: dim.table, columns, groupBy: [{ col: dim.col.name }], limit: 25, width: "full" }];
}

// ---------------------------------------------------------------------------
// The agent runner + fan-out
// ---------------------------------------------------------------------------
interface AgentDef<T extends Widget> {
  name: string;
  system: string;
  ask: string;
  schema: unknown;
  coerce: (parsed: any) => T[];
  fallback: (datasets: Dataset[], roles: SchemaRoles) => T[];
  /** when false, the agent contributes nothing (e.g. no date column → no line agent) */
  applicable?: (roles: SchemaRoles) => boolean;
}

const KPI_AGENT: AgentDef<KpiWidget> = {
  name: "kpi",
  system: `${COMMON} You are the KPI-card agent of a dashboard generator. Choose the 3-6 headline aggregates that best summarize this data for the user's request. Each KPI is one metric: pick the column, the aggregation, a short human title, and a display format (currency for money, compact for large counts, percent for rates). For RATES, PERCENTAGES, and PER-X ratios, set metric.expr: {op:"pct"|"ratio"|"diff", num:{col,agg,where?}, den:{col,agg}}. When the qualifying rows are marked by a column VALUE (e.g. sla_status = 'met'), make the NUMERATOR conditional: num {col:"", agg:"count", where:[{col:"sla_status",op:"=",value:"met"}]} over den count(*) — that is a real attainment rate. 0/1 indicator columns can instead sum to a numerator. tickets per agent = ratio of count(*) over count_distinct(agent). num and den MUST NOT be identical (that is a constant 100%, not a rate — it will be rejected). NEVER present a plain sum/count as a percent, and NEVER title a KPI "rate"/"percentage"/"share" unless its metric is an expr ratio — a count titled as a rate is rejected. If the ratio cannot be built from real columns and observed values, choose a different KPI.`,
  ask: "Return {\"widgets\":[...]} with 3-6 KPI candidates.",
  schema: wrap(KPI_ITEM),
  coerce: coerceKpis,
  fallback: fallbackKpis,
};

const BAR_AGENT: AgentDef<ChartWidget> = {
  name: "bar",
  system: `${COMMON} You are the bar-chart agent. Propose 1-3 bar charts that answer RANKING or COMPARISON questions (e.g. top categories by revenue). x must be a categorical dimension (cardinality roughly 2-30; set limit for long tails), series one or two aggregated measures. kind is always "bar".`,
  ask: "Return {\"widgets\":[...]} with 1-3 bar-chart candidates.",
  schema: wrap(CHART_ITEM),
  coerce: (p) => coerceCharts(p, ["bar"], "bar"),
  fallback: fallbackBars,
  applicable: (r) => r.dimensions.length > 0,
};

const LINE_AGENT: AgentDef<ChartWidget> = {
  name: "line",
  system: `${COMMON} You are the trend-chart agent. Propose 1-3 line or area charts showing how measures move OVER TIME. x MUST be a real date/timestamp column with a timeGrain (use the grain suggested in the instructions). kind is "line" (or "area" for cumulative/volume feel).`,
  ask: "Return {\"widgets\":[...]} with 1-3 trend-chart candidates.",
  schema: wrap(CHART_ITEM),
  coerce: (p) => coerceCharts(p, ["line", "area"], "line"),
  fallback: fallbackLines,
  applicable: (r) => r.temporals.length > 0,
};

const PIE_AGENT: AgentDef<ChartWidget> = {
  name: "pie",
  system: `${COMMON} You are the composition-chart agent. Propose 1-2 pie or donut charts showing SHARE-OF-TOTAL for ONE measure over a LOW-cardinality category (2-8 values). Exactly one series per chart. kind is "pie" or "donut".`,
  ask: "Return {\"widgets\":[...]} with 1-2 composition-chart candidates.",
  schema: wrap(CHART_ITEM),
  coerce: (p) => coerceCharts(p, ["pie", "donut"], "donut").map((w) => ({ ...w, series: w.series.slice(0, 1) })),
  fallback: fallbackPies,
  applicable: (r) => r.dimensions.some((d) => d.col.uniqueCount >= 2 && d.col.uniqueCount <= 12),
};

const TABLE_AGENT: AgentDef<TableWidget> = {
  name: "table",
  system: `${COMMON} You are the detail-table agent. Propose 0-2 tables: either a grouped summary (groupBy a dimension, aggregate 1-3 measures) or a top-N detail listing. Keep limit <= 25.`,
  ask: "Return {\"widgets\":[...]} with 0-2 table candidates.",
  schema: wrap(TABLE_ITEM),
  coerce: coerceTables,
  fallback: fallbackTables,
};

export interface AgentReport { name: string; source: "model" | "fallback" | "skipped"; count: number }
export interface AgentHarvest {
  kpis: KpiWidget[];
  trends: ChartWidget[];       // line/area
  bars: ChartWidget[];
  compositions: ChartWidget[]; // pie/donut
  tables: TableWidget[];
  reports: AgentReport[];
}

async function runAgent<T extends Widget>(
  def: AgentDef<T>, input: AgentInput, roles: SchemaRoles, run: AgentRun, timeoutMs: number,
): Promise<{ widgets: T[]; report: AgentReport }> {
  if (def.applicable && !def.applicable(roles)) {
    return { widgets: [], report: { name: def.name, source: "skipped", count: 0 } };
  }
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<T[] | null> => {
    try {
      const { text } = await run(def.system, userPromptFor(input, def.ask, def.name), { ...ORCHESTRATE_OPTS, responseSchema: def.schema });
      const widgets = def.coerce(JSON.parse(stripFences(text)));
      return widgets.length ? widgets : null;
    } catch (err) {
      console.warn(`[agent:${def.name}] failed: ${(err as Error).message}`);
      return null;
    }
  })();
  const fromModel = await Promise.race([call, timeout]);
  if (fromModel) return { widgets: fromModel, report: { name: def.name, source: "model", count: fromModel.length } };
  const fb = def.fallback(input.datasets, roles);
  console.log(`[agent:${def.name}] using deterministic fallback (${fb.length} widget(s))`);
  return { widgets: fb, report: { name: def.name, source: "fallback", count: fb.length } };
}

/** Fan out all specialist agents IN PARALLEL. Total: every agent either returns
 *  model widgets, its deterministic fallback, or is skipped as inapplicable —
 *  the harvest as a whole can only be empty when the data has no columns. */
export async function runChartAgents(input: AgentInput, run: AgentRun = callGemini, timeoutMs = AGENT_TIMEOUT_MS): Promise<AgentHarvest> {
  const roles = classifySchema(input.datasets);
  const [kpi, bar, line, pie, table] = await Promise.all([
    runAgent(KPI_AGENT, input, roles, run, timeoutMs),
    runAgent(BAR_AGENT, input, roles, run, timeoutMs),
    runAgent(LINE_AGENT, input, roles, run, timeoutMs),
    runAgent(PIE_AGENT, input, roles, run, timeoutMs),
    runAgent(TABLE_AGENT, input, roles, run, timeoutMs),
  ]);
  const reports = [kpi.report, bar.report, line.report, pie.report, table.report];
  console.log(`[agents] ${reports.map((r) => `${r.name}:${r.source}(${r.count})`).join(" ")}`);
  return { kpis: kpi.widgets, bars: bar.widgets, trends: line.widgets, compositions: pie.widgets, tables: table.widgets, reports };
}
