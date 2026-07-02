// bff/deck/slide-planner.ts — STAGE 2 of the two-stage planner. Expands each approved
// outline node into a full slide: title, one-line message, content blocks (bullets,
// chart, table, KPIs, callout), and speaker notes. It picks columns/aggregations as
// DATA (the compiler builds the SQL), so it can't emit a bad query. Returns null on fail.
import type { Dataset } from "../../shared/types";
import type { DeckSpec, OutlineNode, Slide, Block, DeckMeta } from "../../shared/deck-spec";
import { callGemini, ORCHESTRATE_OPTS, type GenResult, type GenOptions } from "../aiflow";
import { evidenceText, type EvidenceCatalog } from "./facts";
import { catalogText } from "./catalog";
import type { MetricCatalog } from "../../shared/catalog";

export type Run = (system: string, user: string, opts?: GenOptions) => Promise<GenResult>;
const TIMEOUT = Number(process.env.DECK_PLANNER_TIMEOUT_MS ?? 25000);
const AGG = ["count", "count_distinct", "sum", "avg", "min", "max", "median"];
const FMT = ["number", "compact", "percent", "currency", "hours", "days"];

const METRIC = { type: "object", properties: { col: { type: "string" }, agg: { type: "string", enum: AGG }, label: { type: "string" }, format: { type: "string", enum: FMT } }, required: ["col", "agg"] };
const DIM = { type: "object", properties: { col: { type: "string" }, timeGrain: { type: "string", enum: ["day", "week", "month", "quarter", "year"] }, label: { type: "string" } }, required: ["col"] };
const BLOCK = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["heading", "bullets", "callout", "note", "kpis", "table", "chart"] },
    title: { type: "string" },
    text: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    emphasis: { type: "string", enum: ["info", "good", "warn"] },
    kpis: { type: "array", items: { type: "object", properties: { label: { type: "string" }, table: { type: "string" }, metric: METRIC }, required: ["label", "table", "metric"] } },
    chartType: { type: "string", enum: ["line", "bar", "area", "pie"] },
    table: { type: "string" },
    x: DIM,
    series: { type: "array", items: METRIC },
    columns: { type: "array", items: { type: "object", properties: { col: { type: "string" }, label: { type: "string" }, agg: { type: "string", enum: AGG } }, required: ["col"] } },
    groupBy: { type: "array", items: DIM },
    limit: { type: "integer" },
  },
  required: ["type"],
};
export const SLIDES_SCHEMA = {
  type: "object",
  properties: {
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, role: { type: "string" }, title: { type: "string" },
          message: { type: "string" }, notes: { type: "string" },
          blocks: { type: "array", items: BLOCK },
        },
        required: ["id", "role", "title", "blocks"],
      },
    },
  },
  required: ["slides"],
};

const SYSTEM = `You are the SLIDE planner for a presentation generator. You receive an approved OUTLINE and the data evidence, and you expand each outline node into a full slide. Output ONLY JSON: { slides[] }.

Each slide: keep the outline node's id and role; write a clear title and a one-line message (the takeaway); add content blocks; add brief speaker notes.

Block types:
- heading { text }, bullets { items[] }, callout { text, emphasis? }, note { text }
- kpis { kpis: [{ label, table, metric:{col,agg,format?} }] }   ← 3-6 cards
- chart { title, chartType: line|bar|area|pie, table, x:{col,timeGrain?}, series:[{col,agg,label?,format?}] }
- table { title, table, columns:[{col,label?,agg?}], groupBy?[] }

Rules — build DENSE, executive-quality slides (a single lonely chart looks empty):
- Start with an OVERVIEW/scorecard slide: a 4-KPI strip PLUS 2 charts on the same slide.
- Most analysis slides should carry 2-4 visuals in a grid, or one chart + 3-5 supporting bullets. Put several blocks on a slide; the renderer lays them out in a grid.
- Use variety across the deck: KPI strip, trend (line/area), category breakdowns (bar), share (pie/donut), a side-by-side comparison, and at least one data table.
- Aim for 10-14 slides. One clear MESSAGE per slide, but back it with multiple visuals.
- EVERY chart and table block must have a short \`title\` (it captions the cell). Use ONLY columns from the evidence; sum/avg need numeric columns; pie = one series over a low-cardinality category; set x.timeGrain on a date column for trends.
- Ground claims in the evidence numbers; add brief speaker notes.

On an EDIT turn you receive the CURRENT slides — return the full updated set, changing as little as possible and keeping untouched slide ids intact.`;

function buildUser(datasets: Dataset[], evidence: EvidenceCatalog, outline: OutlineNode[], meta: DeckMeta, userPrompt: string, current?: DeckSpec, catalog?: MetricCatalog, context?: string): string {
  const schema = datasets.map((d) => `"${d.tableName}": ${d.profile.columns.map((c) => `${c.name}(${c.type})`).join(", ")}`).join("\n");
  const parts = context ? [context, ""] : [];
  parts.push(`AUDIENCE: ${meta.audience}${meta.goal ? ` — goal: ${meta.goal}` : ""}`);
  if (catalog) parts.push("", "CATALOG (prefer these governed measures + breakdowns; they carry the right aggregation & format):", catalogText(catalog));
  parts.push("", "COLUMNS (raw):", schema);
  parts.push("", "EVIDENCE:", evidenceText(evidence), "", "APPROVED OUTLINE:", JSON.stringify(outline));
  if (current) { parts.push("", "CURRENT SLIDES (edit — keep untouched ids):", JSON.stringify(current.slides)); }
  parts.push("", "USER REQUEST:", userPrompt);
  return parts.join("\n");
}

const strip = (t: string) => t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

function asDim(x: any): { col: string; timeGrain?: any; label?: string } | null {
  if (!x) return null;
  if (typeof x === "string") return { col: x };
  if (x.col) return { col: String(x.col), timeGrain: x.timeGrain, label: x.label };
  return null;
}
function asMetrics(arr: any): any[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((m: any) => (typeof m === "string" ? { col: m, agg: "sum" } : m && m.col ? { col: String(m.col), agg: m.agg || "sum", label: m.label, format: m.format } : null))
    .filter(Boolean);
}

function coerceBlock(b: any): Block | null {
  if (!b || typeof b.type !== "string") return null;
  switch (b.type) {
    case "heading": return b.text ? { type: "heading", text: String(b.text) } : null;
    case "bullets": return Array.isArray(b.items) && b.items.length ? { type: "bullets", items: b.items.map(String) } : null;
    case "callout": return b.text ? { type: "callout", text: String(b.text), emphasis: b.emphasis } : null;
    case "note": return b.text ? { type: "note", text: String(b.text) } : null;
    case "kpis": {
      const items = (Array.isArray(b.kpis) ? b.kpis : Array.isArray(b.items) ? b.items : [])
        .filter((k: any) => k?.label && k?.table && (k?.metric?.col || k?.col))
        .map((k: any) => ({ label: String(k.label), table: String(k.table), metric: k.metric ?? { col: k.col, agg: k.agg || "sum" }, filters: k.filters, format: k.metric?.format ?? k.format }));
      return items.length ? { type: "kpis", items } : null;
    }
    case "chart": {
      const x = asDim(b.x);
      const series = asMetrics(b.series && b.series.length ? b.series : b.y ? [{ col: b.y, agg: b.agg || "sum" }] : []);
      return b.chartType && b.table && x && series.length
        ? { type: "chart", title: b.title ? String(b.title) : undefined, chartType: b.chartType, table: String(b.table), x, series, filters: b.filters, sort: b.sort, limit: b.limit }
        : null;
    }
    case "table": {
      const columns = Array.isArray(b.columns) ? b.columns.map((c: any) => (typeof c === "string" ? { col: c } : c)).filter((c: any) => c?.col) : [];
      return b.table && columns.length
        ? { type: "table", title: b.title ? String(b.title) : undefined, table: String(b.table), columns, groupBy: b.groupBy, filters: b.filters, limit: b.limit }
        : null;
    }
    default: return null;
  }
}

export interface SlideInput { datasets: Dataset[]; evidence: EvidenceCatalog; outline: OutlineNode[]; meta: DeckMeta; userPrompt: string; currentSpec?: DeckSpec; catalog?: MetricCatalog; context?: string; }

export async function planSlides(input: SlideInput, run: Run = callGemini, timeoutMs = TIMEOUT): Promise<Slide[] | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  const call = (async () => {
    try {
      const { text } = await run(SYSTEM, buildUser(input.datasets, input.evidence, input.outline, input.meta, input.userPrompt, input.currentSpec, input.catalog, input.context), { ...ORCHESTRATE_OPTS, responseSchema: SLIDES_SCHEMA });
      const o = JSON.parse(strip(text));
      if (!Array.isArray(o?.slides) || !o.slides.length) return null;
      const slides: Slide[] = o.slides
        .filter((s: any) => s && s.id && s.title)
        .map((s: any) => ({
          id: String(s.id), role: s.role ?? "callout", title: String(s.title), message: s.message ? String(s.message) : undefined,
          notes: s.notes ? String(s.notes) : undefined,
          blocks: (Array.isArray(s.blocks) ? s.blocks : []).map(coerceBlock).filter((b: Block | null): b is Block => !!b),
        }));
      const visuals = slides.reduce((n, s) => n + s.blocks.filter((b) => b.type === "chart" || b.type === "table").length, 0);
      console.log(`[deck-slides] planned ${slides.length} slide(s), ${visuals} chart/table block(s)`);
      return slides.length ? slides : null;
    } catch (e) { console.warn(`[deck-slides] failed: ${(e as Error).message}`); return null; }
  })();
  return Promise.race([call, timeout]);
}