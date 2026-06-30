// aiflow.test.ts — streaming pipeline tests with an injected runner (no network).
// Run: npm run test:aiflow
import assert from "node:assert/strict";
import { generateAppStream, extractStreamPiece, planApp, type GenEvent, type StreamRunner, type GenResult } from "./aiflow";

// ---- extractStreamPiece ----
assert.deepEqual(
  extractStreamPiece({ candidates: [{ content: { parts: [{ text: "abc" }] } }] }),
  { delta: "abc", finishReason: "" },
);
assert.deepEqual(
  extractStreamPiece({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }),
  { delta: "", finishReason: "STOP" },
);
assert.throws(() => extractStreamPiece({ promptFeedback: { blockReason: "SAFETY" } }), /blocked/);

// ---- single-pass stream: events arrive in order, app parses ----
{
  const events: GenEvent[] = [];
  const code = `//__SUMMARY__ A tiny app.\nexport default function App(){return null}\n//__END__`;
  const runner: StreamRunner = async (_s, _u, onText) => {
    // simulate Gemini chunking the output in three pieces
    for (const piece of [code.slice(0, 20), code.slice(20, 50), code.slice(50)]) onText(piece);
    return { text: code, finishReason: "STOP" };
  };
  const app = await generateAppStream("sys", "user", (e) => events.push(e), runner);

  assert.equal(app.summary, "A tiny app.");
  assert.ok(app.files[0].content.includes("export default"));
  assert.equal(events[0].type, "stage");
  assert.equal((events[0] as any).stage, "model_call");
  const chunks = events.filter((e) => e.type === "chunk").map((e: any) => e.text).join("");
  assert.equal(chunks, code, "chunks reassemble the full output");
  const progresses = events.filter((e) => e.type === "progress").map((e: any) => e.chars);
  assert.deepEqual(progresses, [20, 50, code.length], "progress is cumulative");
  assert.equal((events[events.length-1] as any).stage, "validating", "ends with validating");
}

// ---- truncation: continuation stage emitted, stitched result parses ----
{
  const events: GenEvent[] = [];
  const part1 = `export default function App(){\n  const x = 1;`;
  const part2 = `\n  return null;\n}\n//__END__`;
  let call = 0;
  const runner: StreamRunner = async (_s, u, onText) => {
    call++;
    if (call === 1) { onText(part1); return { text: part1, finishReason: "MAX_TOKENS" }; }
    assert.ok(u.includes("cut off"), "second call is a continuation prompt");
    onText(part2); return { text: part2, finishReason: "STOP" };
  };
  const app = await generateAppStream("sys", "user", (e) => events.push(e), runner);
  assert.ok(app.files[0].content.includes("return null"), "stitched code complete");
  const stages = events.filter((e) => e.type === "stage").map((e: any) => e.stage);
  assert.deepEqual(stages, ["model_call", "continuation", "validating"]);
}

// ---- corrupt stitch still guarded under streaming ----
{
  const bad = `function App(){}\nexport default App\nfunction App(){}\nexport default App\n//__END__`;
  const runner: StreamRunner = async (_s, _u, onText) => { onText(bad); return { text: bad, finishReason: "STOP" }; };
  await assert.rejects(generateAppStream("s", "u", () => {}, runner), /inconsistent/);
}

console.log("aiflow streaming: all assertions passed");

// ---- Phase 3: planApp() is best-effort -------------------------------------
{
  // happy path: returns trimmed plan text, strips markdown fences if present
  const runner = async (): Promise<GenResult> => ({ text: "```\nKPI row → trend chart\n```", finishReason: "STOP" });
  const plan = await planApp("sys", "user", runner);
  assert.equal(plan, "KPI row → trend chart", "plan text returned, fences stripped");
}
{
  // error path: a throwing model call resolves to null (build proceeds planless), never throws
  const runner = async (): Promise<GenResult> => { throw new Error("429 quota"); };
  const plan = await planApp("sys", "user", runner);
  assert.equal(plan, null, "errors resolve to null");
}
{
  // empty path: empty/whitespace plan resolves to null, not ""
  const runner = async (): Promise<GenResult> => ({ text: "   \n  ", finishReason: "STOP" });
  assert.equal(await planApp("sys", "user", runner), null, "empty plan -> null");
}
{
  // timeout path: a slow call resolves to null at the cap, doesn't hang the build
  const runner = (): Promise<GenResult> => new Promise((r) => setTimeout(() => r({ text: "late", finishReason: "STOP" }), 200));
  const start = Date.now();
  const plan = await planApp("sys", "user", runner, 40);
  assert.equal(plan, null, "timed-out plan -> null");
  assert.ok(Date.now() - start < 180, "returns at the timeout, not after the slow call");
}
console.log("aiflow plan pass: all assertions passed");

// ---- Phase 3: assemble() threads the plan into BUILD turns only ------------
{
  const { assemble, assemblePlan } = await import("./assembler");
  const profile = {
    source: { filename: "sales.csv", format: "csv" as const },
    rowCount: 100,
    columns: [
      { name: "order_date", type: "date" as const, nullable: false, uniqueCount: 90, sampleValues: ["2024-01-01"] },
      { name: "amount", type: "number" as const, nullable: false, uniqueCount: 80, sampleValues: [12.5] },
    ],
    sampleRows: [{ order_date: "2024-01-01", amount: 12.5 }],
  };
  const datasets = [{ tableName: "sales", profile }];
  const PLAN = "KPI row: Total amount = SUM(amount) → trend of amount by order_date";

  // build turn WITH a plan: the plan text appears in the user prompt
  const build = assemble({ datasets, userPrompt: "make a sales dashboard", plan: PLAN });
  assert.ok(build.user_prompt.includes("Design plan to implement"), "build injects the plan header");
  assert.ok(build.user_prompt.includes(PLAN), "build injects the plan text");
  assert.ok(/specification, not optional extras/i.test(build.system_prompt), "discipline defers to the plan when present");

  // build turn WITHOUT a plan: no plan header (best-effort skip path) + standard discipline
  const buildNoPlan = assemble({ datasets, userPrompt: "make a sales dashboard" });
  assert.ok(!buildNoPlan.user_prompt.includes("Design plan to implement"), "planless build omits the header");
  assert.ok(/build exactly what the user asks/i.test(buildNoPlan.system_prompt), "planless build keeps standard discipline");

  // edit turn: plan is ignored even if present (edits already have code)
  const edit = assemble({ datasets, userPrompt: "add a filter", currentCode: "export default function App(){return null}", plan: PLAN });
  assert.ok(!edit.user_prompt.includes(PLAN), "edit turns ignore the plan");

  // assemblePlan builds a prompt that references the actual columns
  const planPrompt = assemblePlan(datasets, "make a sales dashboard");
  assert.ok(planPrompt.user_prompt.includes("order_date") && planPrompt.user_prompt.includes("amount"), "plan prompt carries the schema");
  assert.ok(planPrompt.system_prompt.includes("layout plan"), "plan system prompt sets the planning task");
}
console.log("assemble plan threading: all assertions passed");