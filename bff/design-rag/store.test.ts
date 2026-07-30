// bff/design-rag/store.test.ts — offline. Mock Queryable; no database.
import assert from "node:assert";
import { PgVectorStore, toVectorLiteral, type Queryable } from "./store";

class MockDb implements Queryable {
  calls: { text: string; params: any[] }[] = [];
  constructor(private responder: (text: string, params: any[]) => any[] = () => []) {}
  query(text: string, params: any[] = []) {
    this.calls.push({ text, params });
    return Promise.resolve({ rows: this.responder(text, params) });
  }
  last() { return this.calls[this.calls.length - 1]; }
}

const vec = (n: number, fill = 0.5) => new Array(n).fill(fill);

// ---- toVectorLiteral -------------------------------------------------------
{
  assert.equal(toVectorLiteral([0.1, 0.2, 0.3]), "[0.1,0.2,0.3]");
  assert.equal(toVectorLiteral([]), "[]");
}

// ---- insert: params, vector literals, dedup return -------------------------
{
  const db = new MockDb((sql) => (sql.includes("RETURNING") ? [{ id: "ref_1" }] : []));
  const store = new PgVectorStore(db, 4);
  const ok = await store.insert({
    id: "ref_1", domain: "sales", mode: "dashboard", imagePath: "/p/1.png",
    phash: "abcd", caption: "kpi row", tags: { layout: "grid" }, source: "exemplar-seed",
    quality: 0.9, imgEmbed: vec(4), capEmbed: vec(4, 0.25),
  });
  assert.equal(ok, true, "RETURNING a row -> inserted");
  const c = db.last();
  assert.ok(c.text.includes("INSERT INTO public.text2ui_design_refs"), "insert SQL");
  assert.ok(c.text.includes("ON CONFLICT (phash) DO NOTHING"), "dedup on phash");
  assert.equal(c.params[0], "ref_1");
  assert.equal(c.params[6], JSON.stringify({ layout: "grid" }), "tags serialized to jsonb");
  assert.equal(c.params[12], "[0.5,0.5,0.5,0.5]", "img_embed as vector literal");
  assert.equal(c.params[13], "[0.25,0.25,0.25,0.25]", "cap_embed as vector literal");
}

// ---- insert: conflict -> false; null cap_embed; dim guard ------------------
{
  const db = new MockDb(() => []); // no RETURNING row => conflict
  const store = new PgVectorStore(db, 4);
  const ok = await store.insert({
    id: "ref_2", domain: "finance", mode: "dashboard", imagePath: "/p/2.png",
    phash: "dup", source: "generation", imgEmbed: vec(4),
  });
  assert.equal(ok, false, "conflict (no row) -> deduped/false");
  assert.equal(db.last().params[13], null, "missing cap_embed -> null");

  await assert.rejects(
    () => store.insert({ id: "x", domain: "d", mode: "dashboard", imagePath: "p", phash: "h", source: "s", imgEmbed: vec(3) }),
    /imgEmbed dim 3 != store dim 4/, "dim mismatch rejected",
  );
}

// ---- annSearch: minimal filter (mode only) ---------------------------------
{
  const rows = [{ id: "a", domain: "sales", mode: "dashboard", image_path: "/a.png", phash: "h", caption: "c", tags: {}, source: "s", license: null, quality: 0.8, retrievals: 2, distance: 0.12 }];
  const db = new MockDb(() => rows);
  const store = new PgVectorStore(db, 4);
  const out = await store.annSearch({ queryVec: vec(4), mode: "dashboard", k: 3 });
  const c = db.last();
  assert.ok(c.text.includes("WHERE mode = $2"), "mode filter present");
  assert.ok(!c.text.includes("domain = ANY"), "no domain filter when omitted");
  assert.ok(!c.text.includes("quality >="), "no quality filter when omitted");
  assert.ok(c.text.includes("img_embed <=> $1::vector"), "cosine ANN ordering");
  assert.equal(c.params[0], "[0.5,0.5,0.5,0.5]", "query vector literal = $1");
  assert.equal(c.params[1], "dashboard");
  assert.equal(c.params[2], 3, "k bound as the limit param");
  assert.equal(out[0].imagePath, "/a.png", "row mapped image_path -> imagePath");
  assert.equal(out[0].distance, 0.12, "distance surfaced");
}

// ---- annSearch: full filter, correct param indices -------------------------
{
  const db = new MockDb(() => []);
  const store = new PgVectorStore(db, 4);
  await store.annSearch({ queryVec: vec(4), mode: "dashboard", domains: ["sales", "generic"], minQuality: 0.6, k: 2 });
  const c = db.last();
  assert.ok(c.text.includes("domain = ANY($3)"), "domains -> $3");
  assert.ok(c.text.includes("quality >= $4"), "minQuality -> $4");
  assert.ok(c.text.includes("LIMIT $5"), "limit -> $5 (indices shift correctly)");
  assert.deepEqual(c.params, ["[0.5,0.5,0.5,0.5]", "dashboard", ["sales", "generic"], 0.6, 2]);

  await assert.rejects(
    () => store.annSearch({ queryVec: vec(2), mode: "dashboard", k: 1 }),
    /queryVec dim 2 != store dim 4/, "query dim guard",
  );
}

// ---- incRetrievals: empty no-op; non-empty SQL -----------------------------
{
  const db = new MockDb(() => []);
  const store = new PgVectorStore(db, 4);
  await store.incRetrievals([]);
  assert.equal(db.calls.length, 0, "empty ids -> no query issued");
  await store.incRetrievals(["a", "b"]);
  const c = db.last();
  assert.ok(c.text.includes("retrievals = retrievals + 1"), "increment SQL");
  assert.deepEqual(c.params[0], ["a", "b"], "ids bound as array for ANY()");
}

// ---- findSimilarPhash: exact + perceptual, mode filter ---------------------
{
  const rows = [{ id: "r1", phash: "0000000000000000" }, { id: "r2", phash: "ffffffffffffffff" }];
  const db = new MockDb(() => rows);
  const store = new PgVectorStore(db, 4);
  assert.equal(await store.findSimilarPhash("0000000000000000", 5), "r1", "exact match");
  assert.equal(await store.findSimilarPhash("0000000000000003", 5, "dashboard"), "r1", "2-bit near-dup matches within 5");
  assert.ok(db.calls[1].text.includes("WHERE mode = $1") && db.calls[1].params[0] === "dashboard", "mode filter applied when provided");
  assert.equal(await store.findSimilarPhash("00000000000000ff", 5), null, "8 bits away -> no match");
}

// ---- existsByPhash + count -------------------------------------------------
{
  const present = new PgVectorStore(new MockDb(() => [{ "?column?": 1 }]), 4);
  assert.equal(await present.existsByPhash("h"), true);
  const absent = new PgVectorStore(new MockDb(() => []), 4);
  assert.equal(await absent.existsByPhash("h"), false);

  const counter = new PgVectorStore(new MockDb(() => [{ n: 7 }]), 4);
  assert.equal(await counter.count("dashboard"), 7, "count maps n");
}

console.log("ok design-rag/store");
