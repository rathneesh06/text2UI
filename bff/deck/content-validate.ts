// bff/deck/content-validate.ts — the Layout & Content Validator. Deterministic per-slide
// checks AFTER slide planning: every column referenced by a chart/table/KPI block must
// exist in its table (else the block is dropped), bullet density and word length are
// capped, pie charts keep a single series, and titles are trimmed. This is what keeps a
// hallucinated column or an overloaded slide from reaching the compiler.
import type { Dataset } from "../../shared/types";
import type { Slide, Block } from "../../shared/deck-spec";

const NUMERIC = new Set(["integer", "number"]);
const NUMERIC_AGGS = new Set(["sum", "avg", "min", "max", "median"]);

export interface ContentResult { slides: Slide[]; warnings: string[]; }

export function validateContent(
  slides: Slide[],
  profiles: Dataset[],
  opts: { maxBullets?: number; maxBulletWords?: number } = {},
): ContentResult {
  const maxBullets = opts.maxBullets ?? 6;
  const maxWords = opts.maxBulletWords ?? 14;
  const warnings: string[] = [];
  const idx = new Map<string, Map<string, string>>();
  for (const d of profiles) idx.set(d.tableName, new Map(d.profile.columns.map((c) => [c.name, c.type])));

  const colOk = (table: string, col: string) => idx.get(table)?.has(col);
  const isNum = (table: string, col: string) => NUMERIC.has(idx.get(table)?.get(col) ?? "");

  const fixBlock = (sid: string, b: Block): Block | null => {
    if (b.type === "bullets") {
      let items = b.items.map((t) => {
        const words = t.split(/\s+/);
        return words.length > maxWords ? words.slice(0, maxWords).join(" ") + "…" : t;
      });
      if (items.length > maxBullets) { warnings.push(`slide "${sid}": trimmed bullets to ${maxBullets}`); items = items.slice(0, maxBullets); }
      return { ...b, items };
    }
    if (b.type === "chart") {
      if (!idx.has(b.table)) { warnings.push(`slide "${sid}": chart table "${b.table}" unknown — dropped`); return null; }
      if (!colOk(b.table, b.x.col)) { warnings.push(`slide "${sid}": chart x "${b.x.col}" not in ${b.table} — dropped`); return null; }
      let series = b.series.filter((m) => m.agg === "count" || colOk(b.table, m.col));
      series = series.map((m) => (NUMERIC_AGGS.has(m.agg) && !isNum(b.table, m.col) ? { ...m, agg: "count" as const } : m));
      if (!series.length) { warnings.push(`slide "${sid}": chart has no valid series — dropped`); return null; }
      if (b.chartType === "pie" && series.length > 1) series = series.slice(0, 1);
      return { ...b, series };
    }
    if (b.type === "table") {
      if (!idx.has(b.table)) { warnings.push(`slide "${sid}": table "${b.table}" unknown — dropped`); return null; }
      const columns = b.columns.filter((c) => c.agg === "count" || colOk(b.table, c.col));
      if (!columns.length) { warnings.push(`slide "${sid}": table has no valid columns — dropped`); return null; }
      const groupBy = (b.groupBy ?? []).filter((g) => colOk(b.table, g.col));
      return { ...b, columns, groupBy };
    }
    if (b.type === "kpis") {
      const items = b.items.filter((k) => idx.has(k.table) && (k.metric.agg === "count" || colOk(k.table, k.metric.col)))
        .map((k) => (NUMERIC_AGGS.has(k.metric.agg) && !isNum(k.table, k.metric.col) ? { ...k, metric: { ...k.metric, agg: "count" as const } } : k));
      if (!items.length) { warnings.push(`slide "${sid}": no valid KPIs — dropped`); return null; }
      return { ...b, items };
    }
    return b; // heading / callout / note: passthrough
  };

  const out = slides.map((s) => {
    const title = s.title.length > 90 ? s.title.slice(0, 90) + "…" : s.title;
    const blocks = s.blocks.map((b) => fixBlock(s.id, b)).filter((b): b is Block => !!b);
    return { ...s, title, blocks };
  });

  return { slides: out, warnings };
}