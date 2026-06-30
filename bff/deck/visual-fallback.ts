// bff/deck/visual-fallback.ts — the deterministic Visual Planner. The LLM slide planner
// is unreliable at emitting structured chart blocks (it tends to describe charts in prose
// instead), which left slides chart-less. So rather than depend on it, this stage GUARANTEES
// visuals: for any content slide whose role implies a chart but that has none, it synthesizes
// an appropriate chart/table from the slide role + the data profile. Planner-authored charts
// (when valid) are kept untouched; this only fills the gaps. Pure + deterministic.
import type { Dataset } from "../../shared/types";
import type { Slide, ChartBlock, TableBlock, Block, SlideRole } from "../../shared/deck-spec";
import type { Metric } from "../../shared/dashboard-spec";

const NUMERIC = new Set(["integer", "number"]);
const isId = (n: string) => /(^id$|_id$|id$)/i.test(n);
// Prefer business-meaningful measures over arbitrary numeric columns.
const measureRank = (n: string) => {
  const s = n.toLowerCase();
  if (/(revenue|sales|amount|total|gmv|arr|mrr|value|profit|cost|spend)/.test(s)) return 0;
  if (/(count|qty|quantity|units|orders|volume|tickets|sessions|users)/.test(s)) return 1;
  return 2;
};

interface TableCols { table: string; date?: string; measures: string[]; dims: string[]; }

function colsFor(table: string | undefined, profiles: Dataset[]): TableCols | null {
  const d = (table && profiles.find((p) => p.tableName === table)) ||
    [...profiles].sort((a, b) => b.profile.rowCount - a.profile.rowCount)[0];
  if (!d) return null;
  const cols = d.profile.columns;
  const date = cols.find((c) => c.type === "date")?.name;
  const measures = cols.filter((c) => NUMERIC.has(c.type) && !isId(c.name)).map((c) => c.name).sort((a, b) => measureRank(a) - measureRank(b));
  const dims = cols.filter((c) => !NUMERIC.has(c.type) && c.type !== "date" && (c.uniqueCount ?? 99) <= 25)
    .sort((a, b) => (a.uniqueCount ?? 0) - (b.uniqueCount ?? 0)).map((c) => c.name);
  return { table: d.tableName, date, measures, dims };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
function measureMetric(c: TableCols): Metric {
  return c.measures.length ? { col: c.measures[0], agg: "sum", label: cap(c.measures[0]) } : { col: "*", agg: "count", label: "Count" };
}
function mname(c: TableCols) { return c.measures.length ? cap(c.measures[0]) : "Count"; }

function line(c: TableCols): ChartBlock | null {
  if (!c.date) return null;
  return { type: "chart", title: `${mname(c)} over time`, chartType: "line", table: c.table, x: { col: c.date, timeGrain: "month" }, series: [measureMetric(c)] };
}
function bar(c: TableCols, dimIdx = 0): ChartBlock | null {
  const dim = c.dims[dimIdx]; if (!dim) return null;
  return { type: "chart", title: `${mname(c)} by ${cap(dim)}`, chartType: "bar", table: c.table, x: { col: dim }, series: [measureMetric(c)] };
}
function pie(c: TableCols, dimIdx = 1): ChartBlock | null {
  const dim = c.dims[dimIdx]; if (!dim) return null;
  return { type: "chart", title: `Share by ${cap(dim)}`, chartType: "pie", table: c.table, x: { col: dim }, series: [measureMetric(c)] };
}
function table(c: TableCols): TableBlock | null {
  if (!c.dims.length) return null;
  const groupBy = c.dims.slice(0, 2).map((col) => ({ col }));
  const columns = c.measures.slice(0, 2).map((col) => ({ col, label: cap(col), agg: "sum" as const }));
  return { type: "table", title: "Detail", table: c.table, groupBy, columns: columns.length ? columns : [{ col: "*", label: "Count", agg: "count" }] };
}

function synth(role: SlideRole, c: TableCols): Block[] {
  switch (role) {
    case "trend": return [line(c) ?? bar(c)].filter(Boolean) as Block[];
    case "kpi": return [line(c), bar(c)].filter(Boolean) as Block[];          // overview: trend + breakdown
    case "breakdown": return [bar(c)].filter(Boolean) as Block[];
    case "comparison": return [bar(c, 0), pie(c, 1) ?? bar(c, 1)].filter(Boolean) as Block[];
    case "table": return [table(c)].filter(Boolean) as Block[];
    default: return [];
  }
}

const VISUAL_ROLES = new Set<SlideRole>(["trend", "kpi", "breakdown", "comparison", "table"]);

/** Add synthesized visuals to content slides that imply one but have none. */
export function ensureVisuals(slides: Slide[], profiles: Dataset[]): { slides: Slide[]; added: number } {
  let added = 0;
  const out = slides.map((s) => {
    const hasVisual = s.blocks.some((b) => b.type === "chart" || b.type === "table");
    if (hasVisual || !VISUAL_ROLES.has(s.role)) return s;
    // primary table = the one the slide's KPIs reference, else the largest dataset
    const kpiTable = s.blocks.flatMap((b) => (b.type === "kpis" ? b.items.map((k) => k.table) : []))[0];
    const cols = colsFor(kpiTable, profiles);
    if (!cols) return s;
    const visuals = synth(s.role, cols);
    if (!visuals.length) return s;
    added += visuals.length;
    return { ...s, blocks: [...s.blocks, ...visuals] };
  });
  return { slides: out, added };
}