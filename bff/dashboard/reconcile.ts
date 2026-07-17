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
//   Widgets the edit REMOVES (id absent) stay removed — deliberate deletions
//   and "simplify" asks are respected. Widgets the edit ADDS pass through
//   untouched — validation will judge them.
import type { DashboardSpec, Widget, ChartWidget, KpiWidget, TableWidget } from "../../shared/dashboard-spec";

const CHARTISH = new Set(["line", "bar", "area", "pie", "donut"]);

export interface ReconcileResult { spec: DashboardSpec; healed: string[] }

export function reconcileEdit(current: DashboardSpec, next: DashboardSpec): ReconcileResult {
  const prevById = new Map<string, Widget>();
  for (const sec of current.sections) for (const w of sec.widgets ?? []) if (w.id) prevById.set(w.id, w);

  const healed: string[] = [];
  const sections = next.sections.map((sec) => ({
    ...sec,
    widgets: (sec.widgets ?? []).map((w) => healWidget(w, prevById.get(w.id ?? ""), healed)),
  }));

  const meta = { ...next.meta };
  if (!meta.title?.trim() && current.meta.title) { meta.title = current.meta.title; healed.push(`title: restored "${current.meta.title}"`); }

  return { spec: { ...next, meta, sections }, healed };
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
