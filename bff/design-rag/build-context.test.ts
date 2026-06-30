// bff/design-rag/build-context.test.ts — offline. Injected retrieve + readImage.
import assert from "node:assert";
import { retrieveForBuild, type BuildRefDeps } from "./build-context";
import { FakeEmbeddingClient } from "./embeddings";
import type { RetrievalStore, DesignRef } from "./retrieve";
import type { AssembleInput, Dataset } from "../../shared/types";

const dref = (id: string, caption = `note ${id}`, imagePath = `/img/${id}.png`): DesignRef =>
  ({ id, imagePath, caption, domain: "sales", quality: 0.9, distance: 0.1, tags: {} });

const buildInput = (over: Partial<AssembleInput> = {}): AssembleInput =>
  ({ datasets: [] as Dataset[], userPrompt: "show revenue", ...over });

const readOk = (path: string) => Promise.resolve(Buffer.from("PNG:" + path));

const baseDeps: BuildRefDeps = {
  enabled: true,
  store: {} as RetrievalStore,           // non-null sentinel; faked retrieve ignores it
  embed: new FakeEmbeddingClient(8),
  domainOf: () => "sales",
  schemaOf: () => "orders(amount:number)",
  readImage: readOk,
};
const withRefs = (refs: DesignRef[]): BuildRefDeps["retrieve"] => (async () => refs) as any;

// ---- flag OFF -> EMPTY, nothing touched ------------------------------------
{
  const r = await retrieveForBuild(buildInput(), { ...baseDeps, enabled: false, retrieve: withRefs([dref("a")]) });
  assert.deepEqual(r, { referenceBlock: "", images: [], refs: [] });
}

// ---- edit/heal turns -> EMPTY (build-turns only) ---------------------------
{
  const edit = await retrieveForBuild(buildInput({ currentCode: "x" }), { ...baseDeps, retrieve: withRefs([dref("a")]) });
  assert.equal(edit.images.length, 0, "edit turn -> no references");
  const heal = await retrieveForBuild(buildInput({ lastError: "boom" }), { ...baseDeps, retrieve: withRefs([dref("a")]) });
  assert.equal(heal.images.length, 0, "heal turn -> no references");
}

// ---- store null -> EMPTY ---------------------------------------------------
{
  const r = await retrieveForBuild(buildInput(), { ...baseDeps, store: null, retrieve: withRefs([dref("a")]) });
  assert.equal(r.referenceBlock, "", "no store -> degrade");
}

// ---- happy path: query opts, images, formatted block -----------------------
{
  let captured: any = null;
  const retrieve = (async (o: any) => { captured = o; return [dref("a", "KPI row"), dref("b", "sidebar table")]; }) as any;
  const r = await retrieveForBuild(buildInput(), { ...baseDeps, retrieve });
  assert.equal(captured.mode, "dashboard", "dashboard mode (Phase A)");
  assert.equal(captured.domain, "sales");
  assert.equal(captured.schemaSummary, "orders(amount:number)");
  assert.equal(captured.userPrompt, "show revenue");
  assert.equal(r.images.length, 2);
  assert.equal(r.images[0].mimeType, "image/png");
  assert.equal(r.images[0].dataB64, Buffer.from("PNG:/img/a.png").toString("base64"), "base64 of loaded png");
  assert.ok(r.referenceBlock.includes("DO NOT copy"), "anti-leakage framing present");
  assert.ok(r.referenceBlock.includes("KPI row") && r.referenceBlock.includes("sidebar table"), "captions injected");
  assert.equal(r.refs.length, 2);
}

// ---- partial image failure: unreadable refs dropped, notes stay aligned ----
{
  const readSome = (path: string) =>
    path.includes("/b.") ? Promise.reject(new Error("missing")) : Promise.resolve(Buffer.from("PNG:" + path));
  const r = await retrieveForBuild(buildInput(), { ...baseDeps, retrieve: withRefs([dref("a"), dref("b")]), readImage: readSome });
  assert.equal(r.images.length, 1, "unreadable image dropped");
  assert.equal(r.refs.length, 1);
  assert.ok(r.referenceBlock.includes("reference 1") && !r.referenceBlock.includes("reference 2"), "block renumbered to kept refs");
}

// ---- all images fail / empty corpus / retrieve throws -> EMPTY -------------
{
  const allFail = await retrieveForBuild(buildInput(), { ...baseDeps, retrieve: withRefs([dref("a")]), readImage: () => Promise.reject(new Error("x")) });
  assert.deepEqual(allFail, { referenceBlock: "", images: [], refs: [] }, "no readable images -> EMPTY");

  const none = await retrieveForBuild(buildInput(), { ...baseDeps, retrieve: withRefs([]) });
  assert.equal(none.referenceBlock, "", "empty corpus -> EMPTY");

  const threw = await retrieveForBuild(buildInput(), { ...baseDeps, retrieve: (async () => { throw new Error("boom"); }) as any });
  assert.deepEqual(threw, { referenceBlock: "", images: [], refs: [] }, "retrieve throw -> caught -> EMPTY");
}

console.log("ok design-rag/build-context");
