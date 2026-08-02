// bff/datasources/semantic.ts — the generic Semantic Model layer.
//
// The design doc's Semantic Model Service exists in this repo already — as
// sources/model.ts, HANDWRITTEN for one helpdesk schema (curated views, human
// names, derived measures). It proves the value and generalizes to nothing.
// This module derives the same kind of planner-facing business abstraction for
// ANY connected source, deterministically, from what introspection and
// profiling already produce:
//
//   entities            one per table, with a human name and role guess
//   measures/dimensions/temporals   from the enhancement layer's role classifier
//   join candidates     FK-style name matching across tables, with confidence —
//                       candidates, never asserted facts
//   CANDIDATE METRICS   named, typed, expression-bearing metric suggestions
//                       (total_revenue = sum(orders.revenue), …)
//
// The candidate tier is the cold-start answer the doc lacks: a fresh datasource
// has no approved catalog, so "constrain the planner to approved metrics" plans
// nothing. Candidates are TRUSTED ENOUGH TO PLAN WITH, marked as unapproved, and
// individually promotable later without changing this layer.
//
// Deterministic by design — no model call, so it can never fail, block, or
// hallucinate a metric the schema can't support.
import type { Dataset } from "../../shared/types";
import { classifySchema, type RoledColumn } from "../dashboard/enhance";
import type { Agg, ValueFormat, TimeGrain } from "../../shared/dashboard-spec";

export interface SemanticEntity {
  table: string;
  /** human name: "my_tickets_sos" → "tickets" */
  name: string;
  rowCount: number;
  /** fact = has measures/temporals; lookup = small, id+label shaped */
  role: "fact" | "lookup" | "unknown";
}

export interface JoinCandidate {
  leftTable: string; leftCol: string;
  rightTable: string; rightCol: string;
  confidence: "high" | "medium";
  reason: string;
}

export interface CandidateMetric {
  id: string;
  title: string;
  table: string;
  agg: Agg;
  col: string;
  format?: ValueFormat;
  /** for rate-style metrics over time */
  grain?: TimeGrain;
  trust: "candidate" | "approved";
}

export interface SemanticModel {
  entities: SemanticEntity[];
  measures: RoledColumn[];
  dimensions: RoledColumn[];
  temporals: RoledColumn[];
  joins: JoinCandidate[];
  metrics: CandidateMetric[];
}

// ---- humanization ------------------------------------------------------------------

const TABLE_NOISE = /^(my_|tbl_|t_|dim_|fact_|stg_|raw_)|(_sos|_tbl|_table|_v\d*)$/gi;
const CURRENCY_HINT = /(price|amount|revenue|cost|total|fee|charge|payment|salary|spend|budget)/i;
const PERCENT_HINT = /(rate|ratio|pct|percent|share)$/i;
const DURATION_HINT = /(hours?|_hrs?|minutes?|_mins?|duration|elapsed|age)/i;

export function humanizeName(raw: string): string {
  return raw.replace(TABLE_NOISE, "").replace(/__+/g, "_").replace(/_/g, " ").trim().toLowerCase() || raw;
}

export function guessFormat(col: string): ValueFormat | undefined {
  if (CURRENCY_HINT.test(col)) return "currency";
  if (PERCENT_HINT.test(col)) return "percent";
  if (DURATION_HINT.test(col)) return "hours";
  return undefined;
}

// ---- entities ----------------------------------------------------------------------

/** Real-world id naming often skips the underscore ("statusid", "priorityid").
 *  The role classifier's stricter pattern misses those, so a fully-unique
 *  integer named like this would masquerade as a measure — and a tiny lookup
 *  table would masquerade as a fact. Caught here, in the semantic layer, so the
 *  battle-tested classifier itself stays untouched. */
export function isIdLike(name: string, uniqueCount: number, rowCount: number): boolean {
  if (!/(^|_)(id|uuid|guid|key|code)$|^[a-z]+(id|key)$/i.test(name)) return false;
  return rowCount > 0 && uniqueCount >= rowCount * 0.9;
}

/** Measures minus id-masquerades — what the metric tier should aggregate.
 *
 *  Exported because the dashboard agents' deterministic fallbacks need exactly
 *  this filter: without it they summed primary keys and shipped KPIs reading
 *  "TOTAL ITILTICKETID 3.3B". One definition, used everywhere — a second ID
 *  heuristic would drift from this one and reintroduce the bug on whichever
 *  path was not updated. */
export function realMeasures(datasets: Dataset[], measures: RoledColumn[]): RoledColumn[] {
  const rowsOf = new Map(datasets.map((d) => [d.tableName, d.profile.rowCount]));
  return measures.filter((m) => !isIdLike(m.col.name, m.col.uniqueCount, rowsOf.get(m.table) ?? 0));
}

function classifyEntity(d: Dataset, hasMeasure: boolean, hasTemporal: boolean): SemanticEntity["role"] {
  const cols = d.profile.columns;
  if (hasTemporal || hasMeasure) return "fact";
  // lookup shape: small, and mostly id + label columns
  if (d.profile.rowCount <= 2000 && cols.length <= 6) return "lookup";
  return "unknown";
}

// ---- join candidates (FK-style name matching, confidence-tagged) --------------------

const ID_COL = /^(.*?)_?(id|key|code)$/i;

export function joinCandidates(datasets: Dataset[]): JoinCandidate[] {
  const out: JoinCandidate[] = [];
  const seen = new Set<string>();
  const byTable = new Map(datasets.map((d) => [d.tableName, d]));
  for (const d of datasets) {
    for (const c of d.profile.columns) {
      const m = ID_COL.exec(c.name);
      if (!m || !m[1]) continue;             // bare "id" columns are targets, not sources
      const stem = m[1].toLowerCase();
      for (const [otherName, other] of byTable) {
        if (otherName === d.tableName) continue;
        const otherHuman = humanizeName(otherName).replace(/\s/g, "");
        const stemFlat = stem.replace(/_/g, "");
        // orders.customer_id → customers.(customer_id | id)
        const matchesTable = otherHuman === stemFlat || otherHuman === stemFlat + "s" || otherHuman + "s" === stemFlat
          || otherHuman.endsWith(stemFlat) || stemFlat.endsWith(otherHuman.replace(/s$/, ""));
        if (!matchesTable) continue;
        const exact = other.profile.columns.find((oc) => oc.name.toLowerCase() === c.name.toLowerCase());
        const bareId = other.profile.columns.find((oc) => /^(id|.*_?id)$/i.test(oc.name) && ID_COL.exec(oc.name)?.[1]?.toLowerCase() !== stem ? false : /^id$/i.test(oc.name));
        const target = exact ?? bareId;
        if (!target) continue;
        const key = [d.tableName, c.name, otherName, target.name].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          leftTable: d.tableName, leftCol: c.name,
          rightTable: otherName, rightCol: target.name,
          confidence: exact ? "high" : "medium",
          reason: exact ? `column name "${c.name}" appears in both tables` : `"${c.name}" matches table "${otherName}" with an id column`,
        });
      }
    }
  }
  return out.slice(0, 20);
}

// ---- candidate metrics --------------------------------------------------------------

const METRIC_CAP = 24;

export function candidateMetrics(datasets: Dataset[]): CandidateMetric[] {
  const roles = classifySchema(datasets);
  const measures = realMeasures(datasets, roles.measures);
  const out: CandidateMetric[] = [];
  const add = (m: Omit<CandidateMetric, "trust">) => {
    if (out.length < METRIC_CAP && !out.some((x) => x.id === m.id)) out.push({ ...m, trust: "candidate" });
  };
  for (const d of datasets) {
    const human = humanizeName(d.tableName);
    add({ id: `count_${d.tableName}`, title: `Total ${human}`, table: d.tableName, agg: "count", col: d.profile.columns[0]?.name ?? "*", format: "compact" });
  }
  for (const m of measures) {
    const f = guessFormat(m.col.name);
    add({ id: `sum_${m.table}_${m.col.name}`, title: `Total ${humanizeName(m.col.name)}`, table: m.table, agg: "sum", col: m.col.name, ...(f ? { format: f } : { format: "compact" }) });
    add({ id: `avg_${m.table}_${m.col.name}`, title: `Average ${humanizeName(m.col.name)}`, table: m.table, agg: "avg", col: m.col.name, ...(f ? { format: f } : {}) });
  }
  for (const i of roles.identifiers) {
    add({ id: `distinct_${i.table}_${i.col.name}`, title: `Distinct ${humanizeName(i.col.name)}`, table: i.table, agg: "count_distinct", col: i.col.name, format: "compact" });
  }
  for (const t of roles.temporals.slice(0, 2)) {
    const m = measures.find((x) => x.table === t.table);
    add({ id: `trend_${t.table}_${t.col.name}`, title: `${m ? humanizeName(m.col.name) : humanizeName(t.table)} per ${t.suggestedGrain ?? "month"}`, table: t.table, agg: m ? "sum" : "count", col: m ? m.col.name : t.col.name, grain: t.suggestedGrain ?? "month" });
  }
  return out;
}

// ---- the model + its planner-facing digest ------------------------------------------

export function buildSemanticModel(datasets: Dataset[]): SemanticModel {
  const roles = classifySchema(datasets);
  const measures = realMeasures(datasets, roles.measures);
  const entities: SemanticEntity[] = datasets.map((d) => ({
    table: d.tableName,
    name: humanizeName(d.tableName),
    rowCount: d.profile.rowCount,
    role: classifyEntity(d, measures.some((m) => m.table === d.tableName), roles.temporals.some((t) => t.table === d.tableName)),
  }));
  return {
    entities,
    measures,
    dimensions: roles.dimensions,
    temporals: roles.temporals,
    joins: joinCandidates(datasets),
    metrics: candidateMetrics(datasets),
  };
}

/** The digest injected into the enhancement layer: business concepts and a metric
 *  MENU the planner/agents can pick from — instead of raw column soup. All content
 *  here derives from schema STRUCTURE (never from data values or column comments),
 *  so a hostile database cannot inject instructions through this channel. */
export function semanticDigest(model: SemanticModel): string {
  const parts: string[] = [];
  const facts = model.entities.filter((e) => e.role === "fact");
  const lookups = model.entities.filter((e) => e.role === "lookup");
  parts.push(`SEMANTIC MODEL: ${model.entities.length} entities — facts: ${facts.map((e) => `${e.name} (${e.table}, ${e.rowCount} rows)`).join("; ") || "none"}${lookups.length ? `; lookups: ${lookups.map((e) => e.name).join(", ")}` : ""}.`);
  if (model.metrics.length) {
    parts.push("CANDIDATE METRICS (derived from the schema, unapproved — prefer these for KPIs and chart series, using the exact table/column/agg given):");
    parts.push(model.metrics.map((m) => `- ${m.title}: ${m.agg}(${m.table}.${m.col})${m.grain ? ` per ${m.grain}` : ""}${m.format ? ` [${m.format}]` : ""}`).join("\n"));
  }
  if (model.joins.length) {
    parts.push(`JOIN CANDIDATES (name-matched, unverified — single-table widgets are safer; if a breakdown truly needs a lookup title, these are the plausible paths): ${model.joins.map((j) => `${j.leftTable}.${j.leftCol} → ${j.rightTable}.${j.rightCol} (${j.confidence})`).join("; ")}.`);
  }
  return parts.join("\n");
}
