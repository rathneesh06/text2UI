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
import { editOpsFewshotBlock } from "./fewshot";

export type EditRun = (system: string, user: string, opts?: GenOptions) => Promise<GenResult>;

// ---- op schema (compact OpenAPI subset for structured output) ----------------------
const WIDGET_FIELDS = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["kpi", "line", "bar", "area", "pie", "donut", "table"] },
    title: { type: "string" }, subtitle: { type: "string" }, table: { type: "string" },
    metric: { type: "object", properties: { col: { type: "string" }, compare: { type: "object", description: "vs-previous-period delta; needs a real temporal dateCol", properties: { grain: { type: "string", enum: ["day", "week", "month", "quarter", "year"] }, dateCol: { type: "string" } }, required: ["grain", "dateCol"] }, agg: { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "median"] }, label: { type: "string" }, format: { type: "string", enum: ["number", "percent", "currency", "hours", "days", "compact"] }, expr: { type: "object", properties: { op: { type: "string", enum: ["ratio", "pct", "diff"] }, num: { type: "object", properties: { col: { type: "string" }, agg: { type: "string" }, where: { type: "array", items: { type: "object", properties: { col: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "between", "contains", "not_null", "is_null"] }, value: { type: "string" }, values: { type: "array", items: { type: "string" } } }, required: ["col", "op"] } } }, required: ["agg"] }, den: { type: "object", properties: { col: { type: "string" }, agg: { type: "string" }, where: { type: "array", items: { type: "object", properties: { col: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "between", "contains", "not_null", "is_null"] }, value: { type: "string" }, values: { type: "array", items: { type: "string" } } }, required: ["col", "op"] } } }, required: ["agg"] } }, required: ["op", "num", "den"] } } },
    x: { type: "object", properties: { col: { type: "string" }, timeGrain: { type: "string", enum: ["day", "week", "month", "quarter", "year"] }, label: { type: "string" } } },
    series: { type: "array", items: { type: "object", properties: { col: { type: "string" }, agg: { type: "string" }, label: { type: "string" }, format: { type: "string" }, expr: { type: "object", properties: { op: { type: "string", enum: ["ratio", "pct", "diff"] }, num: { type: "object", properties: { col: { type: "string" }, agg: { type: "string" }, where: { type: "array", items: { type: "object", properties: { col: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "between", "contains", "not_null", "is_null"] }, value: { type: "string" }, values: { type: "array", items: { type: "string" } } }, required: ["col", "op"] } } }, required: ["agg"] }, den: { type: "object", properties: { col: { type: "string" }, agg: { type: "string" }, where: { type: "array", items: { type: "object", properties: { col: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "between", "contains", "not_null", "is_null"] }, value: { type: "string" }, values: { type: "array", items: { type: "string" } } }, required: ["col", "op"] } } }, required: ["agg"] } }, required: ["op", "num", "den"] } } } },
    columns: { type: "array", items: { type: "object", properties: { col: { type: "string" }, label: { type: "string" }, agg: { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "median"] }, format: { type: "string", enum: ["number", "percent", "currency", "hours", "days", "compact"] } } } },
    groupBy: { type: "array", items: { type: "object", properties: { col: { type: "string" }, timeGrain: { type: "string" } } } },
    limit: { type: "integer" }, width: { type: "string", enum: ["quarter", "third", "half", "full"] },
    sort: { type: "object", properties: { by: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["by", "dir"] },
    join: { type: "object", description: "ONE lookup join to a related table — allowed ONLY for relationships listed as VERIFIED in the profile digest. on = [baseColumn, referencedColumn].", properties: { table: { type: "string" }, on: { type: "array", items: { type: "string" } } }, required: ["table", "on"] },
    filters: { type: "array", description: "scope this widget to a SUBSET of rows ('only open tickets'). Use EXACT observed literals.", items: { type: "object", properties: { col: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "between", "contains", "not_null", "is_null"] }, value: { type: "string" }, values: { type: "array", items: { type: "string" } } }, required: ["col", "op"] } },
  },
};

// add_widget uses the SAME field set but with the identity fields REQUIRED —
// this is what update's `set` must NOT have (a set is partial by design). The
// "incomplete widget" rejection class traced to Gemini legally omitting
// table/kind here when this was the shared, nothing-required schema.
const ADD_WIDGET_FIELDS = { ...WIDGET_FIELDS, required: ["kind", "title", "table"] };

export const EDIT_OPS_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string", description: "1-3 sentences BEFORE ops: which widget(s) the request targets and why the op list is minimal." },
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["update_widget", "remove_widget", "add_widget", "update_meta"] },
          id: { type: "string", description: "target widget id (update_widget / remove_widget)" },
          set: WIDGET_FIELDS,
          widget: ADD_WIDGET_FIELDS,
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

const SYSTEM = `You are the EDIT engine of a dashboard builder. You receive the CURRENT dashboard spec (with widget ids), the conversation, and the user's edit request. You output ONLY a JSON object {"ops":[...]} — a MINIMAL list of operations that accomplishes exactly what the user asked, nothing more. Changing how an EXISTING widget looks or is computed (format, chart kind, metric, expr, time grain, title) is ALWAYS a single update_widget op on that widget id — NEVER remove_widget + add_widget to "replace" it (removals without explicit removal words are rejected). To show a SUBSET of rows ("only open tickets", "P1 only"), set widget.filters: [{col,op,value}] with EXACT observed literals — never bake the subset into the title alone. Ops beyond equality: contains (substring match, value = the text), in/not_in (values = the list), between (values = exactly [lo, hi] — dates as YYYY-MM-DD). To show a column from a RELATED table (e.g. tickets by status NAME when tickets only carries status_id), set widget.join = {table, on:[baseCol, refCol]} — prefer relationships the digest lists as VERIFIED; a plausible unlisted join is measured against the live data and kept only if it proves out.
Rules:
- Touch ONLY what the user asked about. Every widget you do not name stays exactly as it is — you cannot break it.
- update_widget: give the id and ONLY the fields to change (e.g. {"op":"update_widget","id":"t1","set":{"limit":5}}). Never re-send unchanged fields.
- remove_widget: only when the user clearly asked to remove/delete/hide something.
- add_widget: a complete new widget grounded in real columns from the data profile. MUST include kind, title, AND table (pick the table from the data profile — usually the one the existing widgets use). For rate/percentage KPIs use metric.expr {op:"pct", num, den}; when qualifying rows are marked by a column value, give num a where (e.g. num {agg:"count", where:[{col:"sla_status",op:"=",value:"met"}]} over den count(*)). num and den must differ — identical sides are a constant 100% and are rejected. Never a plain sum formatted as percent. If a request would misrepresent a number (formatting an average of hours as a percentage, retitling a count as a rate), output {"ops":[]} instead of distorting the metric.
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

// ---- TARGETED-EDIT FAST-PATH (deterministic beats clever) ---------------------------
// When a widget is SELECTED and the request is one of the common direct
// gestures, the op is fully determined — no model call, no fallback risk, no
// possibility of a full-board edit. This is why click-to-target must never
// degrade: the click + a simple sentence IS the op.
const KINDS = "donut|pie|bar|line|area|table";
const DEIXIS = "(?:this|it|that|this one|that one|this widget|this chart|this card)";
export function deterministicSelectionOps(
  userPrompt: string, selectedId: string | undefined, current: DashboardSpec,
): EditOp[] | null {
  if (!selectedId) return null;
  const exists = current.sections?.some((s) => s.widgets?.some((w: any) => w.id === selectedId));
  if (!exists) return null;
  const p = userPrompt.trim();

  // "make this a donut" / "turn it into a bar chart" / "as a pie"
  let m = p.match(new RegExp(`^(?:make|turn|change|convert|render|show)\\s+${DEIXIS}\\s+(?:into\\s+|to\\s+|as\\s+)?an?\\s+(${KINDS})(?:\\s*chart)?\\s*[.!]?$`, "i"));
  if (m) return [{ op: "update_widget", id: selectedId, set: { kind: m[1].toLowerCase() } } as any];

  // "remove this" / "delete that one" — selection + the user's OWN removal words
  m = p.match(new RegExp(`^(?:remove|delete|drop|get rid of)\\s+${DEIXIS}\\s*[.!]?$`, "i"));
  if (m) return [{ op: "remove_widget", id: selectedId } as any];

  // "rename this to X" / "call it X" / "title this X"
  m = p.match(new RegExp(`^(?:rename|retitle)\\s+${DEIXIS}\\s+(?:to\\s+|as\\s+)?["']?(.{1,80}?)["']?\\s*[.!]?$`, "i"))
    ?? p.match(new RegExp(`^(?:call|title|label)\\s+${DEIXIS}\\s+["']?(.{1,80}?)["']?\\s*[.!]?$`, "i"));
  if (m) return [{ op: "update_widget", id: selectedId, set: { title: m[1].trim() } } as any];

  // "show only 5 rows" / "limit this to 10" — meaningful for tables and charts
  m = p.match(new RegExp(`^(?:show\\s+only|limit\\s+${DEIXIS}\\s+to|top)\\s+(\\d{1,3})(?:\\s+rows?)?\\s*[.!]?$`, "i"));
  if (m) return [{ op: "update_widget", id: selectedId, set: { limit: Number(m[1]) } } as any];

  return null; // anything richer goes to the model, selection attached
}

/** Ask the model for the minimal op list. Null on any failure — caller falls back. */
export async function planEditOps(input: PlanEditOpsInput, run: EditRun = callGemini): Promise<EditOp[] | null> {
  const user = [
    "DATA PROFILE:", schemaText(input.datasets), "",
    "CURRENT DASHBOARD SPEC (edit against these ids):", JSON.stringify(input.currentSpec), "",
    ...(input.chatContext ? ["CONVERSATION:", input.chatContext, ""] : []),
    ...(input.selectedWidget?.id || input.selectedWidget?.title
      ? [`SELECTED WIDGET: id=${input.selectedWidget.id ?? "?"} title="${input.selectedWidget.title ?? ""}". Demonstratives (this/it/that one) refer to THIS widget — ops answering such phrasing MUST target exactly this id and touch nothing else.`, ""] : []),
    ...(input.directive ? ["GUIDANCE:", input.directive, ""] : []),
    "USER EDIT REQUEST:", input.userPrompt, "",
    'Return {"ops":[...]}.',
  ].join("\n");
  try {
    const { text } = await run(SYSTEM + editOpsFewshotBlock(), user, { ...ORCHESTRATE_OPTS, responseSchema: EDIT_OPS_SCHEMA });
    const parsed = JSON.parse(stripFences(text));
    if (!Array.isArray(parsed?.ops)) { console.warn(`[edit-ops] no ops array in response: ${String(text).slice(0, 160)}`); return null; }
    const specIds = new Set((input.currentSpec.sections ?? []).flatMap((s) => (s.widgets ?? []).map((w: any) => w.id)));
    const ops = parsed.ops.filter((o: any) => {
      if (!o || typeof o.op !== "string") return false;
      // Few-shot bleed guard: example ids can never be right on a real board.
      if (o.id && !specIds.has(o.id) && ["k1", "c1", "t1"].includes(o.id)) {
        console.warn(`[edit-ops] dropped op targeting few-shot example id "${o.id}"`);
        return false;
      }
      return true;
    });
    console.log(`[edit-ops] ${ops.length} op(s): ${ops.map((o: EditOp) => `${o.op}${o.id ? `(${o.id})` : ""}`).join(" ")}`);
    return ops as EditOp[];
  } catch (err) {
    console.warn(`[edit-ops] failed: ${(err as Error).message}`);
    return null;
  }
}

// ---- deterministic application ------------------------------------------------------

export const REMOVAL_INTENT = /\b(remove|delete|drop|get rid|hide|without|no more|only keep|keep only|just keep|simplif\w*|fewer|less charts?|too many)\b/i;

export interface ApplyResult { spec: DashboardSpec; applied: string[]; rejected: string[]; notes: string[] }

/** Apply ops to the current spec. Pure. Unknown ids and ungated removals are
 *  rejected with a human note instead of silently doing the wrong thing. */
export function applyOps(current: DashboardSpec, ops: EditOp[], userPrompt: string, selectedId?: string): ApplyResult {
  const applied: string[] = [];
  const rejected: string[] = [];
  const notes: string[] = [];
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
      const set: any = { ...(op.set ?? {}) }; // never mutate the caller's op
      // METRIC IDENTITY GUARD (the "avg age became 1,785" incident): changing a
      // KPI's agg or column changes WHAT THE NUMBER MEANS. A model asked to
      // change the FORMAT routinely re-emits the whole metric with a different
      // agg (avg -> count). Rule: the new agg/col must be named in the user's
      // own words; otherwise keep the current agg/col and merge only the
      // display fields (label/format/expr). Deterministic, prompt-anchored.
      if (set.metric && target.metric && typeof set.metric === "object") {
        const cur = target.metric;
        let nm: any = { ...set.metric };
        const p = userPrompt.toLowerCase();
        const aggWords: Record<string, RegExp> = {
          count: /\b(count|how many|number of|volume)\b/, count_distinct: /\b(distinct|unique)\b/,
          sum: /\b(sum|total)\b/, avg: /\b(average|avg|mean)\b/, median: /\bmedian\b/,
          min: /\b(min|minimum|lowest|smallest)\b/, max: /\b(max|maximum|highest|largest)\b/,
        };
        const aggChanged = nm.agg !== undefined && nm.agg !== cur.agg;
        const colChanged = nm.col !== undefined && nm.col !== cur.col && String(nm.col).length > 0;
        const aggNamed = aggChanged && aggWords[nm.agg]?.test(p);
        const colNamed = colChanged && (p.includes(String(nm.col).toLowerCase().split("_").join(" ")) || p.includes(String(nm.col).toLowerCase()));
        if ((aggChanged && !aggNamed) || (colChanged && !colNamed)) {
          nm = { ...nm, col: cur.col, agg: cur.agg };
          notes.push(`kept "${target.title ?? op.id}" measuring ${cur.agg}(${cur.col || "*"}) — the request didn't ask to change the metric`);
        }
        // Metric merges FIELD-WISE: unspecified fields survive.
        set.metric = { ...cur, ...nm };
      }
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
      // Removal ALWAYS requires removal words in the user's own prompt. The
      // selected widget only resolves WHICH widget ("remove this one") — it is
      // not itself permission. (Live incident: "show the total tickets KPI as
      // a percentage" with a lingering selection removed the KPI outright.)
      if (!removalAllowed) {
        rejected.push(`remove_widget "${(found.sec.widgets[found.idx] as any).title ?? op.id}": the request didn't ask for a removal — kept`);
        continue;
      }
      const [gone] = found.sec.widgets.splice(found.idx, 1);
      applied.push(`removed "${(gone as any).title ?? op.id}"`);
      continue;
    }
    if (op.op === "add_widget") {
      const w = op.widget;
      if (!w) { rejected.push("add_widget: no widget provided"); continue; }
      // REPAIR before rejecting — the model routinely nails the analytical
      // content (metric/expr/series) but omits an identity field. All repairs
      // are deterministic; anything still unresolvable rejects with a message
      // naming the missing fields (so the audit trail is actionable).
      if (!w.kind) {
        if ((w as any).metric) (w as any).kind = "kpi";
        else if ((w as any).columns?.length) (w as any).kind = "table";
        else if ((w as any).x && (w as any).series?.length) (w as any).kind = "bar";
        else if ((w as any).filters?.length) (w as any).kind = "kpi"; // a filtered count is still a KPI
      }
      // "add a KPI counting only open tickets" → the model emits filters and
      // forgets the metric. A missing metric on a KPI whose intent is a
      // filtered COUNT has exactly one honest default: count(*).
      if ((w as any).kind === "kpi" && !(w as any).metric) {
        (w as any).metric = { col: "", agg: "count" };
      }
      if (!w.table) {
        // Default to the table the current board is about: the most common
        // table among existing widgets (unambiguous in the typical case).
        const counts = new Map<string, number>();
        for (const s of spec.sections) for (const cw of s.widgets) counts.set(cw.table, (counts.get(cw.table) ?? 0) + 1);
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        if (top.length && (top.length === 1 || top[0][1] > (top[1]?.[1] ?? 0))) (w as any).table = top[0][0];
      }
      if (!w.title) {
        const m: any = (w as any).metric;
        const derived = m?.label || (m?.col ? `${m.agg ?? ""} ${m.col}`.trim() : "");
        if (derived) (w as any).title = String(derived);
      }
      if (!w.kind || !w.title || !w.table) {
        const missing = [!w.kind && "kind", !w.title && "title", !w.table && "table"].filter(Boolean).join(", ");
        rejected.push(`add_widget: incomplete widget (missing ${missing})`);
        continue;
      }
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
  return { spec, applied, rejected, notes };
}
