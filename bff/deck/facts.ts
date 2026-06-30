// bff/deck/facts.ts — the Fact Extractor / evidence layer. Before any slide is planned,
// this derives presentation-worthy facts straight from the data: row counts, the most
// common values of low-cardinality dimensions, numeric ranges, and time spans. The
// planners are prompted with this evidence so the deck is grounded in what the data
// actually says (the doc's "communicable facts, not just dimensions and measures").
// All heavy lifting runs through an injected query function (server-side, deterministic);
// with no query function it degrades to a structural summary from the profile.
import type { Dataset } from "../../shared/types";
import { qid } from "../dashboard/sql";

export type QueryFn = (sql: string) => Promise<Record<string, unknown>[]>;

export interface DimensionFact { col: string; distinct: number; top: { value: string; count: number }[]; }
export interface MeasureFact { col: string; sum?: number; avg?: number; min?: number; max?: number; }
export interface TableEvidence {
  table: string;
  rowCount: number;
  dimensions: DimensionFact[];
  measures: MeasureFact[];
  timespan?: { col: string; min: string; max: string };
}
export interface EvidenceCatalog { tables: TableEvidence[]; }

const NUMERIC = new Set(["integer", "number"]);
const TEMPORAL = new Set(["date"]);
const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v));

export async function extractFacts(datasets: Dataset[], query?: QueryFn): Promise<EvidenceCatalog> {
  const tables: TableEvidence[] = [];

  for (const d of datasets) {
    const cols = d.profile.columns;
    const ev: TableEvidence = { table: d.tableName, rowCount: d.profile.rowCount, dimensions: [], measures: [] };

    // candidate dimensions: low-cardinality, non-numeric
    const dims = cols.filter((c) => !NUMERIC.has(c.type) && !TEMPORAL.has(c.type) && (c.uniqueCount ?? 99) <= 25).slice(0, 4);
    const measures = cols.filter((c) => NUMERIC.has(c.type)).slice(0, 4);
    const dateCol = cols.find((c) => TEMPORAL.has(c.type));

    if (query) {
      for (const c of dims) {
        try {
          const rows = await query(`SELECT ${qid(c.name)} AS v, count(*) AS n FROM ${qid(d.tableName)} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
          ev.dimensions.push({
            col: c.name,
            distinct: rows.length,
            top: rows.map((r) => ({ value: String(r.v ?? "—"), count: num(r.n) })),
          });
        } catch { /* skip */ }
      }
      for (const c of measures) {
        try {
          const [r] = await query(`SELECT sum(${qid(c.name)}) s, avg(${qid(c.name)}) a, min(${qid(c.name)}) mn, max(${qid(c.name)}) mx FROM ${qid(d.tableName)}`);
          if (r) ev.measures.push({ col: c.name, sum: num(r.s), avg: num(r.a), min: num(r.mn), max: num(r.mx) });
        } catch { /* skip */ }
      }
      if (dateCol) {
        try {
          const [r] = await query(`SELECT CAST(min(${qid(dateCol.name)}) AS VARCHAR) lo, CAST(max(${qid(dateCol.name)}) AS VARCHAR) hi FROM ${qid(d.tableName)}`);
          if (r && r.lo) ev.timespan = { col: dateCol.name, min: String(r.lo).slice(0, 10), max: String(r.hi).slice(0, 10) };
        } catch { /* skip */ }
      }
    } else {
      // no query fn — structural hints only
      ev.dimensions = dims.map((c) => ({ col: c.name, distinct: c.uniqueCount ?? 0, top: [] }));
      ev.measures = measures.map((c) => ({ col: c.name }));
      if (dateCol) ev.timespan = { col: dateCol.name, min: String(dateCol.min ?? ""), max: String(dateCol.max ?? "") };
    }
    tables.push(ev);
  }
  return { tables };
}

/** Compact text rendering of the evidence for planner prompts. */
export function evidenceText(cat: EvidenceCatalog): string {
  return cat.tables.map((t) => {
    const lines = [`Table "${t.table}" — ${t.rowCount.toLocaleString()} rows`];
    if (t.timespan) lines.push(`  time span (${t.timespan.col}): ${t.timespan.min} → ${t.timespan.max}`);
    for (const d of t.dimensions) {
      const top = d.top.length ? d.top.map((x) => `${x.value} (${x.count})`).join(", ") : "(values not sampled)";
      lines.push(`  by ${d.col} [${d.distinct} values]: ${top}`);
    }
    for (const m of t.measures) {
      if (m.avg !== undefined) lines.push(`  ${m.col}: sum ${Math.round(m.sum ?? 0).toLocaleString()}, avg ${(m.avg ?? 0).toFixed(1)}`);
      else lines.push(`  ${m.col}: numeric`);
    }
    return lines.join("\n");
  }).join("\n\n");
}