// bff/design-rag/retire.test.ts — offline. Mock store + fake unlink.
import assert from "node:assert";
import { runRetire, type RetireStore } from "./retire";
import { PgVectorStore, type Queryable } from "./store";

// ---- orchestrator: deletes images for removed rows -------------------------
{
  const removed = [{ id: "a", imagePath: "/c/a.png" }, { id: "b", imagePath: "/c/b.png" }];
  const seenOpts: any[] = [];
  const store: RetireStore = { retireRefs: (o) => { seenOpts.push(o); return Promise.resolve(removed); } };
  const unlinked: string[] = [];
  const s = await runRetire({ store, unlinkImage: (p) => { unlinked.push(p); return Promise.resolve(); }, minQuality: 0.7, graceDays: 14 });
  assert.equal(s.retired, 2);
  assert.equal(s.imagesDeleted, 2);
  assert.equal(s.imagesMissing, 0);
  assert.deepEqual(unlinked, ["/c/a.png", "/c/b.png"], "each retired ref's PNG deleted");
  assert.deepEqual(seenOpts[0], { minQuality: 0.7, graceDays: 14 }, "thresholds passed through");
}

// ---- missing image files are tolerated -------------------------------------
{
  const store: RetireStore = { retireRefs: () => Promise.resolve([{ id: "a", imagePath: "/gone.png" }]) };
  const s = await runRetire({ store, unlinkImage: () => Promise.reject(new Error("ENOENT")) });
  assert.equal(s.retired, 1);
  assert.equal(s.imagesDeleted, 0);
  assert.equal(s.imagesMissing, 1, "unlink failure counted, not thrown");
}

// ---- no store configured -> no-op ------------------------------------------
{
  const s = await runRetire({ store: null });
  assert.deepEqual(s, { retired: 0, imagesDeleted: 0, imagesMissing: 0 });
}

// ---- store.retireRefs SQL: protects seeds, two retire conditions -----------
{
  const calls: { text: string; params: any[] }[] = [];
  const db: Queryable = { query: (text, params = []) => { calls.push({ text, params }); return Promise.resolve({ rows: [{ id: "x", image_path: "/x.png" }] }); } };
  const store = new PgVectorStore(db, 4);
  const out = await store.retireRefs({ minQuality: 0.6, graceDays: 30 });
  const sql = calls[0].text;
  assert.ok(sql.includes("DELETE FROM public._design_refs"), "is a delete");
  assert.ok(sql.includes("source <> ALL($1)"), "protects listed sources");
  assert.ok(sql.includes("quality < $2"), "quality floor condition");
  assert.ok(sql.includes("retrievals = 0") && sql.includes("interval"), "stale-and-unretrieved condition");
  assert.ok(sql.includes("RETURNING id, image_path"), "returns rows for image cleanup");
  assert.deepEqual(calls[0].params, [["exemplar-seed"], 0.6, 30], "protected seeds + thresholds bound");
  assert.deepEqual(out, [{ id: "x", imagePath: "/x.png" }], "rows mapped");
}

console.log("ok design-rag/retire");
