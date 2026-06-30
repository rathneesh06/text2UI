// bff/design-rag/embeddings.test.ts — offline. Injected fetch; no network, no key.
import assert from "node:assert";
import { FakeEmbeddingClient, GoogleEmbeddingClient } from "./embeddings";

// ---- FakeEmbeddingClient: deterministic, right dim, unit-norm --------------
{
  const fake = new FakeEmbeddingClient(768);
  const a1 = await fake.embedText("sales dashboard");
  const a2 = await fake.embedText("sales dashboard");
  const b = await fake.embedText("logistics map");
  assert.equal(a1.length, 768, "dim honored");
  assert.deepEqual(a1, a2, "same input -> identical vector (deterministic)");
  assert.notDeepEqual(a1, b, "different input -> different vector");
  const norm = Math.sqrt(a1.reduce((s, n) => s + n * n, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, "L2-normalized");
  const img = await fake.embedImage(Buffer.from([1, 2, 3, 4]));
  assert.equal(img.length, 768, "image embedding has same dim/space");
}

// ---- GoogleEmbeddingClient: request shaping + response parsing -------------
{
  let seenUrl = "", seenBody: any = null, seenHeaders: any = null;
  const fetchOk: any = (url: string, init: any) => {
    seenUrl = url; seenHeaders = init.headers; seenBody = JSON.parse(init.body);
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({ embedding: { values: new Array(768).fill(0.1) } }),
    });
  };
  const g = new GoogleEmbeddingClient({ apiKey: "k", dim: 768, fetchImpl: fetchOk });
  const v = await g.embedText("hello");
  assert.equal(v.length, 768, "parses embedding.values (REST surface)");
  assert.ok(seenUrl.endsWith("/models/gemini-embedding-2:embedContent"), "embedContent endpoint");
  assert.equal(seenHeaders["x-goog-api-key"], "k", "auth header = the same Gemini key");
  assert.equal(seenBody.outputDimensionality, 768, "Matryoshka dim requested");
  assert.equal(seenBody.content.parts[0].text, "hello", "text part sent");
}

// ---- image part uses inline_data ------------------------------------------
{
  let body: any = null;
  const fetchOk: any = (_u: string, init: any) => {
    body = JSON.parse(init.body);
    return Promise.resolve({
      ok: true, status: 200, text: () => Promise.resolve(""),
      json: () => Promise.resolve({ embeddings: [{ values: new Array(768).fill(0.2) }] }),
    });
  };
  const g = new GoogleEmbeddingClient({ apiKey: "k", dim: 768, fetchImpl: fetchOk });
  const v = await g.embedImage(Buffer.from("PNGDATA"));
  assert.equal(v.length, 768, "parses embeddings[0].values (SDK surface)");
  assert.equal(body.content.parts[0].inline_data.mime_type, "image/png", "inline_data PNG part");
  assert.ok(typeof body.content.parts[0].inline_data.data === "string", "base64 payload");
}

// ---- transient 503 retried, then succeeds ---------------------------------
{
  let calls = 0;
  const flaky: any = () => {
    calls++;
    if (calls === 1) {
      return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("upstream"), json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve({ embedding: { values: new Array(4).fill(1) } }) });
  };
  const g = new GoogleEmbeddingClient({ apiKey: "k", dim: 4, fetchImpl: flaky, maxRetries: 2 });
  const v = await g.embedText("retry me");
  assert.equal(v.length, 4, "recovered after one transient failure");
  assert.equal(calls, 2, "retried exactly once");
}

// ---- missing key fails closed ---------------------------------------------
{
  const g = new GoogleEmbeddingClient({ apiKey: "", fetchImpl: (() => { throw new Error("should not be called"); }) as any });
  await assert.rejects(() => g.embedText("x"), /GEMINI_API_KEY is not set/, "no key -> clear error, no call");
}

console.log("ok design-rag/embeddings");
