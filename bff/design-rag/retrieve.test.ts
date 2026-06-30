// bff/design-rag/retrieve.test.ts — offline. Fake store + FakeEmbeddingClient.
import assert from "node:assert";
import { retrieveReferences, buildQueryText, type RetrievalStore } from "./retrieve";
import { FakeEmbeddingClient, type EmbeddingClient } from "./embeddings";
import type { AnnSearchOpts, DesignRefRow } from "./store";

const row = (id: string, over: Partial<DesignRefRow> = {}): DesignRefRow => ({
  id, domain: "sales", mode: "dashboard", imagePath: `/p/${id}.png`, phash: id,
  caption: `cap ${id}`, tags: {}, source: "exemplar-seed", license: null, attribution: null, sourceUrl: null,
  quality: 0.9, retrievals: 0, distance: 0.1, ...over,
});

class FakeStore implements RetrievalStore {
  annCalls: AnnSearchOpts[] = [];
  incCalls: string[][] = [];
  constructor(private responder: (opts: AnnSearchOpts) => DesignRefRow[]) {}
  annSearch(opts: AnnSearchOpts) { this.annCalls.push(opts); return Promise.resolve(this.responder(opts)); }
  incRetrievals(ids: string[]) { this.incCalls.push(ids); return Promise.resolve(); }
}

const embed = () => new FakeEmbeddingClient(8);
const base = { mode: "dashboard" as const, userPrompt: "show revenue", schemaSummary: "orders(amount:number)" };

// ---- buildQueryText --------------------------------------------------------
{
  const q = buildQueryText({ userPrompt: "  show revenue ", domain: "sales", schemaSummary: " orders(x) " });
  assert.ok(q.includes("show revenue") && q.includes("domain:sales") && q.includes("schema:orders(x)"));
}

// ---- happy path: filter, k limit, incRetrievals ----------------------------
{
  const store = new FakeStore(() => [row("a"), row("b"), row("c")]);
  const refs = await retrieveReferences({ ...base, domain: "sales", store, embed: embed(), k: 2 });
  assert.equal(refs.length, 2, "capped at k");
  assert.equal(store.annCalls[0].domains?.[0], "sales", "filtered by detected domain");
  assert.equal(store.annCalls[0].mode, "dashboard");
  assert.equal(store.annCalls[0].k, 6, "overfetch k*3 for diversity");
  assert.deepEqual(store.incCalls[0], refs.map((r) => r.id), "usage counters bumped for chosen refs");
  assert.equal(refs[0].imagePath, "/p/a.png");
  assert.equal(refs[0].caption, "cap a");
}

// ---- diversify by layout bucket --------------------------------------------
{
  const store = new FakeStore(() => [
    row("a", { tags: { layout: "grid" } }),
    row("b", { tags: { layout: "grid" } }),     // same bucket as a -> skipped first
    row("c", { tags: { layout: "sidebar" } }),
  ]);
  const refs = await retrieveReferences({ ...base, domain: "sales", store, embed: embed(), k: 2 });
  assert.deepEqual(refs.map((r) => r.id), ["a", "c"], "prefers distinct layouts");
}

// ---- diversify pass 2 fills when not enough variety ------------------------
{
  const store = new FakeStore(() => [
    row("a", { tags: { layout: "grid" } }),
    row("b", { tags: { layout: "grid" } }),
  ]);
  const refs = await retrieveReferences({ ...base, domain: "sales", store, embed: embed(), k: 2 });
  assert.deepEqual(refs.map((r) => r.id), ["a", "b"], "fills the second slot despite same bucket");
}

// ---- generic top-up when domain corpus is thin -----------------------------
{
  const store = new FakeStore((opts) =>
    opts.domains?.[0] === "sales"
      ? [row("a")]                                   // only 1 (< k)
      : [row("g1", { domain: "generic" }), row("g2", { domain: "generic" })]);
  const refs = await retrieveReferences({ ...base, domain: "sales", store, embed: embed(), k: 2 });
  assert.equal(store.annCalls.length, 2, "primary + generic top-up");
  assert.equal(store.annCalls[1].domains?.[0], "generic");
  assert.deepEqual(refs.map((r) => r.id), ["a", "g1"], "domain ref first, then generic");
}

// ---- no top-up when primary already satisfies k, or domain is generic ------
{
  const full = new FakeStore(() => [row("a"), row("b"), row("c")]);
  await retrieveReferences({ ...base, domain: "sales", store: full, embed: embed(), k: 2 });
  assert.equal(full.annCalls.length, 1, "enough primary -> no generic call");

  const gen = new FakeStore(() => [row("a", { domain: "generic" })]);
  await retrieveReferences({ ...base, domain: "generic", store: gen, embed: embed(), k: 3 });
  assert.equal(gen.annCalls.length, 1, "already generic -> no redundant top-up");
}

// ---- graceful degradation: every failure path returns [] -------------------
{
  // no store configured
  const a = await retrieveReferences({ ...base, domain: "sales", store: null, embed: embed() });
  assert.deepEqual(a, [], "null store -> []");

  // embedding throws (before any search)
  const throwing: EmbeddingClient = {
    dim: 8,
    embedText: () => Promise.reject(new Error("embed boom")),
    embedImage: () => Promise.reject(new Error("embed boom")),
  };
  const s1 = new FakeStore(() => [row("a")]);
  const b = await retrieveReferences({ ...base, domain: "sales", store: s1, embed: throwing });
  assert.deepEqual(b, [], "embed failure -> []");
  assert.equal(s1.annCalls.length, 0, "no search attempted after embed failure");

  // ANN search throws
  const dbDown: RetrievalStore = {
    annSearch: () => Promise.reject(new Error("db down")),
    incRetrievals: () => Promise.resolve(),
  };
  const c = await retrieveReferences({ ...base, domain: "sales", store: dbDown, embed: embed() });
  assert.deepEqual(c, [], "ANN failure -> []");

  // empty corpus -> [] and no counter bump
  const empty = new FakeStore(() => []);
  const d = await retrieveReferences({ ...base, domain: "sales", store: empty, embed: embed() });
  assert.deepEqual(d, [], "empty corpus -> []");
  assert.equal(empty.incCalls.length, 0, "nothing retrieved -> no incRetrievals");
}

console.log("ok design-rag/retrieve");
