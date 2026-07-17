// bff/dashboard/handler.ts — the spec-driven build endpoint, restored and upgraded.
//
// One call runs the whole pipeline:
//
//   enhance (ALWAYS)  →  specialist agents (parallel)  →  merge  →  validate/compile  →  render
//                         kpi · bar · line · pie · table
//
//   1. The QUERY ENHANCEMENT LAYER (./enhance) runs on EVERY turn and produces the
//      baseline instructions deterministically — schema roles, house rules, coverage
//      minimums — regardless of how small the data or the prompt is. The best
//      available model directive (analyst evidence > orchestrator brief > LLM
//      rewrite) enriches it; none of them can suppress it.
//   2. BUILD turns fan out to the per-widget agents (./agents): separate focused
//      calls for KPI cards, bar charts, line/area trends, pie/donut compositions,
//      and tables, each with a deterministic profile-derived fallback. The merger
//      (./merge) assembles the harvest into one DashboardSpec.
//   3. EDIT turns keep the single-planner minimal-mutation path (./planner) — a
//      node-level edit of the persisted spec is one surgical change, not five
//      parallel proposals — with the enhancement layer's instructions attached.
//   4. The monolithic planner remains as a fallback for builds (kill-switch
//      DASHBOARD_AGENTS=0, or an empty harvest), so the endpoint's contract and
//      failure behavior only ever got stronger.
//
// It returns BOTH the app AND the spec; the client persists the spec and sends it
// back as `currentSpec` next turn, so each prompt edits the same dashboard.
// Pure handler (deps injectable) so it can be unit-tested without a server.
import type { Dataset } from "../../shared/types";
import type { DashboardSpec } from "../../shared/dashboard-spec";
import { planSpec, HEX_RE, type PlanSpecInput } from "./planner";
import { enhanceQuery, briefToStyleHints, briefToAnalyticalDirective, type Enhancement } from "./enhance";
import { runChartAgents, type AgentRun, type AgentHarvest } from "./agents";
import { decomposeQuery } from "./decompose";
import { mergeHarvest, DEFAULT_PALETTE } from "./merge";
import { compileSpec } from "./compile";
import { pushVersion, undo, redo, decisionsText, detectHistoryIntent, cursorIndex } from "./session";
import { reconcileEdit } from "./reconcile";
import { planEditOps, applyOps } from "./patch";
import { renderPlanToApp } from "./renderer";

// Re-exported so existing imports/tests keep working after the brief helpers
// moved into the enhancement layer where they belong.
export { briefToStyleHints, briefToAnalyticalDirective };

type Planner = (input: PlanSpecInput) => Promise<DashboardSpec | null>;
const AGENTS_ENABLED = (process.env.DASHBOARD_AGENTS ?? "1") === "1";

export interface HandlerDeps {
  planner?: Planner;
  agentRun?: AgentRun;
  /** injectable for tests: skip the enhancement layer's LLM rewrite */
  skipRewrite?: boolean;
}

export async function handleDashboardBuild(
  body: unknown,
  plannerOrDeps: Planner | HandlerDeps = {},
): Promise<{ status: number; body: any }> {
  // Back-compat: the old signature took the planner function directly. A directly
  // injected planner also PINS the planner path (tests inject fakes and must stay
  // offline — fanning out to the real agents would defeat the injection).
  const legacyPlannerInjected = typeof plannerOrDeps === "function";
  const deps: HandlerDeps = legacyPlannerInjected ? { planner: plannerOrDeps as Planner } : (plannerOrDeps as HandlerDeps);
  const planner = deps.planner ?? planSpec;

  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  if (!Array.isArray(b.datasets) || !b.datasets.length) return { status: 400, body: { error: "datasets[] is required" } };
  if (typeof b.userPrompt !== "string" || !b.userPrompt.trim()) return { status: 400, body: { error: "userPrompt is required" } };

  const datasets = b.datasets as Dataset[];
  const currentSpec = b.currentSpec as DashboardSpec | undefined;
  const conversationId: string = typeof b.conversationId === "string" ? b.conversationId : "";
  const selectedWidget = b.selectedWidget && typeof b.selectedWidget === "object"
    ? { id: b.selectedWidget.id ? String(b.selectedWidget.id) : undefined, title: b.selectedWidget.title ? String(b.selectedWidget.title) : undefined }
    : undefined;

  // ---- Diff History: undo/redo are deterministic, instant, and exact ----------
  // A bare "undo"/"redo" NEVER goes to a model — the session's version stack is
  // the truth, and re-rendering a stored spec cannot drift.
  const historyIntent = currentSpec && conversationId ? detectHistoryIntent(b.userPrompt) : null;
  if (historyIntent) {
    const v = historyIntent === "undo" ? undo(conversationId) : redo(conversationId);
    if (!v) {
      return { status: 200, body: { app: null, spec: currentSpec, warnings: [], noChange: true, pipeline: "history",
        summary: [historyIntent === "undo" ? "Nothing to undo — this is the earliest version I have." : "Nothing to redo — you are on the latest version."] } };
    }
    const plan = compileSpec(v.spec, datasets);
    if (!plan.sections.length) return { status: 422, body: { error: "stored version no longer valid for this data", warnings: plan.warnings } };
    const app = renderPlanToApp(plan);
    const n = cursorIndex(conversationId) + 1;
    console.log(`[dashboard] ${historyIntent} -> version ${n} ("${v.spec.meta.title}")`);
    return { status: 200, body: { app, spec: plan.spec, warnings: plan.warnings, pipeline: "history",
      summary: [`${historyIntent === "undo" ? "Reverted to" : "Restored"} version ${n} — the one from "${v.prompt.slice(0, 60)}".`] } };
  }

  // ---- Context Manager: the conversation reaches the edit planner -------------
  const chatContext = buildChatContext(b.history, conversationId);

  // ---- Stage 1: the query enhancement layer (always on, never null) ----------
  const enhancement = await enhanceQuery({
    datasets, userPrompt: b.userPrompt,
    ...(currentSpec ? { currentSpec } : {}),
    ...(b.brief ? { brief: b.brief } : {}),
    ...(typeof b.analystDirective === "string" ? { analystDirective: b.analystDirective } : {}),
    ...(deps.skipRewrite || legacyPlannerInjected ? { skipRewrite: true } : {}),
  });
  console.log(`[dashboard] directive source: ${enhancement.directiveSource} (${enhancement.combined.length} chars, baseline always applied)`);

  let spec: DashboardSpec | null = null;
  let pipeline: "agents" | "planner" | "patch" = "planner";

  if (!currentSpec && AGENTS_ENABLED && !legacyPlannerInjected) {
    // ---- Stage 2 (builds): parallel specialist agents + deterministic merge ----
    // QUERY BREAKDOWN LAYER: decompose the request into grounded analytical
    // tasks, routed to the agent families below. Trivial prompts skip the model
    // call; failures fall back to deterministic schema-derived tasks.
    const { tasks } = await decomposeQuery(datasets, b.userPrompt, enhancement.combined, deps.agentRun);
    const harvest = await runChartAgents(
      { datasets, userPrompt: b.userPrompt, directive: withStyle(enhancement), tasks },
      deps.agentRun,
    );
    const merged = mergeHarvest(harvest, datasets, b.userPrompt, mergeStyle(b.brief));
    if (countWidgets(merged) > 0) { spec = merged; pipeline = "agents"; }
    else console.warn("[dashboard] agent harvest empty — falling back to the monolithic planner");
  }

  let healedNotes: string[] = [];
  // ---- EDIT turns: patch-based by default (the Figma model) -------------------
  // The model emits a minimal op list against widget ids; application is
  // deterministic, so widgets not named in an op physically cannot change, and
  // removals are gated on explicit removal intent (or the selected widget).
  // Falls back to the full-spec planner + reconciliation if op planning fails.
  // Hermeticity rule: an injected planner WITHOUT an injected runner means the
  // caller (a test, or a legacy call site) wants the planner path — op planning
  // must not escape to the live API. Production (no deps) uses the real model;
  // op-planning tests inject agentRun.
  const opsPathEnabled = !legacyPlannerInjected && !(deps.planner && !deps.agentRun);
  if (!spec && currentSpec && opsPathEnabled) {
    const ops = await planEditOps(
      { datasets, userPrompt: b.userPrompt, currentSpec, chatContext, selectedWidget, directive: enhancement.styleHints ?? undefined },
      deps.agentRun,
    );
    if (ops) {
      const r = applyOps(currentSpec, ops, b.userPrompt, selectedWidget?.id);
      if (ops.length === 0) {
        // The model judged the request unactionable — better to say so than guess.
        return { status: 200, body: { app: null, spec: currentSpec, warnings: [], noChange: true, pipeline: "patch",
          summary: ["I wasn't sure what to change there — could you name the widget or describe the edit more specifically?"] } };
      }
      spec = r.spec;
      pipeline = "patch" as any;
      healedNotes = r.rejected;
      if (r.rejected.length) console.log(`[dashboard] ops rejected: ${r.rejected.join(" | ")}`);
    } else {
      console.warn("[dashboard] op planning failed — falling back to full-spec edit + reconciliation");
    }
  }
  if (!spec) {
    // ---- Planner path: edit turns, kill-switch, or agent-harvest fallback ------
    spec = await runPlannerPath(planner, datasets, b.userPrompt, enhancement, currentSpec, chatContext, selectedWidget);
    if (!spec) return { status: 502, body: { error: "planner could not produce a dashboard spec" } };
    // EDIT RECONCILIATION: the previous version is the truth for everything the
    // user didn't touch — heal any kept widget the model re-emitted with missing
    // required fields, BEFORE validation gets a chance to drop it. A style-only
    // edit can no longer gut the board because the model forgot the series arrays.
    if (currentSpec) {
      const r = reconcileEdit(currentSpec, spec);
      spec = r.spec;
      healedNotes = r.healed;
      if (r.healed.length) console.log(`[dashboard] edit reconciliation healed ${r.healed.length} field(s): ${r.healed.slice(0, 4).join(" | ")}${r.healed.length > 4 ? " | …" : ""}`);
    }
  }

  // Vibrancy guarantee: never ship on drab defaults.
  if (!spec.meta.chartPalette?.length) spec.meta.chartPalette = DEFAULT_PALETTE;
  if (!spec.meta.accent || !HEX_RE.test(spec.meta.accent)) spec.meta.accent = spec.meta.chartPalette[0];

  // ---- Stage 3: validate + compile to deterministic SQL, then render ----------
  const plan = compileSpec(spec, datasets);
  if (!plan.sections.length) {
    return { status: 422, body: { error: "no valid widgets after validation", warnings: plan.warnings } };
  }

  const app = renderPlanToApp(plan);
  // al5: return the VALIDATED spec — the one that actually rendered. Returning
  // the raw planner spec meant the summary counted widgets validation had
  // dropped ("5 widgets" for a 4-widget board) and the client persisted ghost
  // widgets as currentSpec, so the next edit turn reasoned about things that
  // were not on screen.
  const rendered = plan.spec;
  const dropped = allWidgets(spec).length - allWidgets(rendered).length;
  if (dropped > 0) console.log(`[dashboard] validation dropped ${dropped} widget(s): ${plan.warnings.join(" | ")}`);
  const warnings = [...healedNotes, ...plan.warnings];
  const summary = summarizeSpecChange(currentSpec, rendered);
  // Diff History: every accepted version enters the conversation's undo stack.
  if (conversationId) pushVersion(conversationId, rendered, summary.join(" "), b.userPrompt);
  return {
    status: 200,
    body: { app, spec: rendered, warnings, summary, pipeline },
  };
}

/** Render the recent conversation + rolling decisions for the edit planner.
 *  History arrives from the route (chat store) or the client; decisions come
 *  from this module's session. Either alone is still useful; both is best. */
function buildChatContext(history: unknown, conversationId: string): string | null {
  const parts: string[] = [];
  if (Array.isArray(history) && history.length) {
    const turns = history
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-8)
      .map((m: any) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content).slice(0, 220)}`);
    if (turns.length) parts.push(turns.join("\n"));
  }
  const d = decisionsText(conversationId);
  if (d) parts.push(d);
  return parts.length ? parts.join("\n\n") : null;
}

/** The enhancement's combined directive plus the visual direction, for the agents. */
function withStyle(e: Enhancement): string {
  return e.styleHints ? `${e.combined}\n\nVISUAL DIRECTION: ${e.styleHints}` : e.combined;
}

/** Pull concrete style choices out of an orchestrator brief for the merger. */
function mergeStyle(brief: any): { title?: string; subtitle?: string; accent?: string; chartPalette?: string[] } {
  const out: { title?: string; subtitle?: string; accent?: string; chartPalette?: string[] } = {};
  if (brief && typeof brief === "object") {
    if (typeof brief.title === "string" && brief.title.trim()) out.title = brief.title.trim();
    if (typeof brief.narrative === "string" && brief.narrative.trim()) out.subtitle = brief.narrative.trim().slice(0, 160);
    const p = brief.palette;
    if (p && typeof p === "object") {
      if (HEX_RE.test(String(p.primary ?? ""))) out.accent = String(p.primary);
      const pal = [p.primary, p.accent, ...(Array.isArray(p.neutrals) ? p.neutrals : [])]
        .map(String).filter((c) => HEX_RE.test(c));
      if (pal.length >= 3) out.chartPalette = pal.slice(0, 8);
    }
  }
  return out;
}

/** The original single-planner flow, kept intact: plan once, verify house-style
 *  coverage, one corrective retry when short, accept-with-warning otherwise. */
async function runPlannerPath(
  planner: Planner, datasets: Dataset[], userPrompt: string,
  enhancement: Enhancement, currentSpec?: DashboardSpec,
  chatContext?: string | null, selectedWidget?: { id?: string; title?: string },
): Promise<DashboardSpec | null> {
  const planOnce = (extra?: string) => planner({
    datasets,
    userPrompt: extra ? `${userPrompt}\n\n${extra}` : userPrompt,
    currentSpec,
    ...(enhancement.styleHints ? { styleHints: enhancement.styleHints } : {}),
    ...(chatContext ? { chatContext } : {}),
    ...(selectedWidget ? { selectedWidget } : {}),
    directive: enhancement.combined,   // the enhancement layer's guarantee: never absent
  });

  let spec = await planOnce();
  if (!spec) return null;

  const shortfalls = coverageShortfalls(spec, datasets);
  if (shortfalls.length && !currentSpec) {
    console.log(`[dashboard] coverage shortfall -> re-plan: ${shortfalls.join("; ")}`);
    const retry = await planOnce(`REVISE: the previous plan was insufficient — ${shortfalls.join("; ")}. Keep everything that was good; add what is missing.`);
    // Accept the retry when it is strictly better on EITHER axis: fewer
    // shortfalls, or the same count but more charts (the old test compared only
    // shortfall counts, so a genuinely richer retry was thrown away on a tie).
    if (retry) {
      const before = { gaps: shortfalls.length, charts: chartCount(spec) };
      const after = { gaps: coverageShortfalls(retry, datasets).length, charts: chartCount(retry) };
      if (after.gaps < before.gaps || (after.gaps <= before.gaps && after.charts > before.charts)) {
        spec = retry;
        console.log(`[dashboard] re-plan accepted: charts ${before.charts} -> ${after.charts}, gaps ${before.gaps} -> ${after.gaps}`);
      } else {
        console.log(`[dashboard] re-plan rejected (no improvement): charts ${after.charts}, gaps ${after.gaps}`);
      }
    }
  }
  return spec;
}

/** House-style coverage check: what a build is missing vs the minimums
 *  (>=4 charts across >=3 types, >=3 KPI cards) — scaled down when the data
 *  is too thin to support them (never demand padding). */
/** The REAL chart kinds. ChartWidget.kind is flat ("bar"|"line"|…), never the
 *  string "chart" — the old filter here tested for `kind === "chart"`, matched
 *  NOTHING, and so reported "0 charts" on every build: the coverage rule never
 *  fired, and KPI-only dashboards shipped unchallenged. */
const CHART_KINDS = new Set(["line", "bar", "area", "pie", "donut"]);

/** Charts in a spec, by the real flat kinds. */
function chartCount(spec: DashboardSpec): number {
  return allWidgets(spec).filter((w: any) => CHART_KINDS.has(w.kind)).length;
}

function countWidgets(spec: DashboardSpec): number {
  return allWidgets(spec).length;
}

export function coverageShortfalls(spec: DashboardSpec, datasets: Dataset[]): string[] {
  const widgets = allWidgets(spec);
  const charts = widgets.filter((w: any) => CHART_KINDS.has(w.kind));
  const kpis = widgets.filter((w: any) => w.kind === "kpi");
  const columnCount = datasets.reduce((n, d) => n + d.profile.columns.length, 0);
  const wantCharts = Math.min(4, Math.max(1, Math.floor(columnCount / 2)));
  const wantTypes = Math.min(3, wantCharts);
  const wantKpis = Math.min(3, Math.max(1, columnCount));
  const out: string[] = [];
  if (charts.length < wantCharts) out.push(`only ${charts.length} chart(s), need at least ${wantCharts} answering different questions`);
  const types = new Set(charts.map((c: any) => c.kind));
  if (charts.length >= wantCharts && types.size < wantTypes) out.push(`only ${types.size} chart type(s), use at least ${wantTypes} different types (bar/line/area/pie)`);
  if (kpis.length < wantKpis) out.push(`only ${kpis.length} KPI card(s), need at least ${wantKpis}`);
  return out;
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
