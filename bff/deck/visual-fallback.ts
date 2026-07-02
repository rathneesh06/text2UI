// bff/deck/visual-fallback.ts — the deterministic Visual Planner, now catalog-driven.
// For any content slide whose role implies a chart but that has none, it synthesizes the
// right chart/table from the Metric/Entity Catalog — using governed measures (with their
// default aggregation + value format) and labelled dimensions, so a synthesized "Revenue
// by Region" bar comes out currency-formatted with clean captions. Planner-authored charts
// are kept; this only fills gaps. Pure + deterministic.
import type { Dataset } from "../../shared/types";
import type { Slide, ChartBlock, TableBlock, Block, SlideRole } from "../../shared/deck-spec";
import type { Metric } from "../../shared/dashboard-spec";
import type { MetricCatalog, CatalogMeasure, CatalogDimension } from "../../shared/catalog";

interface TableModel { table: string; measure: CatalogMeasure | null; time?: CatalogDimension; cats: CatalogDimension[]; measures: CatalogMeasure[]; }

function modelFor(table: string | undefined, cat: MetricCatalog, datasets: Dataset[]): TableModel | null {
  const entity = (table && cat.entities.find((e) => e.table === table)) ||
    [...cat.entities].sort((a, b) => b.rowCount - a.rowCount)[0];
  if (!entity) return null;
  const measures = cat.measures.filter((m) => m.table === entity.table);
  // Prefer a currency (headline) measure, else the first real measure, else count.
  const measure = measures.find((m) => m.format === "currency") ?? measures.find((m) => m.col !== "*") ?? measures[0] ?? null;
  const dims = cat.dimensions.filter((d) => d.table === entity.table);
  return {
    table: entity.table,
    measure,
    time: dims.find((d) => d.kind === "time"),
    cats: dims.filter((d) => d.kind === "category").sort((a, b) => (a.cardinality ?? 0) - (b.cardinality ?? 0)),
    measures,
  };
}

function metric(m: CatalogMeasure | null): Metric {
  if (!m) return { col: "*", agg: "count", label: "Count" };
  return { col: m.col, agg: m.defaultAgg, label: m.label, format: m.format };
}
const mLabel = (m: CatalogMeasure | null) => m?.label ?? "Count";

function line(t: TableModel): ChartBlock | null {
  if (!t.time) return null;
  return { type: "chart", title: `${mLabel(t.measure)} over time`, chartType: "line", table: t.table, x: { col: t.time.col, timeGrain: "month" }, series: [metric(t.measure)] };
}
function bar(t: TableModel, i = 0): ChartBlock | null {
  const dim = t.cats[i]; if (!dim) return null;
  return { type: "chart", title: `${mLabel(t.measure)} by ${dim.label}`, chartType: "bar", table: t.table, x: { col: dim.col }, series: [metric(t.measure)] };
}
function pie(t: TableModel, i = 1): ChartBlock | null {
  const dim = t.cats[i]; if (!dim) return null;
  return { type: "chart", title: `Share by ${dim.label}`, chartType: "pie", table: t.table, x: { col: dim.col }, series: [metric(t.measure)] };
}
function table(t: TableModel): TableBlock | null {
  if (!t.cats.length) return null;
  const groupBy = t.cats.slice(0, 2).map((d) => ({ col: d.col }));
  const cols = t.measures.filter((m) => m.col !== "*").slice(0, 2).map((m) => ({ col: m.col, label: m.label, agg: m.defaultAgg }));
  return { type: "table", title: "Detail", table: t.table, groupBy, columns: cols.length ? cols : [{ col: "*", label: "Count", agg: "count" }] };
}

function synth(role: SlideRole, t: TableModel): Block[] {
  switch (role) {
    case "trend": return [line(t) ?? bar(t)].filter(Boolean) as Block[];
    case "kpi": return [line(t), bar(t)].filter(Boolean) as Block[];
    case "breakdown": return [bar(t), pie(t)].filter(Boolean) as Block[];
    case "comparison": return [bar(t, 0), pie(t, 1) ?? bar(t, 1)].filter(Boolean) as Block[];
    case "table": return [table(t)].filter(Boolean) as Block[];
    default: return [];
  }
}

const VISUAL_ROLES = new Set<SlideRole>(["trend", "kpi", "breakdown", "comparison", "table"]);

export function ensureVisuals(slides: Slide[], datasets: Dataset[], catalog: MetricCatalog): { slides: Slide[]; added: number } {
  let added = 0;
  const out = slides.map((s) => {
    const hasVisual = s.blocks.some((b) => b.type === "chart" || b.type === "table");
    if (hasVisual || !VISUAL_ROLES.has(s.role)) return s;
    const kpiTable = s.blocks.flatMap((b) => (b.type === "kpis" ? b.items.map((k) => k.table) : []))[0];
    const model = modelFor(kpiTable, catalog, datasets);
    if (!model) return s;
    const visuals = synth(s.role, model);
    if (!visuals.length) return s;
    added += visuals.length;
    return { ...s, blocks: [...s.blocks, ...visuals] };
  });
  return { slides: out, added };
}