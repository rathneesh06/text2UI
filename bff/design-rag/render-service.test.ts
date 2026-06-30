// bff/design-rag/render-service.test.ts — offline. Fake renderImpl, no browser.
import assert from "node:assert";
import { RenderQueue } from "./render-service";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- concurrency is capped; all jobs still complete in order ---------------
{
  let current = 0, maxObserved = 0;
  const impl = async (html: string) => {
    current++; maxObserved = Math.max(maxObserved, current);
    await tick(8);
    current--;
    return Buffer.from(html);
  };
  const q = new RenderQueue({ concurrency: 2, renderImpl: impl });
  const inputs = ["a", "b", "c", "d", "e"];
  const out = await Promise.all(inputs.map((h) => q.render(h)));
  assert.equal(maxObserved, 2, `never exceeds the cap (observed ${maxObserved})`);
  assert.deepEqual(out.map((b) => b.toString()), inputs, "every job resolves with its own result");
  assert.equal(q.activeCount, 0, "drains to zero");
  assert.equal(q.pendingCount, 0, "no stragglers queued");
}

// ---- concurrency=1 fully serializes ----------------------------------------
{
  let current = 0, maxObserved = 0;
  const impl = async (html: string) => { current++; maxObserved = Math.max(maxObserved, current); await tick(4); current--; return Buffer.from(html); };
  const q = new RenderQueue({ concurrency: 1, renderImpl: impl });
  await Promise.all(["x", "y", "z"].map((h) => q.render(h)));
  assert.equal(maxObserved, 1, "serial when concurrency is 1");
}

// ---- a failing job releases its slot (doesn't deadlock the queue) ----------
{
  let calls = 0;
  const impl = async (html: string) => { calls++; if (html === "boom") throw new Error("render failed"); await tick(2); return Buffer.from(html); };
  const q = new RenderQueue({ concurrency: 1, renderImpl: impl });
  await assert.rejects(() => q.render("boom"), /render failed/);
  const ok = await q.render("after");   // slot was released despite the failure
  assert.equal(ok.toString(), "after");
  assert.equal(calls, 2);
  assert.equal(q.activeCount, 0, "no leaked slot");
}

// ---- concurrency floor of 1 ------------------------------------------------
{
  const q = new RenderQueue({ concurrency: 0, renderImpl: async (h) => Buffer.from(h) });
  assert.equal((await q.render("ok")).toString(), "ok", "concurrency 0 is coerced to 1, still works");
}

console.log("ok design-rag/render-service");
