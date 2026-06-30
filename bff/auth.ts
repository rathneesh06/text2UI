// bff/auth.ts — Wave 5 / P8 Step 2: bearer-token-per-tenant authentication.
//
// Tokens are configured via AUTH_TOKENS="tenantA:tokenA,tenantB:tokenB". A request
// presents `Authorization: Bearer <token>`; we resolve it to a tenantId and attach
// it to req.tenantId for downstream tenant-scoped storage (Step 3). When no tokens
// are configured the middleware is a dev bypass (tenant = "public"); production with
// no tokens is flagged by validateConfig().

import type { Request, Response, NextFunction } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantId?: string;
    }
  }
}

export const DEV_TENANT = "public";

/** Parse AUTH_TOKENS="tenantA:tokenA, tenantB:tokenB" into Map<token, tenantId>. */
export function parseAuthTokens(raw?: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? "").split(",")) {
    const s = pair.trim();
    if (!s) continue;
    const idx = s.indexOf(":");
    if (idx <= 0) continue; // need a non-empty tenant before the colon
    const tenant = s.slice(0, idx).trim();
    const token = s.slice(idx + 1).trim();
    if (tenant && token) map.set(token, tenant);
  }
  return map;
}

/** Extract a Bearer token from an Authorization header value. */
export function bearerToken(header?: string): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Resolve a tenant from an Authorization header given the configured token map. */
export function resolveTenant(authHeader: string | undefined, tokens: Map<string, string>): string | null {
  const tok = bearerToken(authHeader);
  if (!tok) return null;
  return tokens.get(tok) ?? null;
}

/**
 * Express middleware. With tokens configured, requires a valid Bearer token and
 * sets req.tenantId; otherwise 401. With NO tokens configured (dev), bypasses and
 * sets req.tenantId = "public".
 */
export function authMiddleware(tokens: Map<string, string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (tokens.size === 0) {
      req.tenantId = DEV_TENANT; // auth disabled (dev) — flagged in production by validateConfig
      return next();
    }
    const tenant = resolveTenant(req.headers["authorization"] as string | undefined, tokens);
    if (!tenant) {
      res.status(401).json({ error: "unauthorized: missing or invalid bearer token" });
      return;
    }
    req.tenantId = tenant;
    next();
  };
}
