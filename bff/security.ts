// bff/security.ts — Wave 5 / P8 Step 1: security hardening.
//
// Pure, testable helpers wired into createServer():
//  - CORS allowlist from ALLOWED_ORIGINS (open in dev, restricted when set)
//  - baseline security response headers (no new dependency)
//  - startup config validation (fail fast on missing secrets; warn on loose prod config)

import type { CorsOptions } from "cors";
import type { Request, Response, NextFunction } from "express";

/** Parse a comma-separated origin allowlist. Empty -> no restriction (dev default). */
export function parseAllowedOrigins(raw?: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** CORS options. Empty allowlist reflects any origin (dev); a non-empty list restricts. */
export function corsOptions(allowed: string[]): CorsOptions {
  if (!allowed.length) {
    return { origin: true, credentials: true };
  }
  return {
    credentials: true,
    origin(origin, cb) {
      // Non-browser clients (curl, server-to-server) send no Origin — allow them.
      if (!origin || allowed.includes(origin)) return cb(null, true);
      cb(new Error(`origin not allowed by CORS: ${origin}`));
    },
  };
}

/** Baseline security headers for the JSON API (no framing, no sniffing, no referrer leak). */
export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-DNS-Prefetch-Control", "off");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    next();
  };
}

export interface ConfigCheck { ok: boolean; errors: string[]; warnings: string[] }

/** Validate environment at startup. Errors should stop the server; warnings just log. */
export function validateConfig(env: NodeJS.ProcessEnv = process.env): ConfigCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!env.GEMINI_API_KEY) errors.push("GEMINI_API_KEY is not set (the BFF cannot call the model).");

  const prod = env.NODE_ENV === "production";
  if (prod) {
    if (!parseAllowedOrigins(env.ALLOWED_ORIGINS).length) {
      warnings.push("ALLOWED_ORIGINS is empty in production — CORS will accept any origin. Set an allowlist.");
    }
    if (!(env.AUTH_TOKENS ?? "").trim()) {
      warnings.push("AUTH_TOKENS is empty in production — the API is unauthenticated. Configure tenant tokens.");
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Print the config check; throw if invalid so the process fails fast in production. */
export function applyConfigCheck(check: ConfigCheck, prod = process.env.NODE_ENV === "production"): void {
  for (const w of check.warnings) console.warn(`[config] WARNING: ${w}`);
  if (!check.ok) {
    for (const e of check.errors) console.error(`[config] ERROR: ${e}`);
    if (prod) throw new Error("invalid configuration — refusing to start in production");
  }
}
