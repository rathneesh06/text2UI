import assert from "node:assert";
import { parseAuthTokens, bearerToken, resolveTenant, authMiddleware, DEV_TENANT } from "./auth";

// ---- parseAuthTokens -------------------------------------------------------
{
  assert.equal(parseAuthTokens(undefined).size, 0);
  assert.equal(parseAuthTokens("").size, 0);
  const m = parseAuthTokens("tenantA:tokA, tenantB:tokB ,bad, :nope, tenantC:");
  assert.equal(m.size, 2, "only well-formed pairs kept");
  assert.equal(m.get("tokA"), "tenantA");
  assert.equal(m.get("tokB"), "tenantB");
  // colons inside the token are preserved (split on first colon only)
  assert.equal(parseAuthTokens("t:a:b:c").get("a:b:c"), "t");
}

// ---- bearerToken -----------------------------------------------------------
{
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer  xyz "), "xyz");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(""), null);
}

// ---- resolveTenant ---------------------------------------------------------
{
  const tokens = parseAuthTokens("acme:secret1,globex:secret2");
  assert.equal(resolveTenant("Bearer secret1", tokens), "acme");
  assert.equal(resolveTenant("Bearer secret2", tokens), "globex");
  assert.equal(resolveTenant("Bearer wrong", tokens), null);
  assert.equal(resolveTenant(undefined, tokens), null);
}

// ---- authMiddleware: dev bypass (no tokens) --------------------------------
{
  const mw = authMiddleware(parseAuthTokens(""));
  const req: any = { headers: {} };
  let nexted = false;
  mw(req, {} as any, () => { nexted = true; });
  assert.ok(nexted, "dev bypass calls next()");
  assert.equal(req.tenantId, DEV_TENANT, "dev bypass sets public tenant");
}

// ---- authMiddleware: enforced (tokens configured) --------------------------
{
  const mw = authMiddleware(parseAuthTokens("acme:secret1"));

  // valid token -> sets tenant, next()
  {
    const req: any = { headers: { authorization: "Bearer secret1" } };
    let nexted = false;
    mw(req, {} as any, () => { nexted = true; });
    assert.ok(nexted, "valid token proceeds");
    assert.equal(req.tenantId, "acme");
  }

  // missing/invalid token -> 401, no next()
  for (const header of [undefined, "Bearer nope", "Basic x"]) {
    const req: any = { headers: header ? { authorization: header } : {} };
    let status = 0; let payload: any = null; let nexted = false;
    const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { payload = b; } };
    mw(req, res, () => { nexted = true; });
    assert.equal(status, 401, `rejects: ${header ?? "(no header)"}`);
    assert.ok(/unauthorized/i.test(payload?.error ?? ""), "401 carries a clear error");
    assert.ok(!nexted, "does not call next() on reject");
    assert.equal(req.tenantId, undefined, "no tenant set on reject");
  }
}

console.log("auth.test.ts: all assertions passed");
