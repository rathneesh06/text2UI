// bff/dashboard/decompose.ts — the query breakdown layer.
//
// Sits ABOVE the specialist agents: the user's question is decomposed into a
// small set of typed analytical TASKS ("how is attainment trending" → trend;
// "which priorities are worst" → ranking), and each task is routed to the
// existing agent whose family answers it. The agents stop guessing what to
// propose and start answering assigned questions.
//
// Design constraints (the critique that shaped this):
//   1. TRIVIALITY GATE — short generic prompts ("sales dashboard") don't need a
//      decomposition call; deterministic tasks from the schema roles suffice.
//      Decomposition LLM cost is only paid when the prompt carries real intent.
//   2. GROUNDED OR DROPPED — every task must name columns that exist; ungrounded
//      tasks are discarded rather than sent to agents to hallucinate around.
//   3. CAPPED FAN-OUT — at most 8 tasks; the merger's dedupe/caps still apply.
//   4. TOTAL — the LLM call can fail; deterministic decomposition from the
//      schema roles is the floor, so this layer can never block a build.
import type { Dataset } from "../../shared/types";
import { callGemini, ORCHESTRATE_OPTS, type GenResult, type GenOptions } from "../aiflow";
import { classifySchema, type SchemaRoles } from "./enhance";

export type TaskKind = "kpi" | "trend" | "ranking" | "composition" | "comparison" | "detail";

export interface AnalysisTask {
  /** the sub-question in plain language, e.g. "How is SLA attainment trending weekly?" */
  question: string;
  kind: TaskKind;
  /** columns the task should use — validated against the profile */
  columns: string[];
  table?: string;
}

export type DecomposeRun = (system: string, user: string, opts?: GenOptions) => Promise<GenResult>;

const MAX_TASKS = 8;

const SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          kind: { type: "string", enum: ["kpi", "trend", "ranking", "composition", "comparison", "detail"] },
          table: { type: "string" },
          columns: { type: "array", items: { type: "string" } },
        },
        required: ["question", "kind", "columns"],
      },
    },
  },
  required: ["tasks"],
};

const SYSTEM = `You are the task-decomposition layer of a dashboard builder. Break the user's request into 3-8 concrete analytical sub-questions, each answerable by ONE widget family:
- kpi: a single headline number
- trend: how something moves over time (needs a date column)
- ranking: which categories are highest/lowest (bar)
- composition: share-of-total (pie/donut, low-cardinality category)
- comparison: two measures or segments side by side
- detail: a drill-down table
Ground every task in REAL columns from the data profile — name them in "columns". Cover the user's explicit asks first, then add the most valuable complementary questions. Output ONLY {"tasks":[...]}.`;

/** Deterministic gate: prompts with no analytical content skip the LLM call. */
export function isTrivialPrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (p.split(/\s+/).length <= 6) return true;
  // Generic "make me a dashboard" phrasing with no domain nouns beyond filler.
  return /^(make|build|create|generate|show)( me)?( an?| the)? (comprehensive |nice |good |detailed )*(dashboard|overview|report)( (of|for|from|on) (my|our|the) data)?[.!]?$/i.test(p);
}

/** Deterministic decomposition from schema roles — the floor and the fallback. */
export function fallbackTasks(datasets: Dataset[], roles: SchemaRoles): AnalysisTask[] {
  const tasks: AnalysisTask[] = [];
  const m = roles.measures[0];
  const t = roles.temporals[0];
  const d = roles.dimensions[0];
  const main = datasets[0]?.tableName;
  if (main) tasks.push({ question: "What is the overall volume?", kind: "kpi", columns: [datasets[0].profile.columns[0]?.name ?? ""], table: main });
  if (m) tasks.push({ question: `What is total ${m.col.name}?`, kind: "kpi", columns: [m.col.name], table: m.table });
  if (t) tasks.push({ question: `How does ${m ? m.col.name : "volume"} move over time?`, kind: "trend", columns: [t.col.name, ...(m ? [m.col.name] : [])], table: t.table });
  if (d) tasks.push({ question: `Which ${d.col.name} values are largest?`, kind: "ranking", columns: [d.col.name, ...(m ? [m.col.name] : [])], table: d.table });
  const smallDim = roles.dimensions.find((x) => x.col.uniqueCount >= 2 && x.col.uniqueCount <= 8);
  if (smallDim) tasks.push({ question: `What is the share by ${smallDim.col.name}?`, kind: "composition", columns: [smallDim.col.name], table: smallDim.table });
  if (d) tasks.push({ question: `What does the detail look like by ${d.col.name}?`, kind: "detail", columns: [d.col.name], table: d.table });
  return tasks.filter((x) => x.columns[0]);
}

function allColumns(datasets: Dataset[]): Set<string> {
  const s = new Set<string>();
  for (const d of datasets) for (const c of d.profile.columns) s.add(c.name.toLowerCase());
  return s;
}

function stripFences(t: string): string {
  return t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

/** Decompose the user's request into grounded tasks. Total — never null, never empty
 *  (falls back to deterministic tasks), never more than MAX_TASKS. */
export async function decomposeQuery(
  datasets: Dataset[], userPrompt: string, directive: string,
  run: DecomposeRun = callGemini,
): Promise<{ tasks: AnalysisTask[]; source: "model" | "deterministic" }> {
  const roles = classifySchema(datasets);
  if (isTrivialPrompt(userPrompt)) {
    const tasks = fallbackTasks(datasets, roles);
    console.log(`[decompose] trivial prompt -> ${tasks.length} deterministic task(s)`);
    return { tasks, source: "deterministic" };
  }
  const cols = allColumns(datasets);
  const schemaLines = datasets.map((d) => `Table "${d.tableName}": ${d.profile.columns.map((c) => `${c.name}:${c.type}`).join(", ")}`).join("\n");
  try {
    const { text } = await run(SYSTEM, [
      "DATA PROFILE:", schemaLines, "",
      "GUIDANCE:", directive.slice(0, 1500), "",
      "USER REQUEST:", userPrompt, "",
      'Return {"tasks":[...]}.',
    ].join("\n"), { ...ORCHESTRATE_OPTS, responseSchema: SCHEMA });
    const parsed = JSON.parse(stripFences(text));
    const raw: any[] = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    const tasks: AnalysisTask[] = raw
      .filter((t) => t?.question && t?.kind && Array.isArray(t?.columns))
      .map((t) => ({
        question: String(t.question).slice(0, 200),
        kind: t.kind as TaskKind,
        table: t.table ? String(t.table) : undefined,
        // GROUNDED OR DROPPED: keep only columns that exist in the profile.
        columns: t.columns.map((c: any) => String(c)).filter((c: string) => cols.has(c.toLowerCase())),
      }))
      .filter((t) => t.columns.length > 0)
      .slice(0, MAX_TASKS);
    if (tasks.length) {
      console.log(`[decompose] ${tasks.length} task(s): ${tasks.map((t) => t.kind).join(", ")}`);
      return { tasks, source: "model" };
    }
    console.warn("[decompose] model returned no grounded tasks — deterministic fallback");
  } catch (err) {
    console.warn(`[decompose] failed (${(err as Error).message}) — deterministic fallback`);
  }
  return { tasks: fallbackTasks(datasets, roles), source: "deterministic" };
}

/** Which agent family serves each task kind. comparison → both trend and ranking
 *  agents see it (either can answer a comparison, over time or across segments). */
export function tasksForAgent(agent: "kpi" | "line" | "bar" | "pie" | "table", tasks: AnalysisTask[]): AnalysisTask[] {
  const map: Record<string, TaskKind[]> = {
    kpi: ["kpi"], line: ["trend", "comparison"], bar: ["ranking", "comparison"],
    pie: ["composition"], table: ["detail"],
  };
  const kinds = new Set(map[agent]);
  return tasks.filter((t) => kinds.has(t.kind));
}

/** Render an agent's assigned tasks as prompt lines. */
export function taskDirective(assigned: AnalysisTask[]): string | null {
  if (!assigned.length) return null;
  return "YOUR ASSIGNED QUESTIONS (answer each with one widget, using the named columns):\n" +
    assigned.map((t, i) => `${i + 1}. ${t.question} [columns: ${t.columns.join(", ")}${t.table ? ` · table: ${t.table}` : ""}]`).join("\n");
}
