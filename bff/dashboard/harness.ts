// bff/dashboard/harness.ts — Phase D: the scenario-replay harness.
//
// replayTurn re-runs a RECORDED turn fully offline: the recorded model
// responses are fed back in order through a scripted runner, the pipeline runs
// for real (decompose → agents → merge → validate → compile, or the edit
// path), and the resulting spec is diffed against the recorded one. Zero diffs
// = the deterministic layer reproduces the turn exactly. This is BOTH the
// regression control (replay yesterday's turns after any change) AND the
// migration parity tool from the assessment doc (replay the same turns through
// a published-tool flow and diff).
//
// Widget/section ids are freshly randomized on every run, so specs are
// normalized (ids → stable positional tokens) before diffing — a diff is a
// SEMANTIC difference, never id noise.
import { readFileSync } from "node:fs";
import { handleDashboardBuild } from "./handler";
import { replayFile, type ModelIO, type ReplayTurnRecord } from "./replay-capture";

export function loadReplayTurns(file = replayFile()): ReplayTurnRecord[] {
  const out: ReplayTurnRecord[] = [];
  let raw = "";
  try { raw = readFileSync(file, "utf-8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r?.v === 1 && r.body && r.spec) out.push(r); } catch { /* skip corrupt lines */ }
  }
  return out;
}

/** ids → positional tokens (#1, #2, …) in first-seen order, applied to every
 *  string property literally named "id". Everything else compares verbatim. */
export function normalizeSpec(spec: unknown): unknown {
  const seen = new Map<string, string>();
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "id" && typeof val === "string") {
          if (!seen.has(val)) seen.set(val, `#${seen.size + 1}`);
          out[k] = seen.get(val);
        } else out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(spec);
}

/** First differing paths between two normalized values (≤ maxPaths). */
export function diffSpecs(a: unknown, b: unknown, maxPaths = 5): string[] {
  const diffs: string[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    if (diffs.length >= maxPaths) return;
    if (Array.isArray(x) || Array.isArray(y)) {
      const ax = Array.isArray(x) ? x : []; const ay = Array.isArray(y) ? y : [];
      if (ax.length !== ay.length) { diffs.push(`${p}.length ${ax.length} != ${ay.length}`); return; }
      ax.forEach((v, i) => walk(v, ay[i], `${p}[${i}]`));
      return;
    }
    if (x && y && typeof x === "object" && typeof y === "object") {
      const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
      for (const k of keys) walk((x as any)[k], (y as any)[k], p ? `${p}.${k}` : k);
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`${p}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`);
  };
  walk(normalizeSpec(a), normalizeSpec(b), "");
  return diffs;
}

export interface ReplayResult { turnId: string; pipeline: string; ok: boolean; diffs: string[]; note?: string }

/** Re-run one recorded turn offline and diff the specs. The scripted runner
 *  replays responses IN ORDER; a recorded failure re-throws (reproducing the
 *  fallback the original turn took); an exhausted log throws (surfacing, as a
 *  diff, any code change that now makes MORE model calls than the recording). */
export async function replayTurn(rec: ReplayTurnRecord): Promise<ReplayResult> {
  const queue: ModelIO[] = [...(rec.model ?? [])];
  const scripted = async () => {
    const next = queue.shift();
    if (!next) throw new Error("replay: model log exhausted — the pipeline now makes more model calls than the recording");
    if (next.failed) throw new Error("replay: recorded model failure");
    return { text: next.text, finishReason: "STOP" } as any;
  };
  const { status, body } = await handleDashboardBuild(
    {
      ...(rec.body as any).currentSpec ? { currentSpec: (rec.body as any).currentSpec } : {},
      datasets: (rec.body as any).datasets,
      userPrompt: (rec.body as any).userPrompt,
      history: (rec.body as any).history ?? undefined,
      brief: (rec.body as any).brief ?? undefined,
      selectedWidget: (rec.body as any).selectedWidget ?? undefined,
      conversationId: `replay_${rec.turnId}`,
    } as any,
    { agentRun: scripted as any, skipRewrite: true },
  );
  if (status !== 200 || !(body as any)?.spec) {
    return { turnId: rec.turnId, pipeline: rec.pipeline, ok: false, diffs: [`replay returned status ${status}`] };
  }
  const diffs = diffSpecs(rec.spec, (body as any).spec);
  const note = rec.pipeline === "planner"
    ? "planner-fallback turn: the capture-time directive may have used the live rewriter; small diffs can be environmental"
    : undefined;
  return { turnId: rec.turnId, pipeline: rec.pipeline, ok: diffs.length === 0, diffs, note };
}

// ---- Data-anomaly probe (the negative-average-age acceptance case) ------------------
export interface CompiledKpiLike { id: string; title: string; sql: string; format?: string }
export interface AnomalyFlag { id: string; title: string; value: number; reason: string }

/** Execute compiled KPI SQL and flag values that are numerically valid but
 *  physically impossible — the class the negative avg ticket age belonged to:
 *  a DURATION (hours/days format) can never be negative; a reversed timestamp
 *  subtraction upstream is the usual culprit. The pipeline renders honestly
 *  either way; this probe is the harness saying the DATA is lying. */
export async function flagDataAnomalies(
  kpis: CompiledKpiLike[],
  exec: (sql: string) => Promise<Record<string, unknown>[]>,
): Promise<AnomalyFlag[]> {
  const flags: AnomalyFlag[] = [];
  for (const k of kpis) {
    if (k.format !== "hours" && k.format !== "days") continue;
    try {
      const rows = await exec(k.sql);
      const v = Number(rows?.[0]?.value);
      if (Number.isFinite(v) && v < 0) {
        flags.push({ id: k.id, title: k.title, value: v,
          reason: `${k.format}-formatted metric is negative (${v}) — durations cannot be negative; check for reversed timestamp subtraction upstream` });
      }
    } catch { /* execution problems are the guard stack's job, not the probe's */ }
  }
  return flags;
}
