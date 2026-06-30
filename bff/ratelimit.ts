// bff/ratelimit.ts — Wave 5 / P8 Step 4: per-tenant rate limits + quotas.
//
// Two independent controls, both keyed by tenantId and both DISABLED by default
// (opt-in via env, like CORS/auth — so local dev is never throttled):
//   - request rate: at most `maxRequests` per `windowMs` (fixed window).
//   - usage quota: cumulative tokens / cost per `quotaWindowMs`, fed by P6 metrics.
//
// In-memory implementation behind the RateLimiter interface; a Redis/shared-store
// impl can drop in for multi-instance deploys without touching call sites.
// `now` is injectable so the logic is deterministically testable.

export interface UsageSample { tokens: number; costUsd: number }
export interface LimitDecision { allowed: boolean; reason?: string; retryAfterMs?: number }

export interface RateLimiter {
  /** Check + consume one request slot for the tenant. */
  checkRequest(tenantId: string, now?: number): LimitDecision;
  /** Check the tenant is under its token/cost quota (call before a generation). */
  checkQuota(tenantId: string, now?: number): LimitDecision;
  /** Record usage from a completed generation (from GenerationMetrics). */
  recordUsage(tenantId: string, sample: UsageSample, now?: number): void;
}

export interface RateLimitConfig {
  windowMs: number;      // request-rate window
  maxRequests: number;   // 0 = request limiting disabled
  quotaWindowMs: number; // usage-quota window
  maxTokens: number;     // 0 = token quota disabled
  maxCostUsd: number;    // 0 = cost quota disabled
}

export function rateLimitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    windowMs: Number(env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    maxRequests: Number(env.RATE_LIMIT_MAX ?? 0),
    quotaWindowMs: Number(env.QUOTA_WINDOW_MS ?? 86_400_000), // 24h
    maxTokens: Number(env.QUOTA_MAX_TOKENS ?? 0),
    maxCostUsd: Number(env.QUOTA_MAX_COST_USD ?? 0),
  };
}

interface ReqWindow { start: number; count: number }
interface QuotaWindow { start: number; tokens: number; costUsd: number }

export class InMemoryRateLimiter implements RateLimiter {
  private reqs = new Map<string, ReqWindow>();
  private quotas = new Map<string, QuotaWindow>();
  constructor(private readonly cfg: RateLimitConfig) {}

  checkRequest(tenantId: string, now: number = Date.now()): LimitDecision {
    if (this.cfg.maxRequests <= 0) return { allowed: true };
    const w = this.reqs.get(tenantId);
    if (!w || now - w.start >= this.cfg.windowMs) {
      this.reqs.set(tenantId, { start: now, count: 1 });
      return { allowed: true };
    }
    if (w.count >= this.cfg.maxRequests) {
      return { allowed: false, reason: "request rate limit exceeded", retryAfterMs: this.cfg.windowMs - (now - w.start) };
    }
    w.count += 1;
    return { allowed: true };
  }

  checkQuota(tenantId: string, now: number = Date.now()): LimitDecision {
    const { maxTokens, maxCostUsd, quotaWindowMs } = this.cfg;
    if (maxTokens <= 0 && maxCostUsd <= 0) return { allowed: true };
    const q = this.quotas.get(tenantId);
    if (!q || now - q.start >= quotaWindowMs) return { allowed: true }; // fresh window
    const retryAfterMs = quotaWindowMs - (now - q.start);
    if (maxTokens > 0 && q.tokens >= maxTokens) return { allowed: false, reason: "token quota exceeded", retryAfterMs };
    if (maxCostUsd > 0 && q.costUsd >= maxCostUsd) return { allowed: false, reason: "cost quota exceeded", retryAfterMs };
    return { allowed: true };
  }

  recordUsage(tenantId: string, sample: UsageSample, now: number = Date.now()): void {
    const q = this.quotas.get(tenantId);
    if (!q || now - q.start >= this.cfg.quotaWindowMs) {
      this.quotas.set(tenantId, { start: now, tokens: sample.tokens, costUsd: sample.costUsd });
      return;
    }
    q.tokens += sample.tokens;
    q.costUsd += sample.costUsd;
  }
}

/** 429 helper: send a rate/quota rejection with a Retry-After header. */
export function sendLimited(res: { status: (n: number) => any; setHeader: (k: string, v: string) => void; json: (b: any) => void }, d: LimitDecision): void {
  const secs = Math.max(1, Math.ceil((d.retryAfterMs ?? 1000) / 1000));
  res.setHeader("Retry-After", String(secs));
  res.status(429).json({ error: d.reason ?? "rate limit exceeded", retryAfterSeconds: secs });
}
