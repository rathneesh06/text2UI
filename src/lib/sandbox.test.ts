// sandbox.test.ts — asserts the pure host-side sandbox logic (no network, no DOM).
// Run: npm run test:sandbox
import assert from "node:assert/strict";
import { buildSandpackConfig, extractRuntimeError } from "./sandbox";
import type { TableData } from "./data";

const app = {
  files: [{ path: "App.js", content: "export default function App(){return null}" }],
};

// --- single table (back-compat: one file => table "data") -------------------
{
  const tables: TableData[] = [{ tableName: "data", rows: [{ a: 1 }, { a: 2 }] }];
  const cfg = buildSandpackConfig(app, tables);

  assert.equal(cfg.mainFile, "/App.tsx", "code paths normalize to .tsx");
  assert.ok(cfg.files["/index.tsx"].includes('from "./App"'), "entry imports the main file");
  assert.ok(cfg.files["/data.js"], "engine file emitted");
  const rowsJs = cfg.files["/rows.js"];
  assert.ok(rowsJs.startsWith("export const tables ="), "rows.js exports tables map");
  assert.deepEqual(JSON.parse(rowsJs.replace("export const tables = ", "").replace(/;\s*$/, "")),
    { data: [{ a: 1 }, { a: 2 }] });
  assert.equal(cfg.customSetup.entry, "/index.tsx");
  assert.ok(cfg.customSetup.dependencies["react-is"], "react-is pinned for recharts");
  assert.ok(cfg.customSetup.dependencies["lucide-react"], "lucide-react available for icons");
  assert.ok(cfg.customSetup.dependencies["@duckdb/duckdb-wasm"], "duckdb dep merged");
}

// --- multiple tables ---------------------------------------------------------
{
  const tables: TableData[] = [
    { tableName: "orders", rows: [{ id: 1, customer_id: 7 }] },
    { tableName: "customers", rows: [{ customer_id: 7, segment: "smb" }] },
  ];
  const cfg = buildSandpackConfig(app, tables);
  const parsed = JSON.parse(
    cfg.files["/rows.js"].replace("export const tables = ", "").replace(/;\s*$/, ""),
  );
  assert.deepEqual(Object.keys(parsed), ["orders", "customers"], "every table reaches rows.js");
}

// --- guards ------------------------------------------------------------------
assert.throws(() => buildSandpackConfig({ files: [] }, [{ tableName: "data", rows: [] }]),
  /no files/);
assert.throws(() => buildSandpackConfig(app, []), /no datasets/);

// --- extractRuntimeError -------------------------------------------------------
assert.equal(
  extractRuntimeError({ type: "action", action: "show-error", title: "TypeError", message: "x is undefined", path: "/App.tsx", line: 4 }),
  "TypeError: x is undefined (/App.tsx:4)",
);
assert.equal(extractRuntimeError({ type: "ping" }), null);
assert.equal(extractRuntimeError(null), null);

console.log("sandbox.test.ts: all assertions passed");

// --- remote data mode (M1 backend) -------------------------------------------
{
  const tables = [{ tableName: "data", rows: [{ a: 1 }] }];
  const cfg = buildSandpackConfig(app, tables, { bffUrl: "http://localhost:8787", projectId: "sabc" });
  assert.ok(cfg.files["/data.js"].includes("/api/query"), "remote engine fetches the BFF");
  // Foreign-origin sandboxes ride the postMessage bridge; direct fetch is the fallback.
  assert.ok(cfg.files["/data.js"].includes("t2ui.query"), "remote engine posts queries over the host bridge");
  assert.ok(cfg.files["/data.js"].includes("t2ui.queryResult"), "remote engine listens for bridge replies");
  assert.ok(cfg.files["/data.js"].includes("bridge timeout"), "bridge degrades to direct fetch on timeout");
  assert.ok(!cfg.files["/rows.js"], "no rows inlined in remote mode");
  assert.ok(!cfg.customSetup.dependencies["@duckdb/duckdb-wasm"], "no WASM dep in remote mode");
  // remote mode is valid with zero local tables
  assert.doesNotThrow(() => buildSandpackConfig(app, [], { bffUrl: "x", projectId: "y" }));
}

// the emitted remote module must be valid JS (node --check)
{
  const { remoteDataModuleFiles } = await import("./data");
  const { writeFileSync, rmSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const path = await import("node:path");
  const src = remoteDataModuleFiles({ bffUrl: "http://localhost:8787", projectId: "sabc" })["/data.js"];
  const tmp = path.join(os.tmpdir(), "t2ui-remote-data-check.mjs");
  writeFileSync(tmp, src);
  try {
    execFileSync(process.execPath, ["--check", tmp]); // throws on syntax error
  } finally {
    rmSync(tmp, { force: true });
  }
}
console.log("remote data mode: all assertions passed");

// --- selection helper (Feature Inspector) -------------------------------------
{
  const tables = [{ tableName: "data", rows: [{ a: 1 }] }];
  const inline = buildSandpackConfig(app, tables);
  const remote = buildSandpackConfig(app, tables, { bffUrl: "http://x", projectId: "y" });
  for (const cfg of [inline, remote]) {
    assert.ok(cfg.files["/selection.tsx"]?.includes("t2ui.featureSelected"), "selection helper present in both modes");
  }
}
console.log("selection helper: all assertions passed");