// bff/design-rag/site-capture.test.ts — offline. Fake capture fn, no browser.
import assert from "node:assert";
import { makeSiteCaptureAdapter, SITE_SOURCES, type SiteCaptureConfig } from "./site-capture";
import { runImport } from "./import";
import { FakeEmbeddingClient } from "./embeddings";
import type { IngestStore } from "./ingest";

const cfg: SiteCaptureConfig = {
  name: "demo",
  baseUrl: "http://localhost:4173/",
  routes: [
    { path: "/", domainHint: "sales", width: 1440, height: 1100 },
    { path: "analytics", domainHint: "web_analytics" },
  ],
  license: "MIT",
  attribution: "Demo App",
  sourceUrl: "https://example/repo",
  settleMs: 2000,
};

// ---- yields one item per route, joins URLs, carries provenance -------------
{
  const seen: { url: string; opts: any }[] = [];
  const adapter = makeSiteCaptureAdapter(cfg, { capture: (url, opts) => { seen.push({ url, opts }); return Promise.resolve(Buffer.from(url)); } });
  const items: any[] = [];
  for await (const it of adapter.items()) items.push(it);

  assert.equal(items.length, 2, "one item per route");
  assert.deepEqual(seen.map((s) => s.url), ["http://localhost:4173/", "http://localhost:4173/analytics"], "URLs joined, no double slashes");
  assert.equal(seen[0].opts.width, 1440, "per-route viewport used");
  assert.equal(seen[1].opts.settleMs, 2000, "config default settle applied when route omits it");
  assert.equal(items[0].domainHint, "sales");
  assert.equal(items[0].license, "MIT");
  assert.equal(items[0].attribution, "Demo App");
  assert.equal(items[0].sourceUrl, "https://example/repo");
  assert.equal(items[0].mode, "dashboard");
  assert.equal(items[0].code, undefined, "full-app capture carries no code (density gate skipped)");
}

// ---- a failing route is skipped, run continues -----------------------------
{
  const errs: string[] = [];
  const adapter = makeSiteCaptureAdapter(cfg, {
    capture: (url) => url.endsWith("/analytics") ? Promise.reject(new Error("nav timeout")) : Promise.resolve(Buffer.from(url)),
    onError: (p) => errs.push(p),
  });
  const items: any[] = [];
  for await (const it of adapter.items()) items.push(it);
  assert.equal(items.length, 1, "only the good route yields");
  assert.deepEqual(errs, ["analytics"], "failed route reported, not thrown");
}

// ---- end-to-end through runImport ------------------------------------------
{
  const ingested: any[] = [];
  const adapter = makeSiteCaptureAdapter(cfg, { capture: (url) => Promise.resolve(Buffer.from(url)) });
  const s = await runImport(adapter, {
    store: {} as IngestStore,
    embed: new FakeEmbeddingClient(8),
    ingest: ((input: any) => { ingested.push(input); return Promise.resolve("inserted"); }) as any,
  });
  assert.equal(s.imported, 2);
  assert.equal(ingested[0].source, "import:demo", "tagged import:<name>");
  assert.equal(ingested[0].license, "MIT");
}

// ---- registry sanity: tailadmin captures "/" as a dashboard ----------------
{
  assert.ok(SITE_SOURCES.tailadmin, "tailadmin registered");
  assert.equal(SITE_SOURCES.tailadmin.license, "MIT");
  assert.ok(SITE_SOURCES.tailadmin.routes.some((r) => r.path === "/" && r.domainHint), "captures the root dashboard");
}

console.log("ok design-rag/site-capture");
