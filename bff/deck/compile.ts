// bff/deck/compile.ts — turns a DeckSpec into a CompiledDeck by resolving every data
// block to REAL values. Chart/table/KPI blocks reuse the dashboard SQL builder, so the
// deck and dashboard pipelines share one deterministic, dialect-safe SQL layer. The
// pptx renderer downstream is then pure layout — it never sees SQL or invented numbers.
import type { Dataset } from "../../shared/types";
import type {
  DeckSpec, CompiledDeck, CompiledSlide, CompiledBlock, Block,
  ChartBlock, TableBlock, KpisBlock, ResolvedChart,
} from "../../shared/deck-spec";
import type { ChartWidget, TableWidget, KpiWidget, ValueFormat } from "../../shared/dashboard-spec";
import { buildChartSql, buildTableSql, buildKpiSql } from "../dashboard/sql";
import type { QueryFn } from "./facts";

const numv = (v: unknown) => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0));

function fmt(v: number, f?: ValueFormat): string {
  if (!isFinite(v)) return String(v);
  switch (f) {
    case "percent": return v.toFixed(1) + "%";
    case "currency": return "$" + Math.round(v).toLocaleString();
    case "hours": return v.toFixed(1) + "h";
    case "days": return v.toFixed(1) + "d";
    case "compact": return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v);
    default: return v.toLocaleString();
  }
}

async function resolveChart(b: ChartBlock, query: QueryFn): Promise<ResolvedChart> {
  const widget: ChartWidget = {
    id: "c", kind: b.chartType, title: "", table: b.table, x: b.x,
    series: b.series, filters: b.filters, sort: b.sort, limit: b.limit ?? 20,
  };
  const { sql, seriesKeys } = buildChartSql(widget);
  const rows = await query(sql);
  return {
    chartType: b.chartType,
    labels: rows.map((r) => (typeof r.x === "string" && /^\d{4}-\d{2}-\d{2}T/.test(r.x) ? r.x.slice(0, 10) : (r.x as any))),
    series: seriesKeys.map((k) => ({ name: k.label, values: rows.map((r) => numv(r[k.key])) })),
  };
}

async function resolveTable(b: TableBlock, query: QueryFn) {
  const widget: TableWidget = {
    id: "t", kind: "table", title: "", table: b.table,
    columns: b.columns, groupBy: b.groupBy, filters: b.filters, limit: b.limit ?? 12,
  };
  const { sql } = buildTableSql(widget);
  const rows = await query(sql);
  const columns = rows.length ? Object.keys(rows[0]) : b.columns.map((c) => c.label || c.col);
  return { columns, rows: rows.map((r) => columns.map((c) => (r[c] as any) ?? "")) };
}

async function resolveKpis(b: KpisBlock, query: QueryFn) {
  const out = [];
  for (const item of b.items) {
    const widget: KpiWidget = { id: "k", kind: "kpi", title: item.label, table: item.table, metric: item.metric, filters: item.filters };
    try {
      const rows = await query(buildKpiSql(widget));
      out.push({ label: item.label, value: fmt(numv(rows[0]?.value), item.format || item.metric.format) });
    } catch { out.push({ label: item.label, value: "—" }); }
  }
  return out;
}

export async function compileDeck(spec: DeckSpec, _profiles: Dataset[], query?: QueryFn): Promise<CompiledDeck> {
  const warnings: string[] = [];
  const slides: CompiledSlide[] = [];

  for (const slide of spec.slides) {
    const blocks: CompiledBlock[] = [];
    for (const b of slide.blocks as Block[]) {
      try {
        if (b.type === "chart") {
          if (!query) { warnings.push(`slide "${slide.id}": chart needs a data connection — shown as title only`); continue; }
          blocks.push({ block: b, chart: await resolveChart(b, query) });
        } else if (b.type === "table") {
          if (!query) { warnings.push(`slide "${slide.id}": table needs a data connection — skipped`); continue; }
          blocks.push({ block: b, table: await resolveTable(b, query) });
        } else if (b.type === "kpis") {
          if (!query) { warnings.push(`slide "${slide.id}": KPIs need a data connection — skipped`); continue; }
          blocks.push({ block: b, kpis: await resolveKpis(b, query) });
        } else {
          blocks.push({ block: b }); // heading/bullets/callout/note: text passthrough
        }
      } catch (e) {
        warnings.push(`slide "${slide.id}": ${(b as any).type} block failed (${(e as Error).message.split("\n")[0]}) — skipped`);
      }
    }
    slides.push({ id: slide.id, role: slide.role, title: slide.title, message: slide.message, blocks, notes: slide.notes });
  }

  return { meta: spec.meta, slides, warnings };
}