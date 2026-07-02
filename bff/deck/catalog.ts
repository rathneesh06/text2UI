// bff/deck/catalog.ts — the Semantic Modeling Service. Deterministically turns the data
// profile into a Metric/Entity Catalog: entities (tables), measures (numeric columns with
// a sensible default aggregation + value format inferred from the name), and dimensions
// (categoricals + time columns), each with a human label. Every entity also gets a record
// count measure. This is pure + cached; no LLM.
import type { Dataset } from "../../shared/types";
import type { Agg, ValueFormat } from "../../shared/dashboard-spec";
import type { MetricCatalog, CatalogMeasure, CatalogDimension, CatalogEntity } from "../../shared/catalog";

const NUMERIC = new Set(["integer", "number"]);
const isId = (n: string) => /(^id$|_id$|^id_|guid|uuid)/i.test(n);

export function prettyLabel(col: string): string {
  const s = col.replace(/[_\-]+/g, " ").replace(/\bid\b/i, "").trim();
  return s.split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ").trim() || col;
}

function formatFor(col: string): ValueFormat | undefined {
  const s = col.toLowerCase();
  if (/(revenue|sales|amount|price|cost|profit|gmv|arr|mrr|spend|value|income|budget|margin)/.test(s)) return "currency";
  if (/(percent|pct|rate|ratio|share|attainment|utilization)/.test(s)) return "percent";
  if (/(hours|hrs|_h$|duration|tat|resolution)/.test(s)) return "hours";
  if (/(days|_d$|age)/.test(s)) return "days";
  return undefined;
}

function defaultAggFor(col: string): Agg {
  const s = col.toLowerCase();
  if (/(percent|pct|rate|ratio|share|avg|average|mean|score|attainment|utilization)/.test(s)) return "avg";
  return "sum";
}

export function buildCatalog(datasets: Dataset[]): MetricCatalog {
  const measures: CatalogMeasure[] = [];
  const dimensions: CatalogDimension[] = [];
  const entities: CatalogEntity[] = [];

  for (const d of datasets) {
    const mIds: string[] = [];
    const dIds: string[] = [];
    const colOf = new Map(d.profile.columns.map((c) => [c.name, c]));

    // record-count measure (always available, works on any table)
    const countId = `${d.tableName}.__count`;
    measures.push({ id: countId, table: d.tableName, col: "*", label: `Total ${prettyLabel(d.tableName)}`, defaultAgg: "count", format: "compact" });
    mIds.push(countId);

    for (const c of d.profile.columns) {
      if (NUMERIC.has(c.type) && !isId(c.name)) {
        const id = `${d.tableName}.${c.name}`;
        measures.push({ id, table: d.tableName, col: c.name, label: prettyLabel(c.name), defaultAgg: defaultAggFor(c.name), format: formatFor(c.name),
          ...(typeof c.min === "number" ? { min: c.min } : {}), ...(typeof c.max === "number" ? { max: c.max } : {}), ...(typeof c.avg === "number" ? { avg: c.avg } : {}) });
        mIds.push(id);
      } else if (c.type === "date") {
        const id = `${d.tableName}.${c.name}`;
        dimensions.push({ id, table: d.tableName, col: c.name, label: prettyLabel(c.name), kind: "time" });
        dIds.push(id);
      } else if (!NUMERIC.has(c.type) && (c.uniqueCount ?? 999) <= 50) {
        const id = `${d.tableName}.${c.name}`;
        dimensions.push({ id, table: d.tableName, col: c.name, label: prettyLabel(c.name), kind: "category", cardinality: c.uniqueCount,
          ...(c.topValues?.length ? { topValues: c.topValues.map((t) => t.value) } : {}) });
        dIds.push(id);
      }
    }
    entities.push({ table: d.tableName, label: prettyLabel(d.tableName), rowCount: d.profile.rowCount, measureIds: mIds, dimensionIds: dIds });
  }

  return { entities, measures, dimensions };
}

/** Compact catalog rendering for planner prompts — governed vocabulary, not raw columns. */
export function catalogText(cat: MetricCatalog): string {
  const fmtNum = (n: number) => Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100);
  return cat.entities.map((e) => {
    const ms = cat.measures.filter((m) => m.table === e.table).map((m) => {
      const range = m.min != null && m.max != null ? `, range ${fmtNum(m.min)}–${fmtNum(m.max)}${m.avg != null ? ` avg ${fmtNum(m.avg)}` : ""}` : "";
      return `${m.label} [${m.col === "*" ? "count" : m.defaultAgg + "(" + m.col + ")"}${m.format ? ", " + m.format : ""}${range}]`;
    });
    const cds = cat.dimensions.filter((d) => d.table === e.table && d.kind === "category").map((d) => `${d.label} (${d.col}${d.topValues?.length ? ": " + d.topValues.slice(0, 4).map(String).join("/") : ""})`);
    const tds = cat.dimensions.filter((d) => d.table === e.table && d.kind === "time").map((d) => `${d.label} (${d.col})`);
    return [
      `Entity "${e.table}" — ${e.rowCount.toLocaleString()} rows`,
      `  measures: ${ms.join(", ") || "(none)"}`,
      `  breakdowns: ${cds.join(", ") || "(none)"}`,
      `  time: ${tds.join(", ") || "(none)"}`,
    ].join("\n");
  }).join("\n\n");
}