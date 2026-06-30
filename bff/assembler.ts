// assembler.ts — pipeline stage 2 (SERVER). Builds the { system_prompt, user_prompt }
// pair for the model. Lives in bff/ so the system prompt never reaches the browser.
import type { DataProfile, ColumnProfile, Dataset, AssembleInput } from "../shared/types";
import { buildEnrichment } from "./domain";
import { exemplarBlock } from "./exemplars";
import { CRAFT_FLOOR, LAYOUT_FLOOR, designBlock } from "./design";
import { diagnose } from "./heal";

// Date/time function vocabulary differs per engine; the contracts carry a
// __DATE_FNS__ token that assemble() fills from the active dialect.
const DATE_FNS: Record<"duckdb" | "postgres", string> = {
  duckdb: "strftime(col, '%Y-%m') for month buckets; also date_trunc('month', col), year(col), month(col)",
  postgres: "to_char(col, 'YYYY-MM') for month buckets; also date_trunc('month', col), EXTRACT(YEAR FROM col)",
};

function describeColumn(c: ColumnProfile): string {
  const bits = [`${c.name} (${c.type}`];
  if (c.nullable) bits.push(", nullable");
  if (c.min !== undefined) bits.push(`, range ${c.min}..${c.max}`);
  bits.push(`, ${c.uniqueCount} distinct`);
  const ex = c.sampleValues.slice(0, 3).map((v) => JSON.stringify(v)).join(", ");
  return `${bits.join("")}; e.g. ${ex})`;
}
function schemaText(tableName: string, p: DataProfile): string {
  const cols = p.columns.map((c) => `  - ${describeColumn(c)}`).join("\n");
  return `Table "${tableName}" — ${p.rowCount} rows, from ${p.source.filename}\nColumns:\n${cols}\nSample rows: ${JSON.stringify(p.sampleRows)}`;
}

const RUNTIME_CONTRACT_INLINE = `
You generate a single-page React app that runs in a browser sandbox.

Import ONLY from these — nothing else is installed, and any other import will be undefined at runtime:
- "react" (React 18 with hooks).
- "recharts" — chart primitives ONLY, e.g. ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend. recharts has NO Card, Grid, Box, or other layout/UI components.
- "lucide-react" — icons (e.g. import { TrendingUp, Users, DollarSign, Filter } from "lucide-react"). Use them in KPI cards, section headers, and empty states.
- "./data" exposing:
    query(sql: string): Promise<Record<string, unknown>[]>  // run SQL (DuckDB) over the table(s) listed below
    rows: Record<string, unknown>[]   // convenience: the full first table, already loaded and correctly typed
    tables: Record<string, Record<string, unknown>[]>  // every dataset, keyed by table name

- "./selection" exposing:
    selectFeature(payload: object): void  // call from click handlers when the user selects a chart, table, or KPI card
      Example payload: { title, type, tableName, description, query }
      Use this in every interactive visual element so the host app can inspect clicks.

Do NOT import any other package, and do NOT import or create CSS files — Tailwind CSS is loaded globally and is the ONLY styling mechanism.
Do NOT declare or assign to browser globals or reserved names such as window, document, event, message, name, status, or location.

Rules:
- Read data ONLY through "./data". Never hardcode the rows.
- Query each dataset by its exact table name shown below (quote names containing special characters). Use lowercase SQL aliases.
- Respect column types from the schema. DATE/TIMESTAMP columns are real temporal types, NOT strings: never use string functions (SUBSTR, LEFT, RIGHT, LIKE) on them. Use __DATE_FNS__. Cast with CAST(col AS VARCHAR) only if you genuinely need text.
- Default-export a React component named App.
- Build layout, KPI cards, and tables with plain HTML elements styled via Tailwind utility classes (className) — never with recharts components, never with inline style objects.
- You may write TypeScript or plain JavaScript; the entry file is App.tsx.
- Handle empty/loading/error states.
- Keep it to as few files as possible (ideally one App.tsx).

Design system — follow this on every generation (the user's prompt chooses WHAT to build; this defines HOW it must look):
- Persona: you are a senior product designer-engineer; the result must look like a polished SaaS product, not a demo.
- Canvas: min-h-screen bg-slate-50 text-slate-900, font-sans. Content inside max-w-7xl mx-auto p-6 md:p-8.
- Cards: bg-white rounded-xl border border-slate-200 shadow-sm p-6. Consistent gap-6 between cards. Never nest cards.
- Hierarchy: one page title (text-2xl font-semibold tracking-tight) with a one-line text-sm text-slate-500 subtitle; section titles text-sm font-medium text-slate-700; KPI values text-3xl font-semibold tabular-nums; KPI labels text-xs font-medium uppercase tracking-wide text-slate-500.
- Color discipline: slate neutrals everywhere + exactly ONE accent color family (indigo-600 and its shades) for emphasis, active states, and primary chart series. Green (emerald-600)/red (rose-600) ONLY for positive/negative deltas. Never rainbow palettes; for multi-series charts use indigo-600, indigo-400, slate-400, slate-300.
- KPI cards: icon in a w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 container (lucide, size 20), label, value, and a small delta line when meaningful.
- Charts: wrap in a card with a title; ResponsiveContainer height 200-240; CartesianGrid stroke="#e2e8f0" vertical={false}; axes tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false}; bars fill="#4f46e5" radius={[4,4,0,0]}; lines stroke="#4f46e5" strokeWidth={2} dot={false}; Tooltip with contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}.
- Tables: text-sm; header row text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200; body rows border-b border-slate-100 hover:bg-slate-50; numeric columns text-right tabular-nums.
- Controls: selects/inputs h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500; buttons follow the same scale.
- Layout: responsive grid (grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 for KPIs; charts usually xl:col-span-2). Compact, dense spacing (gap-4, card padding p-4); keep charts small so the dashboard reads at a glance on one screen — breathable but never oversized.
- States: a styled loading state (subtle animate-pulse skeleton cards, not plain "Loading..." text) and a styled empty/error card with a lucide icon.`;

// Remote mode: rows live on the server; the ONLY data access is query(sql).
const RUNTIME_CONTRACT_REMOTE = `
You generate a single-page React app that runs in a browser sandbox.

Import ONLY from these — nothing else is installed, and any other import will be undefined at runtime:
- "react" (React 18 with hooks).
- "recharts" — chart primitives ONLY, e.g. ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend. recharts has NO Card, Grid, Box, or other layout/UI components.
- "lucide-react" — icons (e.g. import { TrendingUp, Users, DollarSign, Filter } from "lucide-react"). Use them in KPI cards, section headers, and empty states.
- "./data" exposing exactly ONE function:
    query(sql: string): Promise<Record<string, unknown>[]>  // run SQL over the table(s) listed below
  There are NO preloaded rows and NO tables export — fetch ALL data with query(). Aggregate in SQL where possible instead of fetching raw rows.

- "./selection" exposing:
    selectFeature(payload: object): void  // call from click handlers when the user selects a chart, table, or KPI card
      Example payload: { title, type, tableName, description, query }
      Use this in every interactive visual element so the host app can inspect clicks.

Do NOT import any other package, and do NOT import or create CSS files — Tailwind CSS is loaded globally and is the ONLY styling mechanism.
Do NOT declare or assign to browser globals or reserved names such as window, document, event, message, name, status, or location.

Rules:
- Read data ONLY through query() from "./data". Never hardcode the rows.
- Query each dataset by its exact table name shown below (quote names containing special characters). Use lowercase SQL aliases.
- Respect column types from the schema. DATE/TIMESTAMP columns are real temporal types, NOT strings: never use string functions (SUBSTR, LEFT, RIGHT, LIKE) on them. Use __DATE_FNS__. Cast with CAST(col AS VARCHAR) only if you genuinely need text.
- Default-export a React component named App.
- Build layout, KPI cards, and tables with plain HTML elements styled via Tailwind utility classes (className) — never with recharts components, never with inline style objects.
- You may write TypeScript or plain JavaScript; the entry file is App.tsx.
- Handle empty/loading/error states.
- Keep it to as few files as possible (ideally one App.tsx).

Design system — follow this on every generation (the user's prompt chooses WHAT to build; this defines HOW it must look):
- Persona: you are a senior product designer-engineer; the result must look like a polished SaaS product, not a demo.
- Canvas: min-h-screen bg-slate-50 text-slate-900, font-sans. Content inside max-w-7xl mx-auto p-6 md:p-8.
- Cards: bg-white rounded-xl border border-slate-200 shadow-sm p-6. Consistent gap-6 between cards. Never nest cards.
- Hierarchy: one page title (text-2xl font-semibold tracking-tight) with a one-line text-sm text-slate-500 subtitle; section titles text-sm font-medium text-slate-700; KPI values text-3xl font-semibold tabular-nums; KPI labels text-xs font-medium uppercase tracking-wide text-slate-500.
- Color discipline: slate neutrals everywhere + exactly ONE accent color family (indigo-600 and its shades) for emphasis, active states, and primary chart series. Green (emerald-600)/red (rose-600) ONLY for positive/negative deltas. Never rainbow palettes; for multi-series charts use indigo-600, indigo-400, slate-400, slate-300.
- KPI cards: icon in a w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 container (lucide, size 20), label, value, and a small delta line when meaningful.
- Charts: wrap in a card with a title; ResponsiveContainer height 200-240; CartesianGrid stroke="#e2e8f0" vertical={false}; axes tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false}; bars fill="#4f46e5" radius={[4,4,0,0]}; lines stroke="#4f46e5" strokeWidth={2} dot={false}; Tooltip with contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}.
- Tables: text-sm; header row text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200; body rows border-b border-slate-100 hover:bg-slate-50; numeric columns text-right tabular-nums.
- Controls: selects/inputs h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500; buttons follow the same scale.
- Layout: responsive grid (grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 for KPIs; charts usually xl:col-span-2). Compact, dense spacing (gap-4, card padding p-4); keep charts small so the dashboard reads at a glance on one screen — breathable but never oversized.
- States: a styled loading state (subtle animate-pulse skeleton cards, not plain "Loading..." text) and a styled empty/error card with a lucide icon.`;

const OUTPUT_CONTRACT = `
Output ONLY raw code — no JSON, no object wrapper, no markdown fences, no prose outside the file.
On the FIRST line, output exactly this, then a one-sentence, user-facing description of the app you built:
//__SUMMARY__ <one concise sentence, e.g. "Revenue by region as a bar chart with a category filter.">
Then the full App.tsx source, beginning with the import lines and ending with the default export.
After the very last line of code, output this exact marker on its own line so we know the file is complete:
//__END__`;


// ---- dataset / feature summaries (Feature Inspector) -----------------------
const SUMMARY_CONTRACT = `
You are an expert data analyst and product designer.
You are given a single dataset schema and sample rows.
Respond with one concise paragraph summarizing what this dataset contains, what the most important columns are, and one useful chart or insight the user can build.
Output only plain English text. Do not output JSON, code, markdown fences, or any extra headings.
`;

export interface SummaryContext {
  featureTitle?: string;
  featureType?: string;
  featureDetails?: string;
  query?: string;
}

export function assembleSummary(
  tableName: string,
  profile: DataProfile,
  context?: SummaryContext,
): { system_prompt: string; user_prompt: string } {
  const schema = schemaText(tableName, profile);
  const system_prompt = [
    SUMMARY_CONTRACT,
    `The table is named "${tableName}" and is loaded from ${profile.source.filename}.`,
  ].join("\n");

  const contextLines: string[] = [];
  if (context?.featureTitle) {
    contextLines.push(`The user clicked on a feature titled "${context.featureTitle}".`);
  }
  if (context?.featureType) {
    contextLines.push(`Feature type: ${context.featureType}.`);
  }
  if (context?.featureDetails) {
    contextLines.push(`Feature details: ${context.featureDetails}.`);
  }
  if (context?.query) {
    contextLines.push(`Associated SQL query: ${context.query}`);
  }

  const contextText = contextLines.length ? `\n\nContext for the selected feature:\n${contextLines.join("\n")}` : "";
  const user_prompt = `Summarize the dataset and the most important analytical insights for table "${tableName}" using the schema below.${contextText}\n\n${schema}`;
  return { system_prompt, user_prompt };
}

// ---- design-plan pass (Phase 3) -------------------------------------------
// A cheap pre-pass: turn schema + the user's prompt into a short, concrete
// layout plan that the BUILD turn then implements. Mirrors how v0/Lovable
// decide structure before writing code. Kept tiny + thinking-off by the caller.
const PLAN_CONTRACT = `
You are a senior product designer planning a single-screen data app BEFORE any code is written.
Given the user's request and the dataset schema, produce a SHORT, concrete layout plan — not code, not prose paragraphs.

Decide, grounded in the actual columns:
- KPIs: 2-4 headline metrics worth showing at the top (name + the aggregation, e.g. "Total revenue = SUM(amount)"). Prefer numeric columns; a row count is fine when little else fits.
- Charts: for each, name the chart type, the column(s) it uses, and why it fits that column's shape. Use the data's shape: a date/time column → a trend over time; a low-cardinality categorical column → a breakdown (bar/pie); two numerics → a relationship. Do NOT invent columns that aren't in the schema.
- Layout: the order of regions top-to-bottom (e.g. "KPI row → trend chart → category breakdown → detail table") and what spans full width vs. sits in a grid.
- Key insight: the single most valuable thing to feature for THIS data, stated in one line.
- Interactions: at most one or two (e.g. a category filter) only if clearly warranted.

Rules:
- Be specific to the columns provided; reference them by name.
- Keep the WHOLE plan under ~180 words. Use terse lines or a compact bulleted list.
- Output plain text only — no code, no markdown fences, no preamble like "Here is the plan".`;

/** Build the { system_prompt, user_prompt } for the cheap design-plan pre-pass.
 *  Server-side, BUILD turns only. The resulting text is fed back into assemble()
 *  via AssembleInput.plan. */
export function assemblePlan(
  datasets: Dataset[],
  userPrompt: string,
  modelDomain?: string,
): { system_prompt: string; user_prompt: string } {
  const schema = datasets.map((d) => schemaText(d.tableName, d.profile)).join("\n\n");
  const tableList = datasets.map((d) => `"${d.tableName}"`).join(", ");
  const intro =
    datasets.length === 1
      ? `The data is one SQL table: ${tableList}.`
      : `The data is ${datasets.length} SQL tables: ${tableList}.`;

  // Context enrichment: rule-detected domain prior + stat-reasoning rules. When
  // the rules aren't confident, a generic-but-opinionated prior is injected and
  // the contract invites the model to adapt if the data clearly fits another
  // domain (the model-fallback path, kept within this single plan call).
  const { domain, block } = buildEnrichment(datasets, modelDomain);
  const adaptNote =
    domain === "generic"
      ? "\n\nIf the columns clearly indicate a specific domain (sales, finance, web/product analytics, marketing, users/CRM), apply that domain's conventions instead of the generic guidance above."
      : "";

  const user_prompt = [
    "User request:",
    userPrompt,
    "",
    intro,
    "",
    "Schema:",
    schema,
    "",
    block + adaptNote,
    "",
    "Produce the layout plan now.",
  ].join("\n");
  return { system_prompt: PLAN_CONTRACT, user_prompt };
}

export function assemble(input: AssembleInput): { system_prompt: string; user_prompt: string } {
  const { datasets, userPrompt, currentCode, lastError, dataAccess, sqlDialect, plan, docContext } = input;
  const runtimeContract = dataAccess === "remote" ? RUNTIME_CONTRACT_REMOTE : RUNTIME_CONTRACT_INLINE;
  const dateFns = DATE_FNS[sqlDialect ?? "duckdb"] ?? DATE_FNS.duckdb;

  // Scope discipline, tuned from ground-truth eval (Test Plan v1):
  // builds may add a *bounded* amount of delight; edits must be surgical.
  // When a design plan is present (enriched build turns), the PLAN is the spec —
  // its KPIs/charts/insights are requested, not "extras", so discipline defers to it.
  const BUILD_DISCIPLINE = plan?.trim()
    ? `
Scope: implement the design plan below in full — its KPIs, charts, insight, and layout are the specification, not optional extras. Do not pad it with anything the plan doesn't call for, and do not drop anything it does. Use the exact presentation forms the plan names.`
    : `
Scope: build exactly what the user asks for. You may include AT MOST two small, clearly complementary additions (for example one extra KPI card) when obviously valuable — never more, and never extra charts unless requested. Use the exact presentation form the user names (chart type, table, section, filter).`;
  const EDIT_DISCIPLINE = `
Scope — THIS IS AN EDIT, NOT A REDESIGN:
- Apply ONLY the requested change. Do not add, remove, restyle, or "improve" anything else.
- NEVER remove or replace an existing feature unless the user explicitly asks. If asked to add something similar to an existing element, add it ALONGSIDE the existing one.
- Preserve all other components, layout, queries, and styling exactly as they are in the current code.
- Use the exact presentation form the user names (chart type, table, section, filter).`;

  const schema = datasets.map((d: Dataset) => schemaText(d.tableName, d.profile)).join("\n\n");
  const tableList = datasets.map((d) => `"${d.tableName}"`).join(", ");
  const intro =
    datasets.length === 1
      ? `\nThe user's data is loaded into one SQL table: ${tableList}.`
      : `\nThe user's data is loaded into ${datasets.length} SQL tables: ${tableList}. Join or query them as needed.`;

  const discipline = lastError ? "" : currentCode ? EDIT_DISCIPLINE : BUILD_DISCIPLINE;

  const system_prompt = [
    "You are an expert product designer and front-end engineer; you produce polished, modern, production-quality UIs.",
    runtimeContract,
    discipline,
    intro,
    schema,
    OUTPUT_CONTRACT,
  ].filter(Boolean).join("\n").replace(/__DATE_FNS__/g, dateFns);

  let user_prompt: string;
  if (lastError && currentCode) {
    // Phase 5: classify the error and attach a targeted, schema-grounded repair
    // hint. The bare error string gives the model too little to go on; the class
    // hint spells out the repair strategy, and for DuckDB SQL errors it re-grounds
    // queries on the REAL columns (the prompt-level half of the data-error channel).
    const { cls, hint } = diagnose(lastError, {
      schema: datasets.map((d) => ({
        table: d.tableName,
        columns: d.profile.columns.map((c) => c.name),
      })),
    });
    user_prompt = [
      `The current app threw an error (class: ${cls}):`, lastError,
      hint,
      "\nHere is the current code:", currentCode,
      "\nFix the error. Output the full corrected App.tsx as raw code, ending with the //__END__ marker.",
    ].filter(Boolean).join("\n");
  } else if (currentCode) {
    user_prompt = [
      "Here is the current app code:", currentCode,
      "\nApply this change:", userPrompt,
      "\nOutput the full updated App.tsx as raw code, ending with the //__END__ marker.",
    ].join("\n");
  } else {
    // BUILD turn. If the Phase-3 plan pass produced a layout plan, hand it to the
    // model as a concrete blueprint to implement (the user prompt still says WHAT;
    // the plan says HOW to lay it out). Best-effort: absent when the plan was
    // skipped (error/timeout) — the build proceeds exactly as before.
    const planSection = plan?.trim()
      ? ["\nDesign plan to implement (follow it; adapt only if it conflicts with the data):", plan.trim()]
      : [];
    // Wave 0 / N2a: document context from uploaded PDFs/Word/PPT (build turns only,
    // best-effort — empty when no documents were uploaded or conversion failed).
    const docSection = docContext?.trim() ? ["\n" + docContext.trim()] : [];
    // Phase 4: few-shot exemplar for the detected domain (build turns only).
    // Best-effort: "" when the library has no match (dormant/empty → no-op).
    const detected = buildEnrichment(datasets, input.modelDomain).domain;
    // Design Retrieval: when the server has injected retrieved reference notes,
    // use them in place of the static text exemplar (the ref images travel to the
    // model call separately). Empty/absent -> fall back to exemplarBlock() unchanged.
    const refBlock = input.referenceBlock?.trim();
    const exemplar = refBlock ? refBlock : exemplarBlock(detected);
    user_prompt = [
      "Build this app on top of the data described above:",
      userPrompt,
      ...docSection,
      ...planSection,
      "\n" + CRAFT_FLOOR,
      LAYOUT_FLOOR,
      designBlock(detected),
      exemplar,
    ].filter(Boolean).join("\n");
  }
  return { system_prompt, user_prompt };
}