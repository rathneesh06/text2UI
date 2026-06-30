// bff/design-rag/import.test.ts — offline. Fake adapter + fake ingest.
import assert from "node:assert";
import { runImport, type DesignSourceAdapter, type ImportItem, type ImportDeps } from "./import";
import { FakeEmbeddingClient } from "./embeddings";
import type { IngestStore } from "./ingest";

function adapterOf(items: ImportItem[]): DesignSourceAdapter {
  return { name: "test", async *items() { for (const it of items) yield it; } };
}
function makeIngest(seq: ("inserted" | "skipped" | "failed")[]) {
  const calls: any[] = [];
  let i = 0;
  const fn = (input: any) => { calls.push(input); return Promise.resolve(seq[Math.min(i++, seq.length - 1)]); };
  return { fn: fn as any, calls };
}
const baseDeps = (over: Partial<ImportDeps> = {}): ImportDeps => ({
  store: {} as IngestStore, embed: new FakeEmbeddingClient(8), ...over,
});

const grid = `<div className="grid grid-cols-2"><ResponsiveContainer/><ResponsiveContainer/><ResponsiveContainer/></div>`;
const sprawl = `<div><ResponsiveContainer/><ResponsiveContainer/><ResponsiveContainer/></div>`;

// ---- happy path: source tag, provenance, gold-standard quality -------------
{
  const ing = makeIngest(["inserted", "inserted"]);
  const items: ImportItem[] = [
    { png: Buffer.from("a"), license: "MIT", attribution: "TailAdmin", sourceUrl: "https://x/a", domainHint: "sales", code: grid },
    { png: Buffer.from("b"), license: "Apache-2.0", domainHint: "finance" },
  ];
  const s = await runImport(adapterOf(items), baseDeps({ ingest: ing.fn }));
  assert.equal(s.imported, 2);
  assert.equal(ing.calls[0].source, "import:test", "source tagged with adapter name");
  assert.equal(ing.calls[0].license, "MIT");
  assert.equal(ing.calls[0].attribution, "TailAdmin");
  assert.equal(ing.calls[0].sourceUrl, "https://x/a");
  assert.equal(ing.calls[0].quality, 1, "curated imports are gold-standard by default");
  assert.equal(ing.calls[0].mode, "dashboard");
}

// ---- density gate rejects sprawl when code is present ----------------------
{
  const ing = makeIngest(["inserted"]);
  const s = await runImport(adapterOf([
    { png: Buffer.from("sprawl"), license: "MIT", code: sprawl },
    { png: Buffer.from("ok"), license: "MIT", code: grid },
  ]), baseDeps({ ingest: ing.fn }));
  assert.equal(s.rejected, 1, "sprawling layout rejected");
  assert.equal(s.imported, 1, "compact layout imported");
  assert.equal(ing.calls.length, 1, "rejected item never reaches ingest");
}

// ---- density gate is skipped when no code is provided (e.g. Figma/PNG-only)-
{
  const ing = makeIngest(["inserted"]);
  const s = await runImport(adapterOf([{ png: Buffer.from("x"), license: "MIT" }]), baseDeps({ ingest: ing.fn }));
  assert.equal(s.imported, 1, "PNG-only item imports without code-based gating");
}

// ---- dedup + failure are tallied, batch never aborts -----------------------
{
  const ing = makeIngest(["skipped", "failed", "inserted"]);
  const s = await runImport(adapterOf([
    { png: Buffer.from("dup"), license: "MIT" },
    { png: Buffer.from("boom"), license: "MIT" },
    { png: Buffer.from("good"), license: "MIT" },
  ]), baseDeps({ ingest: ing.fn }));
  assert.deepEqual(s, { imported: 1, skipped: 1, rejected: 0, failed: 1 });
}

// ---- missing license is a hard skip ----------------------------------------
{
  const ing = makeIngest(["inserted"]);
  const s = await runImport(adapterOf([{ png: Buffer.from("x"), license: "" }]), baseDeps({ ingest: ing.fn }));
  assert.equal(s.failed, 1, "no license -> not imported");
  assert.equal(ing.calls.length, 0);
}

// ---- no store -> no-op ------------------------------------------------------
{
  const s = await runImport(adapterOf([{ png: Buffer.from("x"), license: "MIT" }]), { store: null });
  assert.deepEqual(s, { imported: 0, skipped: 0, rejected: 0, failed: 0 });
}

console.log("ok design-rag/import");
