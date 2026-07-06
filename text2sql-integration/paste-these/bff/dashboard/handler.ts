// bff/dashboard/handler.ts — the spec-driven build endpoint. One call runs the whole
// pipeline: plan (or edit) a DashboardSpec, validate+compile it to SQL, and render it
// to a runnable app. It returns BOTH the app AND the spec; the client persists the
// spec and sends it back as `currentSpec` next turn, so each prompt edits the same
// dashboard. Pure handler (deps injectable) so it can be unit-tested without a server.
import type { Dataset } from "../../shared/types";
import type { DashboardSpec } from "../../shared/dashboard-spec";
import { planSpec, type PlanSpecInput } from "./planner";
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
  // The orchestrator's brief (palette + design direction) becomes a visual
  // directive for the spec planner — this is the junction that was missing:
  // the layer that made freeform builds feel good now reaches spec builds too.
  const styleHints = briefToStyleHints(b.brief);

  const spec = await planner({ datasets, userPrompt: b.userPrompt, currentSpec, ...(styleHints ? { styleHints } : {}) });
  if (!spec) return { status: 502, body: { error: "planner could not produce a dashboard spec" } };

  const plan = compileSpec(spec, datasets);
  if (!plan.sections.length) {
    return { status: 422, body: { error: "no valid widgets after validation", warnings: plan.warnings } };
  }

  const app = renderPlanToApp(plan);
  // Return the (post-coercion) spec the planner produced so the client can persist it
  // and pass it back as currentSpec on the next turn.
  return { status: 200, body: { app, spec, warnings: plan.warnings, summary: summarizeSpecChange(currentSpec, spec) } };
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