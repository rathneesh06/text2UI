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
const METRIC = {
  type: "object",
  properties: {
    col: { type: "string" },
    agg: { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "median"] },
    label: { type: "string" },
    format: { type: "string", enum: ["number", "compact", "percent", "currency", "hours", "days"] },
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
    columns: { type: "array", items: { type: "object", properties: { col: { type: "string" }, label: { type: "string" }, agg: { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "median"] } }, required: ["col"] } },
    groupBy: { type: "array", items: DIMENSION },
    limit: { type: "integer" },
    sort: { type: "object", properties: { by: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } } },
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
        title: { type: "string" }, subtitle: { type: "string" },
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

export const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

const SYSTEM = `You are the planning stage of a data-dashboard generator. You output a single JSON DashboardSpec and NOTHING else. You never write SQL, JSX, or prose.
STYLING: visual requests (colors, "make it teal/dark/vibrant", branding, mood) map to meta.theme ("light"/"dark"), meta.accent (one hex), and meta.chartPalette (hex[]). Honor them enthusiastically — pick tasteful concrete hex values yourself when the user names a color family.
EDIT TURNS (a currentSpec is provided): change ONLY what the user asked for and preserve every other field verbatim — a style request must not add, remove, or reshape widgets; a widget request must not reset the styling.

Rules:
- Use ONLY the tables and columns listed in the data profile. Never invent a column.
- Choose aggregations that fit the column type (sum/avg/min/max/median need numeric columns; count/count_distinct work on anything).
- For time series, set x.timeGrain (week or month is usually best for long histories) on a real date/timestamp column.
- Widget kinds: kpi (one number), line/area (trends over time), bar (comparisons/breakdowns), pie/donut (share of a single measure over a low-cardinality category — one series only), table (detail rows or grouped aggregates).
- Give each widget a stable, unique id. KPIs go in the first section. Use width to lay out: kpi=quarter, charts=half, tables=full.
- Keep it focused and readable (a KPI strip plus 4-8 charts/tables is plenty). Do not exceed what the data supports.

On an EDIT turn you are given the CURRENT spec. Return the FULL updated spec, changing as little as possible: keep existing widget ids and untouched widgets exactly, and apply only what the user asked.`;

function schemaText(datasets: Dataset[]): string {
  return datasets.map((d) => {
    const cols = d.profile.columns.map((c) => `${c.name}:${c.type}`);
    return `Table "${d.tableName}" (${d.profile.rowCount} rows): ${cols.join(", ")}`;
  }).join("\n");
}

function buildUserPrompt(datasets: Dataset[], userPrompt: string, currentSpec?: DashboardSpec, styleHints?: string): string {
  const parts = [
    "DATA PROFILE:",
    schemaText(datasets),
    "",
  ];
  if (styleHints) {
    parts.push("VISUAL DIRECTION (from the planning stage — realize it via meta.theme/accent/chartPalette):");
    parts.push(styleHints);
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
      title: String(parsed.meta.title ?? "Dashboard"), subtitle: parsed.meta.subtitle, audience: parsed.meta.audience,
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

export interface PlanSpecInput { datasets: Dataset[]; userPrompt: string; currentSpec?: DashboardSpec; styleHints?: string }

/** Plan (or edit) a DashboardSpec. Never throws; returns null on failure/timeout. */
export async function planSpec(input: PlanSpecInput, run: PlannerRun = callGemini, timeoutMs = PLAN_TIMEOUT_MS): Promise<DashboardSpec | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<DashboardSpec | null> => {
    try {
      const { text } = await run(SYSTEM, buildUserPrompt(input.datasets, input.userPrompt, input.currentSpec, input.styleHints), { ...ORCHESTRATE_OPTS, responseSchema: DASHBOARD_SCHEMA });
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