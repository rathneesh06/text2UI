// bff/design-rag/enroll.test.ts — offline. Injected scorer/render/ingest.
import assert from "node:assert";
import { enrollGeneration, type EnrollDeps } from "./enroll";
import { FakeEmbeddingClient } from "./embeddings";
import type { IngestStore } from "./ingest";
import type { AppScore } from "../eval/scorers";
import type { Dataset, GeneratedApp } from "../../shared/types";

const app: GeneratedApp = { files: [{ path: "App.tsx", content: "export default ()=>null;" }] } as GeneratedApp;
const datasets: Dataset[] = [{ tableName: "sales", profile: { columns: [{ name: "region" }, { name: "amount" }] } as any }];

const scoreOf = (over: Partial<AppScore> = {}): AppScore => ({
  pass: true, score: 0.9,
  results: [{ dimension: "leakage", hard: false, pass: true, detail: "" }],
  ...over,
});

function makeRender() {
  const calls: string[] = [];
  const fn = (code: string) => { calls.push(code); return Promise.resolve(Buffer.from("PNG:" + code)); };
  return { fn, calls };
}
function makeIngest(result: "inserted" | "skipped" | "failed" = "inserted") {
  const calls: any[] = [];
  const fn = (input: any) => { calls.push(input); return Promise.resolve(result); };
  return { fn: fn as any, calls };
}

const baseDeps = (over: Partial<EnrollDeps> = {}): EnrollDeps => ({
  enabled: true,
  store: {} as IngestStore,
  embed: new FakeEmbeddingClient(8),
  scorer: () => scoreOf(),
  ...over,
});

// ---- flag OFF / no store -> skipped, nothing runs --------------------------
{
  const r = makeRender();
  const off = await enrollGeneration(app, datasets, "sales", baseDeps({ enabled: false, render: r.fn }));
  assert.equal(off, "skipped");
  assert.equal(r.calls.length, 0, "disabled -> no render");

  const noStore = await enrollGeneration(app, datasets, "sales", baseDeps({ store: null, render: r.fn }));
  assert.equal(noStore, "skipped");
}

// ---- gate rejections: HARD fail / leakage fail / below floor ---------------
{
  const r = makeRender();
  const ing = makeIngest();
  const deps = baseDeps({ render: r.fn, ingest: ing.fn });

  const hardFail = await enrollGeneration(app, datasets, "sales", { ...deps, scorer: () => scoreOf({ pass: false }) });
  assert.equal(hardFail, "rejected", "HARD failure -> rejected");

  const leak = await enrollGeneration(app, datasets, "sales", {
    ...deps, scorer: () => scoreOf({ results: [{ dimension: "leakage", hard: false, pass: false, detail: "" }] }),
  });
  assert.equal(leak, "rejected", "leakage failure -> rejected");

  const low = await enrollGeneration(app, datasets, "sales", { ...deps, scorer: () => scoreOf({ score: 0.3 }), minQuality: 0.6 });
  assert.equal(low, "rejected", "below quality floor -> rejected");

  const sprawl = await enrollGeneration(app, datasets, "sales", {
    ...deps, scorer: () => scoreOf({ results: [
      { dimension: "leakage", hard: false, pass: true, detail: "" },
      { dimension: "layout", hard: false, pass: false, detail: "sprawl" },
    ] }),
  });
  assert.equal(sprawl, "rejected", "sprawling layout -> rejected (kept out of corpus)");

  assert.equal(r.calls.length, 0, "rejected -> never renders");
  assert.equal(ing.calls.length, 0, "rejected -> never ingests");
}

// ---- happy path: render -> ingest with generation source + quality ---------
{
  const r = makeRender();
  const ing = makeIngest("inserted");
  const out = await enrollGeneration(app, datasets, "finance", baseDeps({ scorer: () => scoreOf({ score: 0.83 }), render: r.fn, ingest: ing.fn }));
  assert.equal(out, "enrolled");
  assert.equal(r.calls[0], "export default ()=>null;", "renders the app's main file");
  assert.equal(ing.calls.length, 1);
  assert.equal(ing.calls[0].source, "generation", "stored as a generation reference");
  assert.equal(ing.calls[0].domainHint, "finance");
  assert.equal(ing.calls[0].quality, 0.83, "quality = the gating score");
  assert.equal(ing.calls[0].png.toString(), "PNG:export default ()=>null;", "renders synthetic-data screenshot");
}

// ---- render failure / dedup -> swallowed statuses --------------------------
{
  const failed = await enrollGeneration(app, datasets, "sales", baseDeps({ render: () => Promise.reject(new Error("no browser")), ingest: makeIngest().fn }));
  assert.equal(failed, "failed", "render error -> failed (swallowed)");

  const deduped = await enrollGeneration(app, datasets, "sales", baseDeps({ render: makeRender().fn, ingest: makeIngest("skipped").fn }));
  assert.equal(deduped, "skipped", "ingest dedup -> skipped");
}

console.log("ok design-rag/enroll");
