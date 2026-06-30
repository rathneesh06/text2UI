// bff/metrics.ts — Wave 4 / P6: cost & latency instrumentation.
//
// Captures token usage + latency for every model call and aggregates it per
// generation. Token counts are EXACT (from Gemini's usageMetadata); the dollar
// cost is an ESTIMATE from a configurable rate table (prices change — override
// via env). Collection uses AsyncLocalStorage so call sites don't have to thread
// a collector through every signature, and it's concurrency-safe across requests.

import { AsyncLocalStorage } from "node:async_hooks";
import type { TokenUsage, PhaseAgg, GenerationMetrics } from "../shared/types";
export type { TokenUsage, PhaseAgg, GenerationMetrics };

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export interface CallRecord {
  phase: string;   // "plan" | "build" | "classify" | "heal" | "edit" | ...
  model: string;
  usage: TokenUsage;
  ms: number;      // wall-clock latency of the call (including retries)
}

/** Per-1M-token rates (USD). Approximate defaults for Gemini Flash — override via
 *  GEMINI_PRICE_INPUT_PER_M / GEMINI_PRICE_OUTPUT_PER_M. Cost is an estimate;
 *  token counts are exact. */
export function rates(): { inputPerM: number; outputPerM: number } {
  return {
    inputPerM: Number(process.env.GEMINI_PRICE_INPUT_PER_M ?? 0.3),
    outputPerM: Number(process.env.GEMINI_PRICE_OUTPUT_PER_M ?? 2.5),
  };
}

export function estimateCost(usage: TokenUsage): number {
  const r = rates();
  const cost = (usage.inputTokens / 1e6) * r.inputPerM + (usage.outputTokens / 1e6) * r.outputPerM;
  return Math.round(cost * 1e6) / 1e6; // round to micro-dollars
}

/** Aggregate raw call records into a generation-level summary. */
export function summarize(records: CallRecord[]): GenerationMetrics {
  const usage: TokenUsage = { ...ZERO_USAGE };
  const byPhase: Record<string, PhaseAgg> = {};
  let ms = 0;
  let model = "";
  for (const r of records) {
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.totalTokens += r.usage.totalTokens;
    ms += r.ms;
    model = r.model || model;
    const p = (byPhase[r.phase] ??= { calls: 0, ms: 0, inputTokens: 0, outputTokens: 0 });
    p.calls += 1;
    p.ms += r.ms;
    p.inputTokens += r.usage.inputTokens;
    p.outputTokens += r.usage.outputTokens;
  }
  return {
    calls: records.length,
    ms,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costUsd: estimateCost(usage),
    model,
    byPhase,
  };
}

// ---- per-request collection (AsyncLocalStorage) ----------------------------
interface MetricsCtx { records: CallRecord[]; phase: string }
const store = new AsyncLocalStorage<MetricsCtx>();

/** Run `fn` inside a fresh metrics context; returns its result + the summary. */
export async function runWithMetrics<T>(fn: () => Promise<T>): Promise<{ result: T; metrics: GenerationMetrics }> {
  const ctx: MetricsCtx = { records: [], phase: "build" };
  const result = await store.run(ctx, fn);
  return { result, metrics: summarize(ctx.records) };
}

/** Tag subsequent calls with a phase label (no-op outside a metrics context). */
export function setPhase(phase: string): void {
  const ctx = store.getStore();
  if (ctx) ctx.phase = phase;
}

/** Record one model call (no-op outside a metrics context). */
export function recordCall(rec: { model: string; usage: TokenUsage; ms: number; phase?: string }): void {
  const ctx = store.getStore();
  if (!ctx) return;
  ctx.records.push({ phase: rec.phase ?? ctx.phase, model: rec.model, usage: rec.usage, ms: rec.ms });
}
