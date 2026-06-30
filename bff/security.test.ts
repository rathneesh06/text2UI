import assert from "node:assert";
import { parseAllowedOrigins, corsOptions, securityHeaders, validateConfig } from "./security";

// ---- parseAllowedOrigins ---------------------------------------------------
{
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(""), []);
  assert.deepEqual(parseAllowedOrigins("https://a.com, https://b.com ,"), ["https://a.com", "https://b.com"]);
}

// ---- corsOptions -----------------------------------------------------------
{
  // empty allowlist -> open
  const open = corsOptions([]);
  assert.equal(open.origin, true, "empty allowlist reflects any origin");

  // non-empty -> function gate
  const gated = corsOptions(["https://app.example.com"]);
  const fn = gated.origin as (o: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => void;

  let allowedNoOrigin = false;
  fn(undefined, (e, ok) => { allowedNoOrigin = !e && !!ok; });
  assert.ok(allowedNoOrigin, "no Origin header (curl/server) is allowed");

  let allowedListed = false;
  fn("https://app.example.com", (e, ok) => { allowedListed = !e && !!ok; });
  assert.ok(allowedListed, "listed origin allowed");

  let rejected = false;
  fn("https://evil.com", (e) => { rejected = !!e; });
  assert.ok(rejected, "unlisted origin rejected");
}

// ---- securityHeaders -------------------------------------------------------
{
  const mw = securityHeaders();
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as any;
  let nexted = false;
  mw({} as any, res, () => { nexted = true; });
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.ok(nexted, "calls next()");
}

// ---- validateConfig --------------------------------------------------------
{
  assert.equal(validateConfig({ GEMINI_API_KEY: "k" } as any).ok, true);

  const missing = validateConfig({} as any);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /GEMINI_API_KEY/.test(e)));

  const prodLoose = validateConfig({ GEMINI_API_KEY: "k", NODE_ENV: "production" } as any);
  assert.equal(prodLoose.ok, true, "loose CORS is a warning, not an error");
  assert.ok(prodLoose.warnings.some((w) => /ALLOWED_ORIGINS/.test(w)));
  assert.ok(prodLoose.warnings.some((w) => /AUTH_TOKENS/.test(w)), "warns when auth unconfigured in prod");

  const prodTight = validateConfig({ GEMINI_API_KEY: "k", NODE_ENV: "production", ALLOWED_ORIGINS: "https://app.com", AUTH_TOKENS: "acme:tok" } as any);
  assert.equal(prodTight.warnings.length, 0, "tight prod config: no warnings");
}

console.log("security.test.ts: all assertions passed");
