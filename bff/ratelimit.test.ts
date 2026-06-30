import assert from "node:assert";
import { InMemoryRateLimiter, rateLimitConfigFromEnv, type RateLimitConfig } from "./ratelimit";

const cfg = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  windowMs: 1000, maxRequests: 0, quotaWindowMs: 10_000, maxTokens: 0, maxCostUsd: 0, ...over,
});

// ---- disabled by default ---------------------------------------------------
{
  const rl = new InMemoryRateLimiter(cfg());
  for (let i = 0; i < 100; i++) assert.ok(rl.checkRequest("t", 0).allowed, "request limiting off by default");
  rl.recordUsage("t", { tokens: 1e9, costUsd: 1e9 }, 0);
  assert.ok(rl.checkQuota("t", 0).allowed, "quota off by default");
}

// ---- request rate limit (fixed window) -------------------------------------
{
  const rl = new InMemoryRateLimiter(cfg({ windowMs: 1000, maxRequests: 3 }));
  assert.ok(rl.checkRequest("a", 0).allowed);
  assert.ok(rl.checkRequest("a", 100).allowed);
  assert.ok(rl.checkRequest("a", 200).allowed);
  const blocked = rl.checkRequest("a", 300);
  assert.equal(blocked.allowed, false, "4th request in window blocked");
  assert.ok((blocked.retryAfterMs ?? 0) > 0, "carries retryAfter");
  assert.ok(/rate limit/.test(blocked.reason ?? ""));
  // a different tenant is independent
  assert.ok(rl.checkRequest("b", 300).allowed, "per-tenant windows");
  // window resets
  assert.ok(rl.checkRequest("a", 1000).allowed, "window reset after windowMs");
}

// ---- token quota -----------------------------------------------------------
{
  const rl = new InMemoryRateLimiter(cfg({ maxTokens: 1000, quotaWindowMs: 10_000 }));
  assert.ok(rl.checkQuota("a", 0).allowed, "under quota initially");
  rl.recordUsage("a", { tokens: 600, costUsd: 0 }, 0);
  assert.ok(rl.checkQuota("a", 1).allowed, "still under after 600");
  rl.recordUsage("a", { tokens: 600, costUsd: 0 }, 2); // total 1200 >= 1000
  const over = rl.checkQuota("a", 3);
  assert.equal(over.allowed, false, "token quota exceeded");
  assert.ok(/token quota/.test(over.reason ?? ""));
  // resets after the quota window
  assert.ok(rl.checkQuota("a", 10_001).allowed, "quota window resets");
}

// ---- cost quota ------------------------------------------------------------
{
  const rl = new InMemoryRateLimiter(cfg({ maxCostUsd: 1.0 }));
  rl.recordUsage("a", { tokens: 0, costUsd: 0.7 }, 0);
  assert.ok(rl.checkQuota("a", 1).allowed);
  rl.recordUsage("a", { tokens: 0, costUsd: 0.5 }, 2); // 1.2 >= 1.0
  assert.equal(rl.checkQuota("a", 3).allowed, false, "cost quota exceeded");
  assert.ok(/cost quota/.test(rl.checkQuota("a", 3).reason ?? ""));
}

// ---- config from env -------------------------------------------------------
{
  const c = rateLimitConfigFromEnv({ RATE_LIMIT_MAX: "120", QUOTA_MAX_TOKENS: "5000000" } as any);
  assert.equal(c.maxRequests, 120);
  assert.equal(c.maxTokens, 5_000_000);
  assert.equal(c.windowMs, 60_000, "default window");
  assert.equal(rateLimitConfigFromEnv({} as any).maxRequests, 0, "off by default");
}

console.log("ratelimit.test.ts: all assertions passed");
