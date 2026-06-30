// bff/design-rag/ingest.test.ts — offline. Fake store/caption/writer; no I/O.
import assert from "node:assert";
import { join } from "node:path";
import { ingestOne, seedFromExemplars, type IngestStore } from "./ingest";
import { FakeEmbeddingClient } from "./embeddings";
import { isSimilarHash } from "./hash";
import type { DesignNote } from "./caption";
import type { DesignRefInsert } from "./store";

class FakeStore implements IngestStore {
  inserted: DesignRefInsert[] = [];
  existing = new Set<string>();
  insertReturns = true;
  insert(ref: DesignRefInsert) { this.inserted.push(ref); return Promise.resolve(this.insertReturns); }
  existsByPhash(ph: string) { return Promise.resolve(this.existing.has(ph)); }
  findSimilarPhash(ph: string, maxHamming: number) {
    for (const e of this.existing) if (isSimilarHash(ph, e, maxHamming)) return Promise.resolve("dup");
    return Promise.resolve(null);
  }
}

function makeCaption(note: Partial<DesignNote> = {}) {
  const calls: { png: Buffer; opts: any }[] = [];
  const fn = (png: Buffer, opts?: any) => {
    calls.push({ png, opts });
    return Promise.resolve({ domain: "sales", chartTypes: ["bar"], layout: "grid", density: "dense", whatsGood: "good", ...note } as DesignNote);
  };
  return { fn, calls };
}
function makeWriter() {
  const writes: { path: string; len: number }[] = [];
  const fn = (path: string, data: Buffer) => { writes.push({ path, len: data.length }); return Promise.resolve(); };
  return { fn, writes };
}
const embed = new FakeEmbeddingClient(8);
const H = (p: Buffer) => "H:" + p.toString();

// ---- happy path: every stored field --------------------------------------
{
  const store = new FakeStore();
  const cap = makeCaption({ domain: "finance" });
  const w = makeWriter();
  const r = await ingestOne(
    { png: Buffer.from("PNG-A"), source: "exemplar-seed", domainHint: "sales", quality: 1 },
    { store, embed, caption: cap.fn, hash: H, writeImage: w.fn, idgen: () => "ID1", corpusDir: "corpus" },
  );
  assert.equal(r, "inserted");
  assert.equal(cap.calls[0].opts.domainHint, "sales", "domain hint forwarded to caption");
  assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0].path, join("corpus", "ID1.png"), "png written to corpusDir/id.png");
  const ins = store.inserted[0];
  assert.equal(ins.id, "ID1");
  assert.equal(ins.domain, "finance", "domain taken from the caption note");
  assert.equal(ins.mode, "dashboard");
  assert.equal(ins.imagePath, join("corpus", "ID1.png"));
  assert.equal(ins.phash, "H:PNG-A");
  assert.equal(ins.source, "exemplar-seed");
  assert.equal(ins.quality, 1);
  assert.equal(ins.imgEmbed.length, 8, "image embedded");
  assert.equal(ins.capEmbed?.length, 8, "caption note embedded");
  assert.deepEqual(ins.tags, { chartTypes: ["bar"], layout: "grid", density: "dense" }, "structural tags stored");
}

// ---- pre-dedup: existing phash skips caption/embed/write/insert ------------
{
  const store = new FakeStore();
  store.existing.add("H:DUP");
  const cap = makeCaption();
  const w = makeWriter();
  const r = await ingestOne(
    { png: Buffer.from("DUP"), source: "exemplar-seed", domainHint: "sales" },
    { store, embed, caption: cap.fn, hash: H, writeImage: w.fn, idgen: () => "X" },
  );
  assert.equal(r, "skipped");
  assert.equal(cap.calls.length, 0, "no caption work for a known phash");
  assert.equal(w.writes.length, 0, "no write for a dup");
  assert.equal(store.inserted.length, 0, "no insert for a dup");
}

// ---- perceptual near-duplicate (not byte-identical) is skipped -------------
{
  const store = new FakeStore();
  store.existing.add("0000000000000000");
  const cap = makeCaption();
  const r = await ingestOne(
    { png: Buffer.from("near"), source: "generation", mode: "dashboard" },
    { store, embed, caption: cap.fn, hash: () => "0000000000000001", writeImage: makeWriter().fn, idgen: () => "X", maxHamming: 5 },
  );
  assert.equal(r, "skipped", "phash within Hamming threshold -> deduped");
  assert.equal(cap.calls.length, 0, "near-dup skips caption/embed too");
}

// ---- insert race (ON CONFLICT) -> skipped ---------------------------------
{
  const store = new FakeStore();
  store.insertReturns = false;
  const r = await ingestOne(
    { png: Buffer.from("A"), source: "s" },
    { store, embed, caption: makeCaption().fn, hash: () => "h", writeImage: makeWriter().fn, idgen: () => "X" },
  );
  assert.equal(r, "skipped", "insert conflict -> skipped");
}

// ---- caption failure -> failed, no write/insert ---------------------------
{
  const store = new FakeStore();
  const w = makeWriter();
  const r = await ingestOne(
    { png: Buffer.from("A"), source: "s" },
    { store, embed, caption: () => Promise.reject(new Error("vision down")), hash: () => "h", writeImage: w.fn, idgen: () => "X" },
  );
  assert.equal(r, "failed");
  assert.equal(w.writes.length, 0);
  assert.equal(store.inserted.length, 0);
}

// ---- embed failure -> failed ----------------------------------------------
{
  const store = new FakeStore();
  const throwingEmbed = { dim: 8, embedImage: () => Promise.reject(new Error("e")), embedText: () => Promise.resolve(new Array(8).fill(0)) };
  const r = await ingestOne(
    { png: Buffer.from("A"), source: "s" },
    { store, embed: throwingEmbed as any, caption: makeCaption().fn, hash: () => "h", writeImage: makeWriter().fn, idgen: () => "X" },
  );
  assert.equal(r, "failed");
}

// ---- seedFromExemplars: insert / dedup / render-fail tally -----------------
{
  const store = new FakeStore();
  store.existing.add("H:DUPPNG");          // the finance seed will dedup
  let idc = 0;
  const w = makeWriter();
  const seeds = [
    { domain: "sales", render: () => Promise.resolve(Buffer.from("PNG-sales")) },
    { domain: "finance", render: () => Promise.resolve(Buffer.from("DUPPNG")) },
    { domain: "hr", render: () => Promise.reject(new Error("render fail")) },
  ];
  const summary = await seedFromExemplars(seeds, {
    store, embed, caption: makeCaption().fn, hash: H, writeImage: w.fn, idgen: () => `ID${++idc}`,
  });
  assert.equal(summary.total, 3);
  assert.equal(summary.inserted, 1, "sales inserted");
  assert.equal(summary.skipped, 1, "finance deduped");
  assert.equal(summary.failed, 1, "hr render failed");
  assert.equal(store.inserted[0].source, "exemplar-seed", "exemplars stored as seed source");
  assert.equal(store.inserted[0].quality, 1, "exemplars are gold-standard quality");
}

console.log("ok design-rag/ingest");
