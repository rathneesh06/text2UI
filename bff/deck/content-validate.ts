// bff/deck/content-validate.ts — the Layout & Content Validator. Deterministic per-slide
// checks AFTER slide planning: every column referenced by a chart/table/KPI block must
// exist in its table (resolved case-insensitively and rewritten to the canonical name,
// so a near-miss like "Revenue" or "month " still works), bullet density and word
// length are capped, pie charts keep a single series, titles are trimmed, and a slide
// holds at most 4 visuals. This is what keeps a hallucinated column or an overloaded
// slide from silently dropping a chart.
import type { Dataset } from "../../shared/types";
import type { Slide, Block } from "../../shared/deck-spec";
import type { Dimension, Metric } from "../../shared/dashboard-spec";

const NUMERIC = new Set(["integer", "number"]);
const NUMERIC_AGGS = new Set(["sum", "avg", "min", "max", "median"]);

export interface ContentResult { slides: Slide[]; warnings: string[]; }

export function validateContent(
  slides: Slide[],
  profiles: Dataset[],
  opts: { maxBullets?: number; maxBulletWords?: number } = {},
): ContentResult {
  const maxBullets = opts.maxBullets ?? 6;
  const maxWords = opts.maxBulletWords ?? 16;
  const warnings: string[] = [];

  // table -> (lowercased col name -> { name, type })
  const idx = new Map<string, Map<string, { name: string; type: string }>>();
  for (const d of profiles) {
    const m = new Map<string, { name: string; type: string }>();
    for (const c of d.profile.columns) m.set(c.name.toLowerCase().trim(), { name: c.name, type: c.type });
    idx.set(d.tableName, m);
  }
  const resolve = (table: string, col: string) => idx.get(table)?.get(String(col).toLowerCase().trim());
  const isNum = (table: string, col: string) => NUMERIC.has(resolve(table, col)?.type ?? "");

  // Rewrite a metric/dimension's col to the canonical name; return null if unresolved.
  const fixDim = (table: string, d: Dimension): Dimension | null => {
    const r = resolve(table, d.col); return r ? { ...d, col: r.name } : null;
  };
  const fixMetric = (table: string, m: Metric): Metric | null => {
    if (m.agg === "count") return m;
    const r = resolve(table, m.col);
    if (!r) return null;
    const agg = NUMERIC_AGGS.has(m.agg) && !NUMERIC.has(r.type) ? "count" : m.agg;
    return { ...m, col: r.name, agg };
  };

  const fixBlock = (sid: string, b: Block): Block | null => {
    if (b.type === "bullets") {
      let items = b.items.map((t) => { const w = t.split(/\s+/); return w.length > maxWords ? w.slice(0, maxWords).join(" ") + "…" : t; });
      if (items.length > maxBullets) { warnings.push(`slide "${sid}": trimmed bullets to ${maxBullets}`); items = items.slice(0, maxBullets); }
      return { ...b, items };
    }
    if (b.type === "chart") {
      if (!idx.has(b.table)) { warnings.push(`slide "${sid}": chart table "${b.table}" unknown — dropped`); return null; }
      const x = fixDim(b.table, b.x);
      if (!x) { warnings.push(`slide "${sid}": chart x "${b.x.col}" not in ${b.table} — dropped`); return null; }
      // Trend charts on a date column must bucket + order by time; default to month.
      if ((b.chartType === "line" || b.chartType === "area") && !x.timeGrain && resolve(b.table, x.col)?.type === "date") x.timeGrain = "month";
      let series = b.series.map((m) => fixMetric(b.table, m)).filter((m): m is Metric => !!m);
      if (!series.length) { warnings.push(`slide "${sid}": chart "${b.title ?? ""}" has no valid series — dropped`); return null; }
      if (b.chartType === "pie" && series.length > 1) series = series.slice(0, 1);
      return { ...b, x, series };
    }
    if (b.type === "table") {
      if (!idx.has(b.table)) { warnings.push(`slide "${sid}": table "${b.table}" unknown — dropped`); return null; }
      const columns = b.columns.map((c) => { const r = c.agg === "count" ? { name: c.col } : resolve(b.table, c.col); return r ? { ...c, col: r.name } : null; }).filter((c): c is typeof b.columns[number] => !!c);
      if (!columns.length) { warnings.push(`slide "${sid}": table has no valid columns — dropped`); return null; }
      const groupBy = (b.groupBy ?? []).map((g) => fixDim(b.table, g)).filter((g): g is Dimension => !!g);
      return { ...b, columns, groupBy };
    }
    if (b.type === "kpis") {
      const items = b.items.map((k) => {
        if (!idx.has(k.table)) return null;
        const m = fixMetric(k.table, k.metric);
        return m ? { ...k, metric: m } : null;
      }).filter((k): k is typeof b.items[number] => !!k);
      if (!items.length) { warnings.push(`slide "${sid}": no valid KPIs — dropped`); return null; }
      return { ...b, items };
    }
    return b; // heading / callout / note
  };

  const out = slides.map((s) => {
    const title = s.title.length > 90 ? s.title.slice(0, 90) + "…" : s.title;
    let blocks = s.blocks.map((b) => fixBlock(s.id, b)).filter((b): b is Block => !!b);
    let visuals = 0;
    blocks = blocks.filter((b) => {
      if (b.type === "chart" || b.type === "table" || b.type === "image") { visuals++; if (visuals > 4) { warnings.push(`slide "${s.id}": more than 4 visuals — kept the first 4`); return false; } }
      return true;
    });
    return { ...s, title, blocks };
  });

  return { slides: out, warnings };
}