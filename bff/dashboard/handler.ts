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

  const spec = await planner({ datasets, userPrompt: b.userPrompt, currentSpec });
  if (!spec) return { status: 502, body: { error: "planner could not produce a dashboard spec" } };

  const plan = compileSpec(spec, datasets);
  if (!plan.sections.length) {
    return { status: 422, body: { error: "no valid widgets after validation", warnings: plan.warnings } };
  }

  const app = renderPlanToApp(plan);
  // Return the (post-coercion) spec the planner produced so the client can persist it
  // and pass it back as currentSpec on the next turn.
  return { status: 200, body: { app, spec, warnings: plan.warnings } };
}