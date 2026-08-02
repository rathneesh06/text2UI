// bff/dashboard/fewshot.ts — Phase B: curated few-shot examples for the two
// model surfaces that plan changes (edit-ops) and plan builds (decompose).
//
// DESIGN RULES (agreed before building):
// 1. SHAPES, NOT VOCABULARY. Examples teach transferable mappings — "share of
//    X that are Y" → pct expr with a conditional numerator, "top N" → ranking
//    with sort+limit, "mentioning ___" → contains, "vs last month" → compare —
//    over deliberately PLAIN column names (status, category, amount, region,
//    created_at) that recur in most business schemas. No customer vertical is
//    baked in; when real domains are chosen, this file is a data edit.
// 2. EXAMPLES ARE DATA, AND DATA IS VALIDATED. pipeline.test.ts runs every
//    edit-ops example through the REAL applyOps gates against EXAMPLE_SPEC and
//    checks every decompose example is grounded in EXAMPLE_PROFILE columns —
//    an example that violates the grammar fails the build. Teaching material
//    can never drift out of sync with the schemas it teaches.
// 3. FLAG-GATED (goal 5). T2UI_FEWSHOT=0 turns injection off; the two-domain
//    overfit gate is operational in the eval harness (eval-sets.ts): the
//    held-out domain appears in NO example below, so a lift that shows up
//    there is shape learning, and a lift that doesn't is memorization.
// 4. BOUNDED. Each rendered block stays under FEWSHOT_BYTE_BUDGET — these ride
//    every non-trivial call.
import type { DashboardSpec } from "../../shared/dashboard-spec";
import type { EditOp } from "./patch";

export const FEWSHOT_ENABLED = (): boolean => process.env.T2UI_FEWSHOT !== "0";
export const FEWSHOT_BYTE_BUDGET = 4200;

// ---- The canonical example board the edit examples operate on -----------------------
// Three widgets, three kinds, plain columns. Ids are stable teaching handles.
export const EXAMPLE_SPEC: DashboardSpec = {
  version: 1,
  meta: { title: "Overview" },
  sections: [{ id: "s1", widgets: [
    { id: "k1", kind: "kpi", title: "Total Records", table: "records",
      metric: { col: "", agg: "count", format: "compact" }, width: "quarter" } as any,
    { id: "c1", kind: "bar", title: "Records by Category", table: "records",
      x: { col: "category" }, series: [{ col: "", agg: "count" }], width: "half" } as any,
    { id: "t1", kind: "table", title: "Recent Records", table: "records",
      columns: ["category", "status", "amount", "created_at"], limit: 25, width: "full" } as any,
  ] }],
};

export interface EditOpsExample { user: string; selectedId?: string; ops: EditOp[]; lesson: string }

export const EDITOPS_EXAMPLES: EditOpsExample[] = [
  {
    // THE "5 ROWS" INCIDENT, as a negative example: one field, one op, nothing
    // re-emitted. This exact request once produced a full-spec rewrite that
    // gutted the board.
    user: "show only 5 rows in the table",
    ops: [{ op: "update_widget", id: "t1", set: { limit: 5 } } as any],
    lesson: "one field change = ONE op with ONLY that field; never re-send unchanged fields or other widgets",
  },
  {
    // THE "MAKE IT DARK" INCIDENT: a style edit is update_meta and ZERO widget
    // ops — the original turn omitted widget fields and destroyed 7 widgets.
    user: "make the whole dashboard dark themed",
    ops: [{ op: "update_meta", meta: { theme: "dark" } } as any],
    lesson: "board-level style = update_meta only; widgets are not touched by a theme change",
  },
  {
    user: "make this a donut",
    selectedId: "c1",
    ops: [{ op: "update_widget", id: "c1", set: { kind: "donut" } } as any],
    lesson: "the SELECTED widget is the target; changing how it looks is one update, never remove+add",
  },
  {
    user: "remove the recent records table",
    ops: [{ op: "remove_widget", id: "t1" } as any],
    lesson: "removal is allowed ONLY because the user's own words ask for removal",
  },
  {
    user: "only show records mentioning refund",
    ops: [{ op: "update_widget", id: "t1", set: { filters: [{ col: "category", op: "contains", value: "refund" }] } } as any],
    lesson: "'mentioning/containing' = a contains filter; the subset lives in filters, never only in the title",
  },
  {
    user: "add a vs-last-month comparison to the total",
    ops: [{ op: "update_widget", id: "k1", set: { metric: { compare: { grain: "month", dateCol: "created_at" } } } } as any],
    lesson: "compare rides the metric field-wise; the existing agg/col are untouched",
  },
  {
    // Unactionable: no invented changes. Empty ops is the honest answer.
    user: "hmm the chart looks kind of wrong",
    ops: [],
    lesson: "no concrete request = NO ops; never guess a change the user didn't ask for",
  },
];

export function editOpsFewshotBlock(): string {
  if (!FEWSHOT_ENABLED()) return "";
  const lines = EDITOPS_EXAMPLES.map((e) => {
    const sel = e.selectedId ? ` (selected widget: ${e.selectedId})` : "";
    return `User: "${e.user}"${sel}\nOps: ${JSON.stringify(e.ops)}\nWhy: ${e.lesson}`;
  });
  return `\n\nWORKED EXAMPLES on a board with widgets k1 (kpi "Total Records"), c1 (bar "Records by Category"), t1 (table "Recent Records", columns category/status/amount/created_at). The ids k1/c1/t1 exist ONLY in these examples — NEVER emit them; real ops use ids from the CURRENT DASHBOARD SPEC:\n${lines.join("\n---\n")}`;
}

// ---- Decompose examples: prompt → grounded tasks, across distant shapes -------------
export const EXAMPLE_PROFILE: Record<string, string[]> = {
  // categorical-heavy operations table
  tickets: ["status", "priority", "assignee", "created_at"],
  // money + time
  orders: ["region", "amount", "channel", "created_at"],
  // numeric telemetry
  readings: ["device", "value", "recorded_at"],
};

export interface DecomposeExample {
  prompt: string; table: string;
  tasks: Array<{ question: string; kind: string; columns: string[] }>;
  note: string;
}

export const DECOMPOSE_EXAMPLES: DecomposeExample[] = [
  {
    prompt: "how are we doing on tickets? especially the urgent ones",
    table: "tickets",
    tasks: [
      { question: "How many tickets are there in total?", kind: "kpi", columns: ["status"] },
      { question: "What share of tickets are urgent priority?", kind: "kpi", columns: ["priority"] },
      { question: "Which statuses dominate?", kind: "composition", columns: ["status"] },
      { question: "How is ticket volume trending?", kind: "trend", columns: ["created_at"] },
    ],
    note: "'especially X' = a conditional-share KPI on the marking column, not a filter on the whole board",
  },
  {
    prompt: "revenue picture by region, and who are our top channels",
    table: "orders",
    tasks: [
      { question: "What is total revenue?", kind: "kpi", columns: ["amount"] },
      { question: "How does revenue compare across regions?", kind: "comparison", columns: ["region", "amount"] },
      { question: "Which channels bring the most revenue?", kind: "ranking", columns: ["channel", "amount"] },
    ],
    note: "'top X' = ranking on the measure; 'by region' = comparison — different questions, different kinds",
  },
  {
    prompt: "are the sensors behaving?",
    table: "readings",
    tasks: [
      { question: "What is the average reading?", kind: "kpi", columns: ["value"] },
      { question: "How do readings move over time?", kind: "trend", columns: ["recorded_at", "value"] },
      { question: "Which devices report the highest values?", kind: "ranking", columns: ["device", "value"] },
    ],
    note: "vague health questions decompose into level + trend + outliers on the real measure column",
  },
];

export function decomposeFewshotBlock(): string {
  if (!FEWSHOT_ENABLED()) return "";
  const lines = DECOMPOSE_EXAMPLES.map((e) =>
    `Prompt: "${e.prompt}" (table ${e.table}: ${EXAMPLE_PROFILE[e.table].join(", ")})\nTasks: ${JSON.stringify(e.tasks)}\nWhy: ${e.note}`);
  return `\n\nWORKED EXAMPLES (note how every task names REAL columns):\n${lines.join("\n---\n")}`;
}
