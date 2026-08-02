// bff/dashboard/replay-capture.ts — Phase D: record what a turn NEEDS to be
// replayed. Two pieces: a wrapper that logs every model call's response, and a
// JSONL recorder for the turn's full input + output. Capture is opt-in
// (T2UI_REPLAY_CAPTURE=1), fire-and-forget (can never fail a build), and
// writes to {T2UI_AUDIT_DIR|.t2ui}/replay.jsonl — separate from audit.jsonl
// because replay lines are big (they carry dataset profiles and the spec).
//
// This file must not import the handler (the harness imports both).
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { callGemini, type GenOptions, type GenResult } from "../aiflow";

export type AnyRun = (system: string, user: string, opts?: GenOptions) => Promise<GenResult>;

export interface ModelIO { system: string; text: string; failed?: boolean }

export function replayCaptureEnabled(): boolean {
  return process.env.T2UI_REPLAY_CAPTURE === "1";
}

export function replayFile(): string {
  return path.join(process.env.T2UI_AUDIT_DIR || "./.t2ui", "replay.jsonl");
}

/** Wrap a runner (or the default Gemini caller) so every call's response is
 *  logged in order. Failures are logged too — a replay must reproduce the
 *  fallback path a failure caused, not paper over it. */
export function captureRunner(inner?: AnyRun): { run: AnyRun; log: ModelIO[] } {
  const base = inner ?? callGemini;
  const log: ModelIO[] = [];
  const run: AnyRun = async (system, user, opts) => {
    try {
      const r = await base(system, user, opts);
      log.push({ system: system.slice(0, 80), text: String(r?.text ?? "") });
      return r;
    } catch (err) {
      log.push({ system: system.slice(0, 80), text: "", failed: true });
      throw err;
    }
  };
  return { run, log };
}

export interface ReplayTurnRecord {
  v: 1;
  at: string;
  turnId: string;
  pipeline: string;
  body: {
    userPrompt: string;
    datasets: unknown;
    currentSpec: unknown;
    history: unknown;
    brief: unknown;
    selectedWidget: unknown;
    conversationId: string;
  };
  model: ModelIO[];
  spec: unknown;
  warnings: string[];
}

/** Append one replayable turn. Never throws. */
export function recordTurn(rec: ReplayTurnRecord): void {
  try {
    mkdirSync(path.dirname(replayFile()), { recursive: true });
    appendFileSync(replayFile(), JSON.stringify(rec) + "\n", "utf-8");
  } catch { /* capture can never fail a build */ }
}
