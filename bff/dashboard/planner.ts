// bff/dashboard/planner.ts — the planning stage of the spec-driven pipeline. One
// structured Gemini call studies the data profile + the user's prompt (+ the CURRENT
// spec on edit turns) and emits a typed DashboardSpec. The model only chooses tables,
// columns, aggregations, and layout AS DATA — it never writes SQL or JSX. On an edit
// turn it receives the existing spec and returns a minimally-mutated version, which is
// what makes the conversation and the dashboard a single evolving artifact rather than
// two independent flows. Falls back to null on any failure (caller can degrade).
import type { Dataset } from "../../shared/types";
import type { DashboardSpec } from "../../shared/dashboard-spec";
import { callGemini, ORCHESTRATE_OPTS, type GenResult, type GenOptions } from "../aiflow";

export type PlannerRun = (system: string, user: string, opts?: GenOptions) => Promise<GenResult>;
const PLAN_TIMEOUT_MS = Number(process.env.DASHBOARD_PLANNER_TIMEOUT_MS ?? 20000);

// Compact OpenAPI-subset schema. Widgets are a single permissive object (Gemini does
// not handle discriminated unions well); we normalize/validate in code afterwards.
const FILTER_ITEM = { type: "object", properties: { col: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "between", "contains", "not_null", "is_null"] }, value: { type: "string", description: "literal value; pass numbers as strings. For contains: the substring to search" }, values: { type: "array", items: { type: "string" }, description: "for in/not_in: the list; for between: exactly [lo, hi]" } }, required: ["col", "op"] };
const BASE_METRIC = {
  type: "object",
  properties: { col: { type: "string" }, agg: { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "median"] }, where: { type: "array", items: FILTER_ITEM } },
  required: ["col", "agg"],
};
const METRIC = {
  type: "object",
  properties: {
    col: { type: "string" },
    agg: { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "median"] },
    label: { type: "string" },
    format: { type: "string", enum: ["number", "compact", "percent", "currency", "hours", "days"] },
    expr: { type: "object", description: "derived metric: ratio=num/den, pct=num/den*100, diff=num-den — use for rates and percentages; never format a plain sum as percent", properties: { op: { type: "string", enum: ["ratio", "pct", "diff"] }, num: BASE_METRIC, den: BASE_METRIC }, required: ["op", "num", "den"] }, compare: { type: "object", description: "A4: adds a vs-previous-period delta chip. ONLY when a real temporal column exists; grain should suit the data span (month for a year of data). Windows are computed from the data, never by you.", properties: { grain: { type: "string", enum: ["day", "week", "month", "quarter", "year"] }, dateCol: { type: "string" } }, required: ["grain", "dateCol"] },
  },
  required: ["col", "agg"],
};
const DIMENSION = {
  type: "object",
  properties: {
    col: { type: "string" },
    timeGrain: { type: "string", enum: ["day", "week", "month", "quarter", "year"] },
    label: { type: "string" },
  },
  required: ["col"],
};
const WIDGET = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["kpi", "line", "bar", "area", "pie", "donut", "table"] },
    title: { type: "string" },
    subtitle: { type: "string" },
    table: { type: "string" },
    width: { type: "string", enum: ["quarter", "third", "half", "full"] },
    metric: METRIC,
    x: DIMENSION,
    series: { type: "array", items: METRIC },
    columns: { type: "array", items: { type: "object", properties: { col: { type: "string" }, label: { type: "string" }, agg: { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "median"] }, format: { type: "string", enum: ["number", "percent", "currency", "hours", "days", "compact"] } }, required: ["col"] } },
    groupBy: { type: "array", items: DIMENSION },
    limit: { type: "integer" },
    sort: { type: "object", properties: { by: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } } },
    join: { type: "object", description: "ONE lookup join to a related table — allowed ONLY for relationships listed as VERIFIED in the profile digest. on = [baseColumn, referencedColumn].", properties: { table: { type: "string" }, on: { type: "array", items: { type: "string" } } }, required: ["table", "on"] },
    filters: { type: "array", description: "scope this widget to a SUBSET of rows ('only open tickets'). Use EXACT observed literals.", items: FILTER_ITEM },
  },
  required: ["id", "kind", "title", "table"],
};
export const DASHBOARD_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "integer" },
    meta: {
      type: "object",
      properties: {
        title: { type: "string" }, subtitle: { type: "string" }, insight: { type: "string" },
        audience: { type: "string" }, theme: { type: "string", enum: ["light", "dark"] },
        accent: { type: "string", description: "Primary accent color as hex, e.g. #0d9488." },
        chartPalette: { type: "array", items: { type: "string" }, description: "Chart series colors as hex values." },
      },
      required: ["title"],
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" }, widgets: { type: "array", items: WIDGET } },
        required: ["id", "widgets"],
      },
    },
  },
  required: ["meta", "sections"],
};

const REWRITE_SYSTEM = `You are the query-rewriting stage of a dashboard generator. Given a data profile and the user's (often brief) request, expand it into a DETAILED analytical directive for the dashboard planner: which measures to aggregate (exact column names, sum/avg/count), which dimensions to break them down by, which time grain for trends, which comparisons or rankings matter, and what the 3-6 headline KPIs should be. Be concrete and grounded ONLY in columns that exist. If an existing dashboard is described, scope the directive to the requested change. Output 3-8 plain sentences, no JSON, no markdown, no preamble.`;

export interface RewriteInput { datasets: Dataset[]; userPrompt: string; currentSpec?: DashboardSpec }

/** The query rewriter: turns a brief ask ("sales dashboard", "add customer stuff")
 *  into concrete, schema-grounded modeling instructions. Null on any failure —
 *  the raw prompt then proceeds alone; this stage may improve, never block. */
export async function rewritePrompt(input: RewriteInput, run: PlannerRun = callGemini, timeoutMs = 9000): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<string | null> => {
    try {
      const specCtx = input.currentSpec
        ? `\nEXISTING DASHBOARD: "${input.currentSpec.meta.title}" — widgets: ${input.currentSpec.sections.flatMap((x) => x.widgets ?? []).map((w: any) => `${w.kind}:${w.title ?? ""}`).join(", ")}`
        : "";
      const { text } = await run(REWRITE_SYSTEM, `DATA PROFILE:\n${schemaText(input.datasets)}${specCtx}\n\nUSER REQUEST: ${input.userPrompt}`, { temperature: 0.4 });
      const out = (text ?? "").trim();
      if (!out || out.length < 40 || out.length > 2500) return null;
      console.log(`[rewriter] ${out.slice(0, 90)}…`);
      return out;
    } catch (err) {
      console.warn(`[rewriter] failed -> raw prompt: ${(err as Error).message}`);
      return null;
    }
  })();
  return Promise.race([call, timeout]);
}

export const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

const SYSTEM = `You are the planning stage of a data-dashboard generator. You output a single JSON DashboardSpec and NOTHING else. You never write SQL, JSX, or prose.
STYLING: visual requests (colors, "make it teal/dark/vibrant", branding, mood) map to meta.theme ("light"/"dark"), meta.accent (one hex), and meta.chartPalette (hex[]). Honor them enthusiastically — pick tasteful concrete hex values yourself when the user names a color family.
HOUSE STYLE (always, unless the user explicitly asks otherwise):
- VIBRANT: always set meta.accent and a 5-6 color meta.chartPalette of saturated, energetic hex values (violet/cyan/amber/emerald/rose families) — never leave a dashboard on defaults, never choose washed-out grays.
- DENSE: this product favors compact, information-rich dashboards. Prefer "quarter" and "half" widths so rows pack tightly; use "full" only for tables. No filler widgets, no near-empty sections.
- COVERAGE: a dashboard MUST have at least 4 charts using at least 3 DIFFERENT chart types (bar/line/area/pie), each answering a different analytical question (composition, trend, ranking, comparison), and 3-6 KPI cards for the headline aggregates. Only when the data genuinely cannot support 4 meaningful charts may you go lower — never pad with duplicates.
EDIT TURNS (a currentSpec is provided): change ONLY what the user asked for and preserve every other field verbatim — a style request must not add, remove, or reshape widgets; a widget request must not reset the styling.

Rules:
- Use ONLY the tables and columns listed in the data profile. Never invent a column.
- Choose aggregations that fit the column type (sum/avg/min/max/median need numeric columns; count/count_distinct work on anything).
- For time series, set x.timeGrain (week or month is usually best for long histories) on a real date/timestamp column.
- Widget kinds: kpi (one number), line/area (trends over time), bar (comparisons/breakdowns), pie/donut (share of a single measure over a low-cardinality category — one series only), table (detail rows or grouped aggregates).
- Give each widget a stable, unique id. KPIs go in the first section. Use width to lay out: kpi=quarter, charts=half, tables=full.
- Keep it focused and readable (a KPI strip plus 4-8 charts/tables is plenty). Do not exceed what the data supports.

On an EDIT turn you are given the CURRENT spec. Return the FULL updated spec, changing as little as possible: keep existing widget ids and untouched widgets exactly, and apply only what the user asked.
CONVERSATION AWARENESS (edit turns): when a CONVERSATION section is provided, resolve references through it — "the chart we added", "like before", "the same color as earlier", "no, the OTHER one" all point at things said or done in prior turns. When a SELECTED WIDGET is provided, that is the user's "this"/"that"/"it": apply the edit to that exact widget (match its id) unless the user clearly names a different one. Never reinterpret the whole dashboard because of a reference you cannot resolve — leave unclear things unchanged.
To show a SUBSET of rows ("only open tickets", "P1 only"), set widget.filters: [{col,op,value}] with EXACT observed literals — never bake the subset into the title alone. Ops beyond equality: contains (substring match, value = the text), in/not_in (values = the list), between (values = exactly [lo, hi] — dates as YYYY-MM-DD). To show a column from a RELATED table (e.g. tickets by status NAME when tickets only carries status_id), set widget.join = {table, on:[baseCol, refCol]} — prefer relationships the digest lists as VERIFIED; a plausible unlisted join is measured against the live data and kept only if it proves out.
`;

function schemaText(datasets: Dataset[]): string {
  return datasets.map((d) => {
    const cols = d.profile.columns.map((c) => `${c.name}:${c.type}`);
    return `Table "${d.tableName}" (${d.profile.rowCount} rows): ${cols.join(", ")}`;
  }).join("\n");
}

function buildUserPrompt(datasets: Dataset[], userPrompt: string, currentSpec?: DashboardSpec, styleHints?: string, directive?: string, chatContext?: string, selectedWidget?: { id?: string; title?: string }): string {
  const parts = [
    "DATA PROFILE:",
    schemaText(datasets),
    "",
  ];
  if (chatContext) {
    parts.push("CONVERSATION (recent turns + decisions — resolve references like \"before\"/\"that one\" against this):");
    parts.push(chatContext);
    parts.push("");
  }
  if (selectedWidget && (selectedWidget.id || selectedWidget.title)) {
    parts.push(`SELECTED WIDGET (the user clicked this in the preview — it is what \"this\"/\"that\"/\"it\" refers to): id=${selectedWidget.id ?? "?"} title=\"${selectedWidget.title ?? ""}\"`);
    parts.push("");
  }
  if (styleHints) {
    parts.push("VISUAL DIRECTION (from the planning stage — realize it via meta.theme/accent/chartPalette):");
    parts.push(styleHints);
    parts.push("");
  }
  if (directive) {
    parts.push("ANALYTICAL DIRECTIVE (from the query-rewriting stage — realize these breakdowns as concrete widgets):");
    parts.push(directive);
    parts.push("");
  }
  if (currentSpec) {
    parts.push("CURRENT SPEC (edit this — return the full updated spec):");
    parts.push(JSON.stringify(currentSpec));
    parts.push("");
    parts.push("USER EDIT:");
  } else {
    parts.push("USER REQUEST:");
  }
  parts.push(userPrompt);
  return parts.join("\n");
}

function stripFences(t: string): string {
  return t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

/** Normalize loosely-typed model JSON into a DashboardSpec shape. Validation/repair
 *  against the real profile happens later in compileSpec(). */
function coerce(parsed: any): DashboardSpec | null {
  if (!parsed || !parsed.meta || !Array.isArray(parsed.sections)) return null;
  const sections = parsed.sections
    .filter((s: any) => s && Array.isArray(s.widgets))
    .map((s: any, si: number) => ({
      id: String(s.id ?? `s${si}`),
      title: s.title ? String(s.title) : undefined,
      widgets: s.widgets.filter((w: any) => w && w.kind && w.table && w.id),
    }))
    .filter((s: any) => s.widgets.length);
  if (!sections.length) return null;
  return {
    version: 1,
    meta: {
      title: String(parsed.meta.title ?? "Dashboard"), subtitle: parsed.meta.subtitle, audience: parsed.meta.audience, insight: typeof parsed.meta.insight === "string" && parsed.meta.insight.trim() ? parsed.meta.insight : undefined,
      theme: parsed.meta.theme === "dark" ? "dark" : "light",
      // Style fields are sanitized deterministically — a bad hex silently drops.
      accent: HEX_RE.test(String(parsed.meta.accent ?? "")) ? String(parsed.meta.accent) : undefined,
      chartPalette: Array.isArray(parsed.meta.chartPalette)
        ? parsed.meta.chartPalette.map(String).filter((c: string) => HEX_RE.test(c)).slice(0, 8)
        : undefined,
    },
    sections,
  };
}

export interface PlanSpecInput { datasets: Dataset[]; userPrompt: string; currentSpec?: DashboardSpec; styleHints?: string; directive?: string; chatContext?: string; selectedWidget?: { id?: string; title?: string } }

/** Plan (or edit) a DashboardSpec. Never throws; returns null on failure/timeout. */
export async function planSpec(input: PlanSpecInput, run: PlannerRun = callGemini, timeoutMs = PLAN_TIMEOUT_MS): Promise<DashboardSpec | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<DashboardSpec | null> => {
    try {
      const { text } = await run(SYSTEM, buildUserPrompt(input.datasets, input.userPrompt, input.currentSpec, input.styleHints, input.directive, input.chatContext, input.selectedWidget), { ...ORCHESTRATE_OPTS, responseSchema: DASHBOARD_SCHEMA });
      const spec = coerce(JSON.parse(stripFences(text)));
      if (spec) console.log(`[dashboard-planner] spec: "${spec.meta.title}" with ${spec.sections.reduce((n, s) => n + s.widgets.length, 0)} widget(s)`);
      else console.warn("[dashboard-planner] model returned no usable spec");
      return spec;
    } catch (err) {
      console.warn(`[dashboard-planner] failed: ${(err as Error).message}`);
      return null;
    }
  })();
  return Promise.race([call, timeout]);
}