// bff/dashboard/merge.ts — the assembler. Takes the specialist agents' harvest and
// merges it into one coherent DashboardSpec: dedupe overlapping proposals, apply the
// house coverage rules (KPI strip first; charts of several types; tables full-width),
// cap density, and set vibrant style defaults. Deterministic — no model call — so the
// step between "agents answered" and "spec exists" can never fail.
import type { Dataset } from "../../shared/types";
import type { DashboardSpec, Widget, ChartWidget, KpiWidget, TableWidget, Section } from "../../shared/dashboard-spec";
import type { AgentHarvest } from "./agents";

const MAX_KPIS = 6;
const MAX_CHARTS = 8;
const MAX_TABLES = 2;

export const DEFAULT_PALETTE = ["#7c3aed", "#06b6d4", "#f59e0b", "#10b981", "#f43f5e", "#3b82f6"];

/** A widget's analytical signature — two widgets with the same signature answer the
 *  same question, so only the first survives the merge. */
export function widgetSignature(w: Widget): string {
  if (w.kind === "kpi") return `kpi|${w.table}|${w.metric.agg}|${w.metric.col}`;
  if (w.kind === "table") return `table|${w.table}|${(w.groupBy ?? []).map((g) => g.col).join(",")}|${w.columns.map((c) => `${c.agg ?? "raw"}:${c.col}`).join(",")}`;
  const c = w as ChartWidget;
  // The FAMILY is part of the question: a bar (ranking) and a donut (composition)
  // over the same aggregate are two different reads, so both may live; two bars
  // over the same aggregate are one question asked twice, so one dies.
  const family = c.kind === "line" || c.kind === "area" ? "trend" : c.kind === "bar" ? "rank" : "composition";
  return `chart|${family}|${c.table}|${c.x.col}|${c.x.timeGrain ?? ""}|${c.series.map((s) => `${s.agg}:${s.col}`).join(",")}`;
}

function dedupe<T extends Widget>(widgets: T[], seen: Set<string>): T[] {
  const out: T[] = [];
  for (const w of widgets) {
    const sig = widgetSignature(w);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(w);
  }
  return out;
}

/** Deterministic title when nothing better exists: short prompts become the title,
 *  long ones fall back to the table names. */
export function deriveTitle(userPrompt: string, datasets: Dataset[]): string {
  const p = userPrompt.trim().replace(/\s+/g, " ");
  if (p && p.length <= 60 && !/[.?!].+/.test(p)) {
    const t = p.replace(/^(make|build|create|generate|show|give)( me)?( an?| the)? /i, "").trim();
    if (t) return t.charAt(0).toUpperCase() + t.slice(1);
  }
  const name = datasets[0]?.tableName ?? "Data";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} Dashboard`;
}

export interface MergeOptions { title?: string; theme?: "light" | "dark"; accent?: string; chartPalette?: string[] }

/** Assemble the harvest into a DashboardSpec. Never returns an empty spec if any
 *  agent produced anything at all. */
export function mergeHarvest(harvest: AgentHarvest, datasets: Dataset[], userPrompt: string, opts: MergeOptions = {}): DashboardSpec {
  const seen = new Set<string>();

  const kpis: KpiWidget[] = dedupe(harvest.kpis, seen).slice(0, MAX_KPIS);

  // Interleave chart families (trend, bar, composition) so the cap trims evenly and
  // the type-diversity rule survives: we never keep 4 bars and drop the only line.
  const families: ChartWidget[][] = [harvest.trends, harvest.bars, harvest.compositions].map((f) => dedupe(f, seen));
  const charts: ChartWidget[] = [];
  for (let i = 0; charts.length < MAX_CHARTS; i++) {
    let took = false;
    for (const fam of families) {
      if (fam[i] && charts.length < MAX_CHARTS) { charts.push(fam[i]); took = true; }
    }
    if (!took) break;
  }

  const tables: TableWidget[] = dedupe(harvest.tables, seen).slice(0, MAX_TABLES);

  const sections: Section[] = [];
  if (kpis.length) sections.push({ id: "s_kpis", title: "Key metrics", widgets: kpis });
  const trends = charts.filter((c) => c.kind === "line" || c.kind === "area");
  const breakdowns = charts.filter((c) => c.kind !== "line" && c.kind !== "area");
  if (trends.length) sections.push({ id: "s_trends", title: "Trends", widgets: trends });
  if (breakdowns.length) sections.push({ id: "s_breakdowns", title: "Breakdowns", widgets: breakdowns });
  if (tables.length) sections.push({ id: "s_details", title: "Details", widgets: tables });

  return {
    version: 1,
    meta: {
      title: opts.title ?? deriveTitle(userPrompt, datasets),
      theme: opts.theme ?? "light",
      accent: opts.accent ?? DEFAULT_PALETTE[0],
      chartPalette: opts.chartPalette?.length ? opts.chartPalette : DEFAULT_PALETTE,
    },
    sections,
  };
}
