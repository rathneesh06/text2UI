// bff/dashboard/eval-sets.ts — Phase B: labeled evaluation data for the live
// eval harness (eval:decompose / eval:editops). These sets are the overfit
// gate made operational: domains "support", "commerce", "telemetry" appear in
// the few-shot examples; domain "clinic" is HELD OUT — it appears in no
// example, so a few-shot lift there is shape learning, and a lift only on the
// example domains is memorization (→ flip T2UI_FEWSHOT=0 per goal 5).
import type { Dataset } from "../../shared/types";

const col = (name: string, type: string, uniqueCount = 6): any =>
  ({ name, type, uniqueCount, nullCount: 0, sampleValues: [] });
const ds = (tableName: string, cols: any[], rowCount = 200): Dataset =>
  ({ tableName, profile: { source: { filename: tableName, format: "csv" }, rowCount, columns: cols, sampleRows: [] } } as any);

export const EVAL_DATASETS: Record<string, Dataset[]> = {
  support: [ds("tickets", [col("status", "string", 4), col("priority", "string", 3), col("assignee", "string", 12), col("created_at", "date", 90)])],
  commerce: [ds("orders", [col("region", "string", 5), col("amount", "number", 150), col("channel", "string", 4), col("created_at", "date", 90)])],
  telemetry: [ds("readings", [col("device", "string", 20), col("value", "number", 180), col("recorded_at", "date", 90)])],
  // HELD OUT — never used in any few-shot example:
  clinic: [ds("appointments", [col("clinic_site", "string", 6), col("visit_type", "string", 5), col("duration_min", "number", 60), col("scheduled_at", "date", 90), col("no_show", "string", 2)])],
};

export interface DecomposeEvalCase {
  domain: keyof typeof EVAL_DATASETS;
  prompt: string;
  /** expected task kinds as a multiset (order-free); ± one extra task is fine */
  expectKinds: string[];
}

export const DECOMPOSE_EVAL: DecomposeEvalCase[] = [
  { domain: "support", prompt: "give me a picture of our ticket load and where the urgent ones sit", expectKinds: ["kpi", "kpi", "composition", "trend"] },
  { domain: "support", prompt: "who is handling the most tickets right now?", expectKinds: ["ranking"] },
  { domain: "support", prompt: "are we closing tickets faster than we open them?", expectKinds: ["trend", "kpi"] },
  { domain: "commerce", prompt: "revenue by region and our best channels", expectKinds: ["kpi", "comparison", "ranking"] },
  { domain: "commerce", prompt: "how did sales move this quarter?", expectKinds: ["trend", "kpi"] },
  { domain: "commerce", prompt: "which region is falling behind?", expectKinds: ["comparison"] },
  { domain: "telemetry", prompt: "are the sensors behaving?", expectKinds: ["kpi", "trend", "ranking"] },
  { domain: "telemetry", prompt: "which devices spike the most?", expectKinds: ["ranking", "trend"] },
  // HELD OUT — the gate:
  { domain: "clinic", prompt: "how busy are our clinics and what share of visits are no-shows?", expectKinds: ["kpi", "kpi", "comparison", "trend"] },
  { domain: "clinic", prompt: "which visit types take the longest?", expectKinds: ["ranking"] },
  { domain: "clinic", prompt: "is the no-show problem getting worse?", expectKinds: ["trend", "kpi"] },
  { domain: "clinic", prompt: "compare the sites on appointment volume", expectKinds: ["comparison"] },
];

export interface EditOpsEvalCase {
  domain: keyof typeof EVAL_DATASETS;
  user: string;
  selectedId?: string;
  /** hard ceilings and safety expectations */
  maxOps: number;
  mustNotRemove: boolean;
  mustTargetId?: string;
  expectEmptyOps?: boolean;
}

/** The eval board is the domain's dataset rendered as EXAMPLE_SPEC-like ids:
 *  the harness builds a small spec per domain with ids k1/c1/t1 so cases are
 *  comparable across domains. */
export const EDITOPS_EVAL: EditOpsEvalCase[] = [
  { domain: "support", user: "show only the top 5 in the table", maxOps: 1, mustNotRemove: true, mustTargetId: "t1" },
  { domain: "support", user: "make this a donut", selectedId: "c1", maxOps: 1, mustNotRemove: true, mustTargetId: "c1" },
  { domain: "support", user: "actually the table is noise, get rid of it", maxOps: 1, mustNotRemove: false, mustTargetId: "t1" },
  { domain: "commerce", user: "dark theme please", maxOps: 1, mustNotRemove: true },
  { domain: "commerce", user: "only orders mentioning refund", maxOps: 2, mustNotRemove: true },
  { domain: "commerce", user: "add a vs last month badge to the total", maxOps: 1, mustNotRemove: true, mustTargetId: "k1" },
  { domain: "telemetry", user: "something feels off with the chart", maxOps: 0, mustNotRemove: true, expectEmptyOps: true },
  // HELD OUT:
  { domain: "clinic", user: "show only morning clinics in the table", maxOps: 2, mustNotRemove: true, mustTargetId: "t1" },
  { domain: "clinic", user: "make the bar a pie", selectedId: "c1", maxOps: 1, mustNotRemove: true, mustTargetId: "c1" },
  { domain: "clinic", user: "add a vs last month comparison to the visit count", maxOps: 1, mustNotRemove: true, mustTargetId: "k1" },
];
