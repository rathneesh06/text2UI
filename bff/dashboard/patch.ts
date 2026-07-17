// bff/dashboard/patch.ts — patch-based editing: the Figma/Canva model.
//
// In a mature editor an edit is a SCOPED OPERATION ON NAMED NODES — "set limit=5
// on table t1" — never a rewrite of the whole document. Full-spec edit turns
// asked the model to re-emit everything it wasn't changing, and it kept paying
// the predictable price: dropped fields (healed by reconcile.ts) and, worse,
// DROPPED WIDGETS — a "show only 5 rows" ask once deleted five unrelated charts.
//
// Edit turns now ask the model for a small list of operations against the
// current spec, applied deterministically here:
//   update_widget  — partial field merge on one widget id (untouched fields are
//                    physically incapable of changing)
//   remove_widget  — explicit, and GATED: applied only when the user's prompt
//                    shows removal intent or the widget is the one they selected
//   add_widget     — a full new widget, judged by validation like any other
//   update_meta    — title / subtitle / insight / theme / accent / palette
// Anything not named in an op cannot change. That is the guarantee.
import type { Dataset } from "../../shared/types";
import type { DashboardSpec, Widget, Section } from "../../shared/dashboard-spec";
import { callGemini, ORCHESTRATE_OPTS, type GenResult, type GenOptions } from "../aiflow";

export type EditRun = (system: string, user: string, opts?: GenOptions) => Promise<GenResult>;

// ---- op schema (compact OpenAPI subset for structured output) ----------------------
const WIDGET_FIELDS = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["kpi", "line", "bar", "area", "pie", "donut", "table"] },
    title: { type: "string" }, subtitle: { type: "string" }, table: { type: "string" },
    metric: { type: "object", properties: { col: { type: "string" }, agg: { type: "string" }, label: { type: "string" }, format: { type: "string" } } },
    x: { type: "object", properties: { col: { type: "string" }, timeGrain: { type: "string" }, label: { type: "string" } } },
    series: { type: "array", items: { type: "object", properties: { col: { type: "string" }, agg: { type: "string" }, label: { type: "string" }, format: { type: "string" } } } },
    columns: { type: "array", items: { type: "object", properties: { col: { type: "string" }, label: { type: "string" }, agg: { type: "string" } } } },
    groupBy: { type: "array", items: { type: "object", properties: { col: { type: "string" }, timeGrain: { type: "string" } } } },
    limit: { type: "integer" }, width: { type: "string", enum: ["quarter", "third", "half", "full"] },
  },
};

export const EDIT_OPS_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["update_widget", "remove_widget", "add_widget", "update_meta"] },
          id: { type: "string", description: "target widget id (update_widget / remove_widget)" },
          set: WIDGET_FIELDS,
          widget: WIDGET_FIELDS,
          sectionId: { type: "string", description: "for add_widget: section to append to" },
          meta: { type: "object", properties: {
            title: { type: "string" }, subtitle: { type: "string" }, insight: { type: "string" },
            theme: { type: "string", enum: ["light", "dark"] }, accent: { type: "string" },
            chartPalette: { type: "array", items: { type: "string" } },
          } },
        },
        required: ["op"],
      },
    },
  },
  required: ["ops"],
};

const SYSTEM = `You are the EDIT engine of a dashboard builder. You receive the CURRENT dashboard spec (with widget ids), the conversation, and the user's edit request. You output ONLY a JSON object {"ops":[...]} — a MINIMAL list of operations that accomplishes exactly what the user asked, nothing more.
Rules:
- Touch ONLY what the user asked about. Every widget you do not name stays exactly as it is — you cannot break it.
- update_widget: give the id and ONLY the fields to change (e.g. {"op":"update_widget","id":"t1","set":{"limit":5}}). Never re-send unchanged fields.
- remove_widget: only when the user clearly asked to remove/delete/hide something.
- add_widget: a complete new widget grounded in real columns from the data profile.
- update_meta: for theme/title/subtitle/accent/palette/insight changes.
- When a SELECTED WIDGET is given, "this"/"that"/"it" means that widget id.
- If the request is unclear, return {"ops":[]} rather than guessing.`;

export interface PlanEditOpsInput {
  datasets: Dataset[];
  userPrompt: string;
  currentSpec: DashboardSpec;
  chatContext?: string | null;
  selectedWidget?: { id?: string; title?: string };
  directive?: string;
}

function schemaText(datasets: Dataset[]): string {
  return datasets.map((d) => `Table "${d.tableName}" (${d.profile.rowCount} rows): ${d.profile.columns.map((c) => `${c.name}:${c.type}`).join(", ")}`).join("\n");
}

function stripFences(t: string): string {
  return t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

export interface EditOp {
  op: "update_widget" | "remove_widget" | "add_widget" | "update_meta";
  id?: string; set?: any; widget?: any; sectionId?: string; meta?: any;
}

/** Ask the model for the minimal op list. Null on any failure — caller falls back. */
export async function planEditOps(input: PlanEditOpsInput, run: EditRun = callGemini): Promise<EditOp[] | null> {
  const user = [
    "DATA PROFILE:", schemaText(input.datasets), "",
    "CURRENT DASHBOARD SPEC (edit against these ids):", JSON.stringify(input.currentSpec), "",
    ...(input.chatContext ? ["CONVERSATION:", input.chatContext, ""] : []),
    ...(input.selectedWidget?.id || input.selectedWidget?.title
      ? [`SELECTED WIDGET (the user's "this"): id=${input.selectedWidget.id ?? "?"} title="${input.selectedWidget.title ?? ""}"`, ""] : []),
    ...(input.directive ? ["GUIDANCE:", input.directive, ""] : []),
    "USER EDIT REQUEST:", input.userPrompt, "",
    'Return {"ops":[...]}.',
  ].join("\n");
  try {
    const { text } = await run(SYSTEM, user, { ...ORCHESTRATE_OPTS, responseSchema: EDIT_OPS_SCHEMA });
    const parsed = JSON.parse(stripFences(text));
    if (!Array.isArray(parsed?.ops)) return null;
    const ops = parsed.ops.filter((o: any) => o && typeof o.op === "string");
    console.log(`[edit-ops] ${ops.length} op(s): ${ops.map((o: EditOp) => `${o.op}${o.id ? `(${o.id})` : ""}`).join(" ")}`);
    return ops as EditOp[];
  } catch (err) {
    console.warn(`[edit-ops] failed: ${(err as Error).message}`);
    return null;
  }
}

// ---- deterministic application ------------------------------------------------------

const REMOVAL_INTENT = /\b(remove|delete|drop|get rid|hide|without|no more|only keep|keep only|just keep|simplif\w*|fewer|less charts?|too many)\b/i;

export interface ApplyResult { spec: DashboardSpec; applied: string[]; rejected: string[] }

/** Apply ops to the current spec. Pure. Unknown ids and ungated removals are
 *  rejected with a human note instead of silently doing the wrong thing. */
export function applyOps(current: DashboardSpec, ops: EditOp[], userPrompt: string, selectedId?: string): ApplyResult {
  const applied: string[] = [];
  const rejected: string[] = [];
  let seq = 0;
  const spec: DashboardSpec = {
    ...current,
    meta: { ...current.meta },
    sections: current.sections.map((s) => ({ ...s, widgets: (s.widgets ?? []).map((w) => ({ ...w })) })),
  };
  const findWidget = (id: string): { sec: Section; idx: number } | null => {
    for (const sec of spec.sections) {
      const idx = sec.widgets.findIndex((w) => w.id === id);
      if (idx >= 0) return { sec, idx };
    }
    return null;
  };
  const removalAllowed = REMOVAL_INTENT.test(userPrompt);

  for (const op of ops) {
    if (op.op === "update_meta" && op.meta && typeof op.meta === "object") {
      const allowed = ["title", "subtitle", "insight", "theme", "accent", "chartPalette"] as const;
      for (const k of allowed) if (op.meta[k] !== undefined) (spec.meta as any)[k] = op.meta[k];
      applied.push("meta updated");
      continue;
    }
    if (op.op === "update_widget") {
      const found = op.id ? findWidget(op.id) : null;
      if (!found) { rejected.push(`update_widget: unknown id "${op.id}"`); continue; }
      const target: any = found.sec.widgets[found.idx];
      const set = op.set ?? {};
      // Partial merge: only provided fields change; arrays/objects replace wholesale
      // when provided NON-EMPTY (an empty series/columns can never wipe a widget).
      for (const [k, v] of Object.entries(set)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        target[k] = v;
      }
      applied.push(`updated "${target.title ?? op.id}"`);
      continue;
    }
    if (op.op === "remove_widget") {
      const found = op.id ? findWidget(op.id) : null;
      if (!found) { rejected.push(`remove_widget: unknown id "${op.id}"`); continue; }
      if (!removalAllowed && op.id !== selectedId) {
        rejected.push(`remove_widget "${(found.sec.widgets[found.idx] as any).title ?? op.id}": the request didn't ask for a removal — kept`);
        continue;
      }
      const [gone] = found.sec.widgets.splice(found.idx, 1);
      applied.push(`removed "${(gone as any).title ?? op.id}"`);
      continue;
    }
    if (op.op === "add_widget") {
      const w = op.widget;
      if (!w || !w.kind || !w.title || !w.table) { rejected.push("add_widget: incomplete widget"); continue; }
      const widget: Widget = { ...w, id: w.id && !findWidget(w.id) ? w.id : `w_${Date.now().toString(36)}_${++seq}` };
      const sec = spec.sections.find((s) => s.id === op.sectionId) ?? spec.sections[spec.sections.length - 1];
      if (!sec) { rejected.push("add_widget: no section to add to"); continue; }
      sec.widgets.push(widget);
      applied.push(`added "${w.title}"`);
      continue;
    }
    rejected.push(`unknown op "${(op as any).op}"`);
  }
  // Drop sections emptied by removals.
  spec.sections = spec.sections.filter((s) => s.widgets.length > 0);
  return { spec, applied, rejected };
}
