// bff/dashboard/handler.ts — the spec-driven build endpoint. One call runs the whole
// pipeline: plan (or edit) a DashboardSpec, validate+compile it to SQL, and render it
// to a runnable app. It returns BOTH the app AND the spec; the client persists the
// spec and sends it back as `currentSpec` next turn, so each prompt edits the same
// dashboard. Pure handler (deps injectable) so it can be unit-tested without a server.
import type { Dataset } from "../../shared/types";
import type { DashboardSpec } from "../../shared/dashboard-spec";
import { planSpec, rewritePrompt, HEX_RE, type PlanSpecInput } from "./planner";
import { compileSpec } from "./compile";
import { renderPlanToApp } from "./renderer";

type Planner = (input: PlanSpecInput) => Promise<DashboardSpec | null>;

export async function handleDashboardBuild(
  body: unknown,
  planner: Planner = planSpec,
): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  if (!Array.isArray(b.datasets) || !b.datasets.length) return { status: 400, body: { error: "datasets[] is required" } };
  if (typeof b.userPrompt !== "string" || !b.userPrompt.trim()) return { status: 400, body: { error: "userPrompt is required" } };

  const datasets = b.datasets as Dataset[];
  const currentSpec = b.currentSpec as DashboardSpec | undefined;
  // The orchestrator's brief becomes BOTH directives for the spec planner: its
  // palette/designDirection as visual direction, and its kpis/charts as the
  // analytical directive. When there is no brief (edit turns, direct builds),
  // the query-rewriting stage expands the raw ask into schema-grounded modeling
  // instructions instead. Either path may fail soft — the raw prompt proceeds.
  const styleHints = briefToStyleHints(b.brief);
  const directive = briefToAnalyticalDirective(b.brief)
    ?? await rewritePrompt({ datasets, userPrompt: b.userPrompt, ...(currentSpec ? { currentSpec } : {}) });

  const planOnce = (extra?: string) => planner({
    datasets,
    userPrompt: extra ? `${b.userPrompt}\n\n${extra}` : b.userPrompt,
    currentSpec,
    ...(styleHints ? { styleHints } : {}),
    ...(directive ? { directive } : {}),
  });

  let spec = await planOnce();
  if (!spec) return { status: 502, body: { error: "planner could not produce a dashboard spec" } };

  // HOUSE-STYLE ENFORCEMENT (deterministic — the model is instructed, but the
  // guarantee lives here): >=4 charts and >=3 KPIs on builds, one corrective
  // retry when short, then accept with a warning rather than block.
  const shortfalls = coverageShortfalls(spec, datasets);
  if (shortfalls.length && !currentSpec) {
    const retry = await planOnce(`REVISE: the previous plan was insufficient — ${shortfalls.join("; ")}. Keep everything that was good; add what is missing.`);
    if (retry && coverageShortfalls(retry, datasets).length < shortfalls.length) spec = retry;
  }
  // Vibrancy guarantee: never ship on drab defaults.
  if (!spec.meta.chartPalette?.length) spec.meta.chartPalette = ["#7c3aed", "#06b6d4", "#f59e0b", "#10b981", "#f43f5e", "#3b82f6"];
  if (!spec.meta.accent || !HEX_RE.test(spec.meta.accent)) spec.meta.accent = spec.meta.chartPalette[0];

  const plan = compileSpec(spec, datasets);
  if (!plan.sections.length) {
    return { status: 422, body: { error: "no valid widgets after validation", warnings: plan.warnings } };
  }

  const app = renderPlanToApp(plan);
  // Return the (post-coercion) spec the planner produced so the client can persist it
  // and pass it back as currentSpec on the next turn.
  return { status: 200, body: { app, spec, warnings: plan.warnings, summary: summarizeSpecChange(currentSpec, spec) } };
}

/** The brief's ANALYTICAL half (kpis + charts) as a directive for the spec
 *  planner — first builds get the orchestrator's content plan for free, no
 *  extra model call. */
export function briefToAnalyticalDirective(brief: any): string | null {
  if (!brief || typeof brief !== "object") return null;
  const bits: string[] = [];
  if (Array.isArray(brief.kpis) && brief.kpis.length) bits.push(`Headline KPI cards: ${brief.kpis.join("; ")}.`);
  if (Array.isArray(brief.charts) && brief.charts.length) {
    const cs = brief.charts.map((c: any) => `${c?.type ?? "chart"} of ${c?.y ?? "?"} by ${c?.x ?? "?"}${c?.why ? ` — ${c.why}` : ""}`).join("; ");
    bits.push(`Charts: ${cs}.`);
  }
  if (typeof brief.enhancedPrompt === "string" && brief.enhancedPrompt.trim()) bits.push(brief.enhancedPrompt.trim());
  return bits.length ? bits.join(" ") : null;
}

/** House-style coverage check: what a build is missing vs the minimums
 *  (>=4 charts across >=3 types, >=3 KPI cards) — scaled down when the data
 *  is too thin to support them (never demand padding). */
export function coverageShortfalls(spec: DashboardSpec, datasets: Dataset[]): string[] {
  const widgets = allWidgets(spec);
  const charts = widgets.filter((w: any) => w.kind === "chart");
  const kpis = widgets.filter((w: any) => w.kind === "kpi");
  const columnCount = datasets.reduce((n, d) => n + d.profile.columns.length, 0);
  const wantCharts = Math.min(4, Math.max(1, Math.floor(columnCount / 2)));
  const wantTypes = Math.min(3, wantCharts);
  const wantKpis = Math.min(3, Math.max(1, columnCount));
  const out: string[] = [];
  if (charts.length < wantCharts) out.push(`only ${charts.length} chart(s), need at least ${wantCharts} answering different questions`);
  const types = new Set(charts.map((c: any) => c.chart ?? c.type));
  if (charts.length >= wantCharts && types.size < wantTypes) out.push(`only ${types.size} chart type(s), use at least ${wantTypes} different types (bar/line/area/pie)`);
  if (kpis.length < wantKpis) out.push(`only ${kpis.length} KPI card(s), need at least ${wantKpis}`);
  return out;
}

/** Flatten an orchestrator brief into a one-line visual directive. Tolerant of
 *  partial/absent briefs — returns null when there is nothing useful. */
export function briefToStyleHints(brief: any): string | null {
  if (!brief || typeof brief !== "object") return null;
  const bits: string[] = [];
  const p = brief.palette;
  if (p && typeof p === "object") {
    if (p.primary) bits.push(`primary ${p.primary}`);
    if (p.accent) bits.push(`accent ${p.accent}`);
    if (Array.isArray(p.neutrals) && p.neutrals.length) bits.push(`neutrals ${p.neutrals.join(" ")}`);
    if (p.vibe) bits.push(`vibe: ${p.vibe}`);
  }
  if (typeof brief.designDirection === "string" && brief.designDirection.trim()) bits.push(brief.designDirection.trim());
  return bits.length ? bits.join(" · ") : null;
}

const allWidgets = (s: DashboardSpec) => s.sections.flatMap((sec) => sec.widgets ?? []);
const widgetKey = (w: any) => `${w.kind}:${w.title ?? ""}`;

/** Deterministic, human-readable description of what a build/edit turn changed —
 *  the assistant's reply, so it must sound like a person, not a title echo. */
export function summarizeSpecChange(prev: DashboardSpec | undefined, next: DashboardSpec): string[] {
  const out: string[] = [];
  if (!prev) {
    const n = allWidgets(next).length;
    out.push(`Built “${next.meta.title}” — ${n} widget${n === 1 ? "" : "s"} across ${next.sections.length} section${next.sections.length === 1 ? "" : "s"}.`);
    if (next.meta.theme === "dark") out.push("Dark theme.");
    if (next.meta.accent) out.push(`Accent ${next.meta.accent}.`);
    return out;
  }
  if (prev.meta.title !== next.meta.title) out.push(`Renamed to “${next.meta.title}”.`);
  if (prev.meta.theme !== next.meta.theme) out.push(`Switched to the ${next.meta.theme} theme.`);
  if (prev.meta.accent !== next.meta.accent && next.meta.accent) out.push(`Accent color set to ${next.meta.accent}.`);
  const prevPal = (prev.meta.chartPalette ?? []).join(",");
  const nextPal = (next.meta.chartPalette ?? []).join(",");
  if (prevPal !== nextPal && next.meta.chartPalette?.length) out.push(`Applied a ${next.meta.chartPalette.length}-color chart palette.`);
  const prevKeys = new Set(allWidgets(prev).map(widgetKey));
  const nextKeys = new Set(allWidgets(next).map(widgetKey));
  const added = [...nextKeys].filter((k) => !prevKeys.has(k));
  const removed = [...prevKeys].filter((k) => !nextKeys.has(k));
  const names = (ks: string[]) => ks.slice(0, 3).map((k) => `“${k.split(":").slice(1).join(":") || k}”`).join(", ") + (ks.length > 3 ? ` and ${ks.length - 3} more` : "");
  if (added.length) out.push(`Added ${names(added)}.`);
  if (removed.length) out.push(`Removed ${names(removed)}.`);
  if (!out.length) out.push("Updated the dashboard.");
  return out;
}