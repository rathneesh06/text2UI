// bff/deck/slide-planner.ts — STAGE 2 of the two-stage planner. Expands each approved
// outline node into a full slide: title, one-line message, content blocks (bullets,
// chart, table, KPIs, callout), and speaker notes. It picks columns/aggregations as
// DATA (the compiler builds the SQL), so it can't emit a bad query. Returns null on fail.
import type { Dataset } from "../../shared/types";
import type { DeckSpec, OutlineNode, Slide, Block, DeckMeta } from "../../shared/deck-spec";
import { callGemini, ORCHESTRATE_OPTS, type GenResult, type GenOptions } from "../aiflow";
import { evidenceText, type EvidenceCatalog } from "./facts";

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
- kpis { kpis: [{ label, table, metric:{col,agg,format?} }] }   ← for kpi slides
- chart { chartType: line|bar|area|pie, table, x:{col,timeGrain?}, series:[{col,agg,label?,format?}] }
- table { table, columns:[{col,label?,agg?}], groupBy?[] }

Rules: ONE chart OR one table per slide; at most 5 short bullets; use ONLY columns from the evidence; choose aggregations that fit (sum/avg need numeric columns; count works on anything); for trends set x.timeGrain on a date column; pie = one series over a low-cardinality category. Ground claims in the evidence numbers.

On an EDIT turn you receive the CURRENT slides — return the full updated set, changing as little as possible and keeping untouched slide ids intact.`;

function buildUser(datasets: Dataset[], evidence: EvidenceCatalog, outline: OutlineNode[], meta: DeckMeta, userPrompt: string, current?: DeckSpec): string {
  const schema = datasets.map((d) => `"${d.tableName}": ${d.profile.columns.map((c) => `${c.name}(${c.type})`).join(", ")}`).join("\n");
  const parts = [
    `AUDIENCE: ${meta.audience}${meta.goal ? ` — goal: ${meta.goal}` : ""}`,
    "", "COLUMNS:", schema,
    "", "EVIDENCE:", evidenceText(evidence),
    "", "APPROVED OUTLINE:", JSON.stringify(outline),
  ];
  if (current) { parts.push("", "CURRENT SLIDES (edit — keep untouched ids):", JSON.stringify(current.slides)); }
  parts.push("", "USER REQUEST:", userPrompt);
  return parts.join("\n");
}

const strip = (t: string) => t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

function coerceBlock(b: any): Block | null {
  if (!b || typeof b.type !== "string") return null;
  switch (b.type) {
    case "heading": return b.text ? { type: "heading", text: String(b.text) } : null;
    case "bullets": return Array.isArray(b.items) && b.items.length ? { type: "bullets", items: b.items.map(String) } : null;
    case "callout": return b.text ? { type: "callout", text: String(b.text), emphasis: b.emphasis } : null;
    case "note": return b.text ? { type: "note", text: String(b.text) } : null;
    case "kpis": return Array.isArray(b.kpis) && b.kpis.length
      ? { type: "kpis", items: b.kpis.filter((k: any) => k?.label && k?.table && k?.metric?.col).map((k: any) => ({ label: String(k.label), table: String(k.table), metric: k.metric, filters: k.filters, format: k.metric?.format })) }
      : null;
    case "chart": return b.chartType && b.table && b.x?.col && Array.isArray(b.series) && b.series.length
      ? { type: "chart", chartType: b.chartType, table: String(b.table), x: b.x, series: b.series, filters: b.filters, sort: b.sort, limit: b.limit }
      : null;
    case "table": return b.table && Array.isArray(b.columns) && b.columns.length
      ? { type: "table", table: String(b.table), columns: b.columns, groupBy: b.groupBy, filters: b.filters, limit: b.limit }
      : null;
    default: return null;
  }
}

export interface SlideInput { datasets: Dataset[]; evidence: EvidenceCatalog; outline: OutlineNode[]; meta: DeckMeta; userPrompt: string; currentSpec?: DeckSpec; }

export async function planSlides(input: SlideInput, run: Run = callGemini, timeoutMs = TIMEOUT): Promise<Slide[] | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  const call = (async () => {
    try {
      const { text } = await run(SYSTEM, buildUser(input.datasets, input.evidence, input.outline, input.meta, input.userPrompt, input.currentSpec), { ...ORCHESTRATE_OPTS, responseSchema: SLIDES_SCHEMA });
      const o = JSON.parse(strip(text));
      if (!Array.isArray(o?.slides) || !o.slides.length) return null;
      const slides: Slide[] = o.slides
        .filter((s: any) => s && s.id && s.title)
        .map((s: any) => ({
          id: String(s.id), role: s.role ?? "callout", title: String(s.title), message: s.message ? String(s.message) : undefined,
          notes: s.notes ? String(s.notes) : undefined,
          blocks: (Array.isArray(s.blocks) ? s.blocks : []).map(coerceBlock).filter((b: Block | null): b is Block => !!b),
        }));
      console.log(`[deck-slides] planned ${slides.length} slide(s)`);
      return slides.length ? slides : null;
    } catch (e) { console.warn(`[deck-slides] failed: ${(e as Error).message}`); return null; }
  })();
  return Promise.race([call, timeout]);
}