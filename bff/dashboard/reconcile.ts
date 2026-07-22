// bff/dashboard/reconcile.ts — deterministic edit reconciliation.
//
// PRINCIPLE: on an edit turn the model's output is a PROPOSAL, not the truth.
// The previous version is the truth for everything the user didn't ask to
// change. Structured-output models routinely re-emit "untouched" widgets with
// required fields missing (a style-only edit came back with every chart's
// `series` array dropped — validation then correctly deleted them all, and a
// "make it dark" turn gutted 7 widgets). Prompt rules ("keep untouched widgets
// exactly") are hopes; this pass is the guarantee:
//
//   For every widget the edit KEEPS (same id as before), any missing/empty
//   required field is restored from the previous version of that widget.
//   Widgets ABSENT from the re-emission are restored UNLESS the user's prompt
//   contains removal words (same REMOVAL_INTENT gate as the patch path) —
//   deliberate deletions and "simplify" asks are respected, silent gutting is
//   not. Widgets the edit ADDS pass through untouched — validation judges them.
import type { DashboardSpec, Widget, ChartWidget, KpiWidget, TableWidget } from "../../shared/dashboard-spec";
import { REMOVAL_INTENT } from "./patch";

const CHARTISH = new Set(["line", "bar", "area", "pie", "donut"]);

export interface ReconcileResult { spec: DashboardSpec; healed: string[] }

export function reconcileEdit(current: DashboardSpec, next: DashboardSpec, userPrompt = ""): ReconcileResult {
  const prevById = new Map<string, Widget>();
  for (const sec of current.sections) for (const w of sec.widgets ?? []) if (w.id) prevById.set(w.id, w);

  const healed: string[] = [];
  const sections = next.sections.map((sec) => ({
    ...sec,
    widgets: (sec.widgets ?? []).map((w) => healWidget(w, prevById.get(w.id ?? ""), healed)),
  }));

  // META PARITY WITH PATCH (D3): the patch path merges meta over the current
  // meta so unmentioned fields survive; the planner re-emission must get the
  // same protection — a model that forgets accent/insight/subtitle on a
  // "format one KPI" edit must not reset them to defaults. Base = current
  // meta; overlay ONLY keys the re-emission actually provided non-empty.
  const meta = { ...current.meta } as unknown as Record<string, unknown>;
  const nm = (next.meta ?? {}) as unknown as Record<string, unknown>;
  for (const k of ["title", "subtitle", "insight", "theme", "accent", "chartPalette", "audience"]) {
    const v = nm[k];
    const provided = Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim().length > 0 : v !== undefined && v !== null;
    if (provided) meta[k] = v;
    else if ((current.meta as unknown as Record<string, unknown>)[k] !== undefined && v !== undefined) {
      healed.push(`meta.${k}: restored from the previous version`);
    }
  }

  const out: DashboardSpec = { ...next, meta: meta as unknown as DashboardSpec["meta"], sections };
  // Filters are re-derived at compile time; carrying the current set forward
  // just keeps intermediate states consistent if compile is skipped.
  if (!out.filters && current.filters) out.filters = current.filters;

  // STRUCTURAL GUARD (the gutted-board incident): the full-spec planner is a
  // re-emission of the whole dashboard, and models routinely just… forget
  // widgets. The patch path gates removals on removal WORDS in the user's
  // prompt; this path must apply the SAME rule. Any widget present before but
  // absent from the re-emission is RESTORED into its original section (at its
  // original position) unless the prompt actually asked for removals.
  // ("format the average ticket age KPI as a percentage" must never cost you
  // five widgets.)
  if (!REMOVAL_INTENT.test(userPrompt)) {
    const nextIds = new Set<string>();
    for (const sec of out.sections) for (const w of sec.widgets ?? []) if (w.id) nextIds.add(w.id);
    for (const [ci, csec] of current.sections.entries()) {
      const missing = (csec.widgets ?? []).filter((w) => w.id && !nextIds.has(w.id));
      if (!missing.length) continue;
      const target = out.sections.find((s) => s.id === csec.id);
      if (target) {
        // Re-insert at the widget's original index within its section (clamped).
        for (const w of missing) {
          const origIdx = (csec.widgets ?? []).indexOf(w);
          target.widgets.splice(Math.min(origIdx, target.widgets.length), 0, w);
          healed.push(`${w.kind} "${(w as any).title ?? w.id}": restored — the edit didn't ask for a removal`);
        }
      } else {
        out.sections.splice(Math.min(ci, out.sections.length), 0, { ...csec, widgets: missing });
        for (const w of missing) healed.push(`${w.kind} "${(w as any).title ?? w.id}": restored — the edit didn't ask for a removal`);
      }
    }
  }

  return { spec: out, healed };
}

function healWidget(w: Widget, prev: Widget | undefined, healed: string[]): Widget {
  if (!prev) return w; // newly added by the edit — validation will judge it
  const out: any = { ...w };
  const note = (field: string) => healed.push(`${w.kind} "${w.id}": restored ${field} from the previous version`);

  if (!out.title || !String(out.title).trim()) { out.title = (prev as any).title; note("title"); }
  if (!out.table || !String(out.table).trim()) { out.table = (prev as any).table; note("table"); }

  if (out.kind === "kpi" && prev.kind === "kpi") {
    const m = out.metric;
    if (!m || !m.col || !m.agg) { out.metric = { ...(prev as KpiWidget).metric }; note("metric"); }
  }

  if (CHARTISH.has(out.kind) && CHARTISH.has(prev.kind)) {
    const p = prev as ChartWidget;
    if (!Array.isArray(out.series) || !out.series.length || out.series.some((s: any) => !s?.col || !s?.agg)) {
      out.series = p.series.map((s) => ({ ...s }));
      note("series");
    }
    if (!out.x || !out.x.col) { out.x = { ...p.x }; note("x axis"); }
  }

  if (out.kind === "table" && prev.kind === "table") {
    const p = prev as TableWidget;
    if (!Array.isArray(out.columns) || !out.columns.length || out.columns.some((c: any) => !c?.col)) {
      out.columns = p.columns.map((c) => ({ ...c }));
      note("columns");
    }
  }

  return out as Widget;
}
