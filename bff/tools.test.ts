// bff/tools.test.ts — run with: npm run test:tools
// The migration façade, fully offline: auth gate, OpenAPI shape, contract
// mapping onto the real handlers (injected runners), validation, and the
// spec-in/spec-out statelessness law (an edit works with NOTHING but the
// previous response's spec — no server session required).
import assert from "node:assert/strict";
delete process.env.T2UI_TOOLS_API_KEY;
process.env.T2UI_AUDIT = "0";

import type { Dataset } from "../shared/types";
import { toolText2ui, toolText2sql, toolDatasource, toolsAuthOk, TOOLS_OPENAPI, TOOLS_VERSION } from "./tools";

const col = (name: string, type: string, uniqueCount = 5): any =>
  ({ name, type, uniqueCount, nullCount: 0, sampleValues: [] });
const orders: Dataset[] = [{ tableName: "orders", profile: {
  source: { filename: "orders.csv", format: "csv" }, rowCount: 80,
  columns: [col("region", "string", 4), col("amount", "number", 60), col("created_at", "date", 50)],
  sampleRows: [],
} } as any];

const run = async (system: string) => {
  if (system.includes("task-decomposition")) return { text: JSON.stringify({
    reasoning: "r", tasks: [{ question: "Total?", kind: "kpi", columns: ["amount"], table: "orders" }],
    design: { accent: "#0EA5E9", palette: ["#0EA5E9", "#F97316", "#22C55E", "#A855F7", "#EF4444", "#14B8A6"], vibe: "v" },
  }), finishReason: "STOP" } as any;
  return { text: JSON.stringify({ widgets: [] }), finishReason: "STOP" } as any;
};
const deps = { listUploadDatasets: async () => [], buildDeps: { agentRun: run as any } };

// ---- 1. auth gate -------------------------------------------------------------------
{
  const req = (key?: string) => ({ header: (n: string) => (n === "x-api-key" ? key : undefined) });
  assert.equal(toolsAuthOk(req()), true, "unset key = open dev mode");
  process.env.T2UI_TOOLS_API_KEY = "sekret";
  assert.equal(toolsAuthOk(req()), false, "set key: missing header rejected");
  assert.equal(toolsAuthOk(req("wrong")), false, "set key: wrong header rejected");
  assert.equal(toolsAuthOk(req("sekret")), true, "set key: right header passes");
  delete process.env.T2UI_TOOLS_API_KEY;
}
console.log("tools: auth gate ✅");

// ---- 2. OpenAPI: the importable contract --------------------------------------------
{
  assert.equal(TOOLS_OPENAPI.openapi, "3.0.3");
  assert.equal(TOOLS_OPENAPI.info.version, TOOLS_VERSION);
  const paths = Object.keys(TOOLS_OPENAPI.paths);
  assert.deepEqual(paths.sort(), ["/tools/datasource", "/tools/text2sql", "/tools/text2ui"], "all three tools documented");
  for (const p of paths) {
    const post: any = (TOOLS_OPENAPI.paths as any)[p].post;
    assert.ok(post.operationId && post.summary && post.requestBody, `${p} fully specified`);
  }
  assert.ok((TOOLS_OPENAPI.components.securitySchemes as any).ApiKey, "api-key security scheme declared");
  JSON.parse(JSON.stringify(TOOLS_OPENAPI)); // serializable
}
console.log("tools: OpenAPI document ✅");

// ---- 3. text2ui: build with inline profiles, edit with ONLY the returned spec -------
{
  let r = await toolText2ui({}, "public", deps);
  assert.equal(r.status, 400, "missing prompt → 400");
  r = await toolText2ui({ prompt: "hi" }, "public", deps);
  assert.equal(r.status, 400, "no datasets and no projectId → 400");

  const build = await toolText2ui({ prompt: "revenue overview", datasets: orders }, "public", deps);
  assert.equal(build.status, 200, JSON.stringify(build.body).slice(0, 200));
  assert.ok(build.body.spec?.sections?.length, "spec returned");
  assert.ok(build.body.app && JSON.stringify(build.body.app).length > 500, "generated app returned");
  assert.ok(Array.isArray(build.body.warnings), "warnings channel present");
  assert.equal(build.body.toolVersion, TOOLS_VERSION);

  // THE STATELESSNESS LAW: the edit call carries only what the previous
  // response returned. No conversationId, no server session, nothing else.
  const kpiId = build.body.spec.sections[0].widgets[0].id;
  const editRun = async (system: string) =>
    system.includes("EDIT engine")
      ? { text: JSON.stringify({ ops: [{ op: "update_widget", id: kpiId, set: { title: "Renamed" } }] }), finishReason: "STOP" } as any
      : run(system);
  const edit = await toolText2ui(
    { prompt: "rename the first widget to Renamed", datasets: orders, currentSpec: build.body.spec },
    "public", { ...deps, buildDeps: { agentRun: editRun as any } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body).slice(0, 200));
  assert.equal(edit.body.pipeline, "patch", "edit took the ops path statelessly");
  const w = edit.body.spec.sections[0].widgets.find((x: any) => x.id === kpiId);
  assert.equal(w?.title, "Renamed", "edit landed with only spec-in/spec-out");

  // …and "undo" in the flow world is literally resending the older spec.
  const undo = await toolText2ui(
    { prompt: "put it back exactly as before", datasets: orders, currentSpec: build.body.spec },
    "public", { ...deps, buildDeps: { agentRun: (async () => ({ text: JSON.stringify({ ops: [] }), finishReason: "STOP" })) as any } });
  assert.equal(undo.status, 200);
}
console.log("tools: text2ui build + stateless edit (spec-in/spec-out) ✅");

// ---- 4. text2sql + datasource: validation and mapping -------------------------------
{
  let r = await toolText2sql({ projectId: "x" }, "public", deps);
  assert.equal(r.status, 400, "missing question → 400");
  r = await toolText2sql({ question: "how many?" }, "public", deps);
  assert.equal(r.status, 400, "missing projectId → 400");
  r = await toolText2sql({ question: "how many?", projectId: "nope_unknown" }, "public", deps);
  assert.equal(r.status, 400, "unknown project surfaces the handler's own validation");

  r = await toolDatasource({}, "public");
  assert.equal(r.status, 400, "empty connection body → 400");
  r = await toolDatasource(null, "public");
  assert.equal(r.status, 400, "non-object body → 400");
}
console.log("tools: text2sql + datasource validation ✅");

console.log("tools.test.ts: all assertions passed ✅");
