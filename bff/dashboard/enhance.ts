// bff/dashboard/enhance.ts — the Query Enhancement Layer.
//
// GUARANTEE: every dashboard turn gets a complete set of baseline instructions,
// no matter how small the data (one column) or how terse the prompt ("dashboard").
// The layer has two halves:
//   1. baselineInstructions() — DETERMINISTIC. Classifies every column into a role
//      (measure / dimension / temporal / identifier), digests the schema, and states
//      the house rules. This half can never fail, time out, or return null.
//   2. an optional model directive (analyst evidence > orchestrator brief > LLM
//      query rewrite) that ENRICHES the baseline but never replaces it.
// enhanceQuery() therefore always returns a non-null directive — the property the
// old pipeline lost (rewritePrompt failed soft to nothing, and was skipped entirely
// whenever a brief existed, so many builds reached the planner with no instructions).
import type { Dataset, ColumnProfile } from "../../shared/types";
import type { DashboardSpec, TimeGrain } from "../../shared/dashboard-spec";
import { rewritePrompt } from "./planner";

// ---------------------------------------------------------------------------
// Column-role classification (deterministic, profile-driven)
// ---------------------------------------------------------------------------

export type ColumnRole = "measure" | "temporal" | "dimension" | "identifier" | "text";

export interface RoledColumn {
  table: string;
  col: ColumnProfile;
  role: ColumnRole;
  /** for temporal columns: the grain a trend chart should default to */
  suggestedGrain?: TimeGrain;
}

const ID_HINT = /(^|_)(id|uuid|guid|key|code|number|no)$/i;

/** Classify one column from its profile. Pure and total — every column gets a role. */
export function classifyColumn(table: string, c: ColumnProfile, rowCount: number): RoledColumn {
  if (c.type === "date") return { table, col: c, role: "temporal", suggestedGrain: suggestGrain(c, rowCount) };
  if (c.type === "integer" || c.type === "number") {
    // A numeric column that is unique-per-row and *named* like a key is an id, not a measure.
    const idish = ID_HINT.test(c.name) && rowCount > 0 && c.uniqueCount >= rowCount * 0.9;
    return { table, col: c, role: idish ? "identifier" : "measure" };
  }
  if (c.type === "boolean") return { table, col: c, role: "dimension" };
  // strings: low cardinality → dimension; unique-ish → identifier; otherwise free text
  if (rowCount > 0 && c.uniqueCount >= rowCount * 0.9) return { table, col: c, role: "identifier" };
  if (c.uniqueCount <= Math.max(50, Math.ceil(rowCount * 0.2))) return { table, col: c, role: "dimension" };
  return { table, col: c, role: "text" };
}

function suggestGrain(c: ColumnProfile, rowCount: number): TimeGrain {
  // Best-effort span estimate from the profile's min/max; fall back on row count.
  const min = Date.parse(String(c.min ?? ""));
  const max = Date.parse(String(c.max ?? ""));
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
    const days = (max - min) / 86400000;
    if (days <= 45) return "day";
    if (days <= 200) return "week";
    if (days <= 1100) return "month";
    return "quarter";
  }
  return rowCount <= 500 ? "day" : "month";
}

export interface SchemaRoles {
  measures: RoledColumn[];
  temporals: RoledColumn[];
  dimensions: RoledColumn[];
  identifiers: RoledColumn[];
}

/** Classify every column of every table. Sorted so the strongest candidates come first. */
export function classifySchema(datasets: Dataset[]): SchemaRoles {
  const all: RoledColumn[] = [];
  for (const d of datasets) {
    for (const c of d.profile.columns) all.push(classifyColumn(d.tableName, c, d.profile.rowCount));
  }
  const dims = all.filter((r) => r.role === "dimension")
    // Chart-friendliest dimensions first: enough categories to be interesting, few enough to plot.
    .sort((a, b) => scoreDim(a) - scoreDim(b));
  return {
    measures: all.filter((r) => r.role === "measure"),
    temporals: all.filter((r) => r.role === "temporal"),
    dimensions: dims,
    identifiers: all.filter((r) => r.role === "identifier"),
  };
}

const scoreDim = (r: RoledColumn) => {
  const u = r.col.uniqueCount;
  if (u >= 2 && u <= 12) return u;          // ideal for bar/pie
  if (u > 12 && u <= 30) return 20 + u;     // fine for a limited bar
  return 1000 + u;                          // last resort
};

// ---------------------------------------------------------------------------
// Baseline instructions — the half that can never be skipped
// ---------------------------------------------------------------------------

/** The house rules every build must follow. Stated once, injected everywhere. */
export const HOUSE_RULES = [
  "Use ONLY tables and columns that exist in the data profile; never invent one.",
  "Aggregations must fit the column type: sum/avg/min/max/median need numeric columns; count/count_distinct work on anything.",
  "Coverage: aim for 3-6 KPI cards plus at least 4 charts of at least 3 different types (bar/line/area/pie), each answering a different question (trend, ranking, composition, comparison) — scale down only when the data genuinely cannot support it, never pad with duplicates.",
  "Layout: KPIs first at quarter width, charts at half width, tables full width. Dense and information-rich; no filler widgets.",
  "Style: vibrant by default — a concrete hex accent and a 5-6 color saturated palette unless the user asks otherwise.",
  "Design language (executive-dashboard aesthetic): a punchy title with a one-line meta.subtitle describing the story of the data; short UPPERCASE-friendly KPI titles (e.g. 'Total tickets', 'Avg resolution') each with a brief subtitle giving context (e.g. 'All historical records', 'For closed tickets'); every chart gets a one-line subtitle explaining what it shows (e.g. 'Monthly ticket creation volume over entire history'); prefer varied, saturated per-category colors on breakdown bars; titles are human phrases, never column names.",
  "Trends use a real date/timestamp column with an explicit time grain; pie/donut only on a low-cardinality category with a single measure.",
].join(" ");

/** Deterministic, always-present instructions grounded in THIS schema. */
export function baselineInstructions(datasets: Dataset[], userPrompt: string, currentSpec?: DashboardSpec): string {
  const roles = classifySchema(datasets);
  const parts: string[] = [];

  parts.push(`BASELINE INSTRUCTIONS (always apply): ${HOUSE_RULES}`);

  const li = (rs: RoledColumn[], f: (r: RoledColumn) => string) => rs.slice(0, 12).map(f).join(", ");
  if (roles.measures.length) parts.push(`Measures (numeric, aggregate with sum/avg): ${li(roles.measures, (r) => `${r.table}.${r.col.name}`)}.`);
  else parts.push("No numeric measures exist — KPIs and chart series must use count or count_distinct.");
  if (roles.temporals.length) parts.push(`Temporal columns for trends: ${li(roles.temporals, (r) => `${r.table}.${r.col.name} (grain: ${r.suggestedGrain})`)}.`);
  else parts.push("No temporal column exists — do NOT plan line/area trend charts; use bar/pie breakdowns instead.");
  if (roles.dimensions.length) parts.push(`Dimensions for breakdowns (cardinality in brackets): ${li(roles.dimensions, (r) => `${r.table}.${r.col.name} [${r.col.uniqueCount}]`)}.`);
  else parts.push("No low-cardinality dimension exists — favor KPIs, trends, and detail tables over categorical charts.");
  // OBSERVED VALUES — the single highest-leverage fact for correct conditional
  // metrics: filters and expr numerators must use these EXACT literals (the
  // "0.0% SLA attainment" class = the model guessing "met" when the data says
  // otherwise; equality on a guessed literal matches zero rows).
  const valueLines: string[] = [];
  for (const d of datasets) {
    for (const c of d.profile.columns) {
      if (!c.topValues?.length || c.type !== "string") continue;
      const total = c.topValues.reduce((n, t) => n + t.count, 0) || 1;
      const shown = c.topValues.slice(0, 8).map((t) => {
        const pctShare = Math.round((t.count / total) * 100);
        return pctShare >= 1 ? `"${String(t.value)}" (${pctShare}%)` : `"${String(t.value)}"`;
      });
      const more = c.topValues.length > 8 ? `, +${c.topValues.length - 8} more` : "";
      valueLines.push(`${d.tableName}.${c.name}: ${shown.join(", ")}${more}`);
      if (valueLines.length >= 14) break;
    }
    if (valueLines.length >= 14) break;
  }
  // A3: VERIFIED relationships — the ONLY joins the compiler will accept.
  const relLines: string[] = [];
  for (const d of datasets) {
    for (const fk of d.profile.foreignKeys ?? []) {
      relLines.push(`${d.tableName}.${fk.col} -> ${fk.refTable}.${fk.refCol} (${fk.verified})`);
      if (relLines.length >= 12) break;
    }
    if (relLines.length >= 12) break;
  }
  if (relLines.length) {
    parts.push(`VERIFIED RELATIONSHIPS (the ONLY allowed widget.join targets; join = {table: <right side's table>, on: [<left col>, <right col>]}): ${relLines.join("; ")}.`);
  }
  if (valueLines.length) {
    parts.push(`OBSERVED CATEGORY VALUES — conditions and expr numerators MUST use these exact literals (equality is case-sensitive; a guessed spelling matches zero rows): ${valueLines.join("; ")}.`);
  }
  if (roles.identifiers.length) parts.push(`Identifiers (use count_distinct for volume KPIs, never sum): ${li(roles.identifiers, (r) => `${r.table}.${r.col.name}`)}.`);

  const totalRows = datasets.reduce((n, d) => n + d.profile.rowCount, 0);
  const totalCols = datasets.reduce((n, d) => n + d.profile.columns.length, 0);
  parts.push(`Data size: ${datasets.length} table(s), ${totalCols} column(s), ${totalRows} row(s). These instructions apply in full regardless of size.`);

  if (currentSpec) {
    parts.push(`EDIT SCOPE: an existing dashboard ("${currentSpec.meta.title}") is being edited — change ONLY what the user asked; preserve every untouched widget, id, and style field verbatim.`);
  }
  if (!userPrompt.trim() || userPrompt.trim().split(/\s+/).length <= 3) {
    parts.push("The user's request is brief — make confident, complete choices yourself; do not reduce scope because the prompt is short.");
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// The full enhancement: baseline (always) + best available model directive
// ---------------------------------------------------------------------------

export interface EnhanceInput {
  datasets: Dataset[];
  userPrompt: string;
  currentSpec?: DashboardSpec;
  brief?: unknown;              // orchestrator brief (first turns)
  analystDirective?: string;    // text2SQL analyst-loop evidence pack (most grounded)
  /** disable the LLM rewrite (tests / offline) — baseline still applies */
  skipRewrite?: boolean;
  /** semantic-model digest (entities, candidate metrics, join candidates) */
  semanticDigest?: string;
}

export interface Enhancement {
  /** deterministic baseline — never empty */
  baseline: string;
  /** the enriching directive and where it came from */
  directive: string | null;
  directiveSource: "analyst" | "brief" | "rewriter" | "none";
  styleHints: string | null;
  /** baseline + directive, ready for the planner/agents. NEVER null, NEVER empty. */
  combined: string;
}

/** Flatten the orchestrator brief's analytical half (kpis + charts) into a directive. */
export function briefToAnalyticalDirective(brief: any): string | null {
  if (!brief || typeof brief !== "object") return null;
  const bits: string[] = [];
  if (Array.isArray(brief.kpis) && brief.kpis.length) bits.push(`Headline KPI cards: ${brief.kpis.join("; ")}.`);
  if (Array.isArray(brief.charts) && brief.charts.length) {
    const cs = brief.charts.map((c: any) => `${c?.type ?? "chart"} of ${c?.y ?? "?"} by ${c?.x ?? "?"}${c?.why ? ` — ${c.why}` : ""}`).join("; ");
    bits.push(`Charts: ${cs}.`);
  }
  if (typeof brief.enhancedPrompt === "string" && brief.enhancedPrompt.trim()) bits.push(brief.enhancedPrompt.trim());
  return bits.length ? bits.join(" ") : null;
}

/** Flatten the brief's visual half into a one-line style directive. */
export function briefToStyleHints(brief: any): string | null {
  if (!brief || typeof brief !== "object") return null;
  const bits: string[] = [];
  const p = brief.palette;
  if (p && typeof p === "object") {
    if (p.primary) bits.push(`primary ${p.primary}`);
    if (p.accent) bits.push(`accent ${p.accent}`);
    if (Array.isArray(p.neutrals) && p.neutrals.length) bits.push(`neutrals ${p.neutrals.join(" ")}`);
    if (p.vibe) bits.push(`vibe: ${p.vibe}`);
  }
  if (typeof brief.designDirection === "string" && brief.designDirection.trim()) bits.push(brief.designDirection.trim());
  return bits.length ? bits.join(" · ") : null;
}

/** Run the enhancement layer. Total: always resolves, always with a non-empty
 *  `combined`. The LLM rewrite is the only fallible part and it only ever ADDS. */
export async function enhanceQuery(input: EnhanceInput): Promise<Enhancement> {
  let baseline = baselineInstructions(input.datasets, input.userPrompt, input.currentSpec);
  // The semantic layer rides the baseline: business concepts and the candidate
  // metric menu are part of the always-on floor, not an optional extra.
  if (input.semanticDigest) baseline = `${baseline}\n\n${input.semanticDigest}`;
  const styleHints = briefToStyleHints(input.brief);

  let directive: string | null = null;
  let directiveSource: Enhancement["directiveSource"] = "none";
  const analyst = typeof input.analystDirective === "string" && input.analystDirective.trim() ? input.analystDirective.trim() : null;
  if (analyst) { directive = analyst; directiveSource = "analyst"; }
  else {
    const fromBrief = briefToAnalyticalDirective(input.brief);
    if (fromBrief) { directive = fromBrief; directiveSource = "brief"; }
    else if (!input.skipRewrite) {
      const rewritten = await rewritePrompt({
        datasets: input.datasets, userPrompt: input.userPrompt,
        ...(input.currentSpec ? { currentSpec: input.currentSpec } : {}),
      });
      if (rewritten) { directive = rewritten; directiveSource = "rewriter"; }
    }
  }

  // Directive FIRST (the specific ask), baseline after (the always-on floor). The
  // baseline is appended, never conditional — that is this layer's whole contract.
  const combined = directive ? `${directive}\n\n${baseline}` : baseline;
  console.log(`[enhance] baseline ${baseline.length} chars · directive: ${directiveSource}`);
  return { baseline, directive, directiveSource, styleHints, combined };
}
