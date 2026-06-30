// bff/design-rag/gallery.test.ts — offline. Fake renderers, no browser.
import assert from "node:assert";
import { makeGalleryAdapter, type GallerySpec } from "./gallery";
import { RECHARTS_SPECS } from "./gallery-recharts";
import { ECHARTS_SPECS } from "./gallery-echarts";
import { runImport } from "./import";
import { FakeEmbeddingClient } from "./embeddings";
import type { IngestStore } from "./ingest";

const specs: GallerySpec[] = [
  { id: "r1", renderer: "recharts", code: "<grid/>", domainHint: "sales", license: "MIT", attribution: "Recharts" },
  { id: "e1", renderer: "echarts", code: "{series:[]}", domainHint: "finance", license: "Apache-2.0", attribution: "ECharts" },
];

// ---- routes specs to the right renderer; code only for recharts ------------
{
  const rcalls: string[] = [], ecalls: string[] = [];
  const adapter = makeGalleryAdapter("test", specs, {
    renderRecharts: (c) => { rcalls.push(c); return Promise.resolve(Buffer.from("R")); },
    renderEcharts: (o) => { ecalls.push(o); return Promise.resolve(Buffer.from("E")); },
  });
  const items: any[] = [];
  for await (const it of adapter.items()) items.push(it);

  assert.equal(items.length, 2);
  assert.deepEqual(rcalls, ["<grid/>"], "recharts spec -> recharts renderer");
  assert.deepEqual(ecalls, ["{series:[]}"], "echarts spec -> echarts renderer");
  assert.equal(items[0].code, "<grid/>", "recharts item carries code (density gate applies)");
  assert.equal(items[1].code, undefined, "echarts item has no code (no density gate)");
  assert.equal(items[0].license, "MIT");
  assert.equal(items[1].license, "Apache-2.0");
  assert.equal(items[0].domainHint, "sales");
}

// ---- a render failure is reported and skipped ------------------------------
{
  const errs: string[] = [];
  const adapter = makeGalleryAdapter("test", specs, {
    renderRecharts: () => Promise.reject(new Error("transpile fail")),
    renderEcharts: () => Promise.resolve(Buffer.from("E")),
    onError: (id) => errs.push(id),
  });
  const items: any[] = [];
  for await (const it of adapter.items()) items.push(it);
  assert.deepEqual(errs, ["r1"], "failed spec reported");
  assert.equal(items.length, 1, "only the echarts spec yields");
}

// ---- end-to-end through runImport ------------------------------------------
{
  const ingested: any[] = [];
  const adapter = makeGalleryAdapter("test", specs, {
    renderRecharts: () => Promise.resolve(Buffer.from("R")),
    renderEcharts: () => Promise.resolve(Buffer.from("E")),
  });
  const s = await runImport(adapter, {
    store: {} as IngestStore, embed: new FakeEmbeddingClient(8),
    ingest: ((i: any) => { ingested.push(i); return Promise.resolve("inserted"); }) as any,
    densityGate: false, // fake code isn't real TSX; gate tested elsewhere
  });
  assert.equal(s.imported, 2);
  assert.equal(ingested[0].source, "import:test");
}

// ---- shipped specs are well-formed -----------------------------------------
{
  const all = [...RECHARTS_SPECS, ...ECHARTS_SPECS];
  assert.ok(RECHARTS_SPECS.length >= 3 && ECHARTS_SPECS.length >= 3, "have a starter set");
  for (const s of all) {
    assert.ok(s.id && s.code.trim().length > 0, `${s.id}: has code`);
    assert.ok(s.license && s.attribution, `${s.id}: has provenance`);
    assert.ok(s.renderer === "recharts" || s.renderer === "echarts", `${s.id}: valid renderer`);
  }
  assert.ok(RECHARTS_SPECS.every((s) => s.code.includes("grid-cols")), "recharts specs use a grid (compact)");
  assert.ok(ECHARTS_SPECS.every((s) => s.code.includes("series")), "echarts specs are option objects");
}

console.log("ok design-rag/gallery");
