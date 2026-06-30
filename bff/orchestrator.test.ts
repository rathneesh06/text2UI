// bff/orchestrator.test.ts — offline. Fake model + fake pipeline handlers.
import assert from "node:assert";
import { orchestrate, composePrompt, BRIEF_SCHEMA } from "./orchestrator";
import { handleChat } from "./server";
import type { OrchestratorBrief } from "../shared/types";
import { InMemoryChatStore } from "./chat-store";

const brief: OrchestratorBrief = {
  outputMode: "dashboard", title: "Sales", narrative: "Revenue grew.",
  kpis: ["Revenue", "Orders"], charts: [{ type: "bar", x: "month", y: "revenue", why: "trend" }],
  palette: { primary: "#4f46e5", accent: "#06b6d4", neutrals: ["#f8fafc"], vibe: "vibrant" },
  designDirection: "Dense, energetic.", enhancedPrompt: "Build a vibrant sales dashboard.",
};
const fakeRun = (text: string) => () => Promise.resolve({ text, finishReason: "STOP" } as any);
const datasets = [{ tableName: "t", profile: { columns: [{ name: "month", type: "string" }], rowCount: 3, sampleRows: [{ month: "Jan" }] } }];
const input = { datasets: datasets as any, userPrompt: "show my sales" };

// ---- orchestrate parses a structured brief ---------------------------------
{
  const r = await orchestrate(input, fakeRun(JSON.stringify(brief)));
  assert.ok(r && !("needsClarification" in r), "returns a brief");
  assert.equal((r as OrchestratorBrief).outputMode, "dashboard");
  // tolerates ```json fences
  const r2 = await orchestrate(input, fakeRun("```json\n" + JSON.stringify(brief) + "\n```"));
  assert.ok(r2 && (r2 as OrchestratorBrief).title === "Sales", "strips code fences");
}

// ---- clarification path -----------------------------------------------------
{
  const r = await orchestrate(input, fakeRun(JSON.stringify({ needsClarification: true, question: "Dashboard or report?" })));
  assert.ok(r && "needsClarification" in r, "returns clarification");
  assert.equal((r as any).question, "Dashboard or report?");

  // a usable brief wins even if the model also flags clarification (no more stalls)
  const both = await orchestrate(input, fakeRun(JSON.stringify({ ...brief, needsClarification: true, question: "which?" })));
  assert.ok(both && !("needsClarification" in both), "valid brief beats clarification flag");
  assert.equal((both as OrchestratorBrief).outputMode, "dashboard");
}

// ---- graceful fallback: bad json / invalid brief / thrown call -> null ------
{
  assert.equal(await orchestrate(input, fakeRun("not json at all")), null, "bad json -> null");
  assert.equal(await orchestrate(input, fakeRun(JSON.stringify({ outputMode: "dashboard" }))), null, "incomplete brief -> null");
  assert.equal(await orchestrate(input, () => Promise.reject(new Error("boom"))), null, "thrown -> null");
}

// ---- composePrompt folds the design spec into the builder prompt -----------
{
  const p = composePrompt(brief);
  assert.ok(p.includes("Build a vibrant sales dashboard."), "keeps enhanced prompt");
  assert.ok(p.includes("#4f46e5") && p.includes("vibrant"), "includes palette");
  assert.ok(p.includes("bar of revenue by month"), "includes charts");
  assert.ok(p.includes("Revenue, Orders"), "includes kpis");
}

// ---- schema is well-formed for Gemini --------------------------------------
{
  assert.equal((BRIEF_SCHEMA as any).type, "object");
  assert.deepEqual((BRIEF_SCHEMA as any).properties.outputMode.enum, ["dashboard", "pdf", "ppt"]);
  assert.ok((BRIEF_SCHEMA as any).required.includes("enhancedPrompt"));
}

// ---- handleChat: validation -------------------------------------------------
{
  assert.equal((await handleChat({})).status, 400, "missing datasets -> 400");
  assert.equal((await handleChat({ datasets, userPrompt: "" })).status, 400, "empty prompt -> 400");
}

// ---- handleChat: flag off behaves like /api/generate (raw prompt) ----------
{
  let seen: any = null;
  const generate = (b: any) => { seen = b; return Promise.resolve({ status: 200, body: { ok: true } }); };
  await handleChat({ datasets, userPrompt: "raw" }, { enabled: false, generate });
  assert.equal(seen.userPrompt, "raw", "flag off -> raw prompt, no orchestration");
}

// ---- handleChat: dispatches by outputMode with the rewritten prompt + brief -
{
  const calls: Record<string, any> = {};
  const mk = (name: string) => (b: any) => { calls[name] = b; return Promise.resolve({ status: 200, body: { ok: true } }); };
  const deps = { enabled: true, generate: mk("gen"), report: mk("report"), ppt: mk("ppt"), chatStore: new InMemoryChatStore() };

  const dash = await handleChat({ datasets, userPrompt: "x" }, { ...deps, orchestrateFn: () => Promise.resolve(brief) });
  assert.ok(calls.gen && !calls.report && !calls.ppt, "dashboard -> generate");
  assert.ok(calls.gen.userPrompt.includes("vibrant sales dashboard"), "dispatches enhanced prompt");
  assert.equal(dash.body.brief.outputMode, "dashboard", "brief attached to response");

  calls.gen = undefined;
  await handleChat({ datasets, userPrompt: "x" }, { ...deps, orchestrateFn: () => Promise.resolve({ ...brief, outputMode: "pdf" }) });
  assert.ok(calls.report && !calls.gen, "pdf -> report");

  await handleChat({ datasets, userPrompt: "x" }, { ...deps, orchestrateFn: () => Promise.resolve({ ...brief, outputMode: "ppt" }) });
  assert.ok(calls.ppt, "ppt -> ppt");
}

// ---- handleChat: null orchestration -> graceful raw fallback ----------------
{
  let seen: any = null;
  const generate = (b: any) => { seen = b; return Promise.resolve({ status: 200, body: { ok: true } }); };
  await handleChat({ datasets, userPrompt: "raw2" }, { enabled: true, generate, orchestrateFn: () => Promise.resolve(null) });
  assert.equal(seen.userPrompt, "raw2", "null brief -> raw dashboard build");
}

// ---- handleChat: clarification returns the question, no build --------------
{
  let built = false;
  const generate = () => { built = true; return Promise.resolve({ status: 200, body: { ok: true } }); };
  const res = await handleChat({ datasets, userPrompt: "vague" }, { enabled: true, generate, orchestrateFn: () => Promise.resolve({ needsClarification: true, question: "Which output?" }) });
  assert.equal(res.body.needsClarification, true, "returns clarification");
  assert.equal(res.body.question, "Which output?");
  assert.equal(built, false, "no build on clarification");
}

console.log("ok bff/orchestrator");
