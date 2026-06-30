import assert from "node:assert";
import JSZip from "jszip";
import { scaffoldProject, slugifyAppName, buildExportZip } from "./export";
import type { GeneratedApp } from "../shared/types";

const sampleApp: GeneratedApp = {
  summary: "Revenue by region",
  files: [
    {
      path: "App.tsx",
      content:
        "//__SUMMARY__ Revenue by region\nimport { rows } from './data';\nexport default function App(){ return <div className='p-4'>{rows.length}</div>; }\n//__END__",
    },
  ],
};
const tables = [{ tableName: "sales", rows: [{ region: "NA", amount: 10 }] }];

// ---- slugify ---------------------------------------------------------------
{
  assert.equal(slugifyAppName("My Cool App!"), "my-cool-app");
  assert.equal(slugifyAppName(""), "text2ui-app");
  assert.equal(slugifyAppName(undefined), "text2ui-app");
  assert.equal(slugifyAppName("--Edge__"), "edge");
}

// ---- inline mode -----------------------------------------------------------
{
  const files = scaffoldProject({ app: sampleApp, tables, appName: "Sales Dash", dataMode: "inline" });
  const keys = Object.keys(files);
  for (const k of [
    "package.json", "vite.config.ts", "tsconfig.json", "index.html",
    "src/main.tsx", "src/App.tsx", "src/index.css", "src/selection.js",
    "src/data.js", "src/rows.js", "README.md", ".gitignore",
  ]) {
    assert.ok(keys.includes(k), `inline scaffold must include ${k}`);
  }

  // entry component lands at src/App.tsx, markers stripped
  assert.ok(!files["src/App.tsx"].includes("__SUMMARY__"), "summary marker stripped");
  assert.ok(!files["src/App.tsx"].includes("__END__"), "end marker stripped");
  assert.ok(files["src/App.tsx"].includes("export default function App"), "App code preserved");

  // package.json: inline has duckdb; tailwind+vite in devDeps; slugified name
  const pkg = JSON.parse(files["package.json"]);
  assert.equal(pkg.name, "sales-dash");
  assert.ok(pkg.dependencies["@duckdb/duckdb-wasm"], "inline includes duckdb-wasm");
  assert.ok(pkg.devDependencies["@tailwindcss/vite"] && pkg.devDependencies["tailwindcss"], "tailwind v4 devDeps");
  assert.ok(pkg.devDependencies["vite"] && pkg.devDependencies["@vitejs/plugin-react"], "vite devDeps");
  assert.equal(pkg.scripts.build, "vite build");

  // rows baked in
  assert.ok(files["src/rows.js"].includes("sales") && files["src/rows.js"].includes("NA"), "rows baked into rows.js");

  // CSS entry uses real tailwind v4 + theme tokens (no injection hack)
  assert.ok(files["src/index.css"].includes('@import "tailwindcss"'), "tailwind v4 entry import");
  assert.ok(files["src/index.css"].includes("@theme"), "theme tokens present");

  // vite config wires both plugins
  assert.ok(files["vite.config.ts"].includes("@tailwindcss/vite") && files["vite.config.ts"].includes("@vitejs/plugin-react"));

  // index.html points at the real entry
  assert.ok(files["index.html"].includes("/src/main.tsx"), "html loads main.tsx");
}

// ---- remote mode -----------------------------------------------------------
{
  const files = scaffoldProject({
    app: sampleApp, appName: "Remote App", dataMode: "remote",
    remote: { bffUrl: "https://api.example.com", projectId: "proj_1" },
  });
  assert.ok(!Object.keys(files).includes("src/rows.js"), "remote has no baked rows");
  const pkg = JSON.parse(files["package.json"]);
  assert.ok(!pkg.dependencies["@duckdb/duckdb-wasm"], "remote omits duckdb-wasm");
  assert.ok(files["src/data.js"].includes("/api/query"), "remote data layer hits /api/query");
  assert.ok(files["src/data.js"].includes("proj_1"), "remote project id baked in");
}

// ---- guards ----------------------------------------------------------------
{
  assert.throws(() => scaffoldProject({ app: { files: [] }, tables }), /no files/, "empty app rejected");
  assert.throws(() => scaffoldProject({ app: sampleApp, dataMode: "inline" }), /inline mode requires/, "inline needs tables");
  assert.throws(() => scaffoldProject({ app: sampleApp, dataMode: "remote" }), /remote mode requires/, "remote needs config");
}

// ---- zip round-trip --------------------------------------------------------
{
  const { zip, filename } = await buildExportZip({ app: sampleApp, tables, appName: "Sales Dash", dataMode: "inline" });
  assert.ok(Buffer.isBuffer(zip) && zip.length > 0, "zip is a non-empty Buffer");
  assert.equal(filename, "sales-dash.zip", "download filename is slugified");

  const back = await JSZip.loadAsync(zip);
  const names = Object.keys(back.files);
  for (const k of ["package.json", "src/App.tsx", "src/rows.js", "vite.config.ts", "index.html"]) {
    assert.ok(names.includes(k), `zip contains ${k}`);
  }
  const pkgText = await back.file("package.json")!.async("string");
  const pkg = JSON.parse(pkgText);
  assert.equal(pkg.name, "sales-dash", "zipped package.json is intact and parseable");
  const appText = await back.file("src/App.tsx")!.async("string");
  assert.ok(!appText.includes("__END__"), "zipped App.tsx has markers stripped");
}

// ---- connected bundle (N3) -------------------------------------------------
{
  const { scaffoldConnectedBundle, buildConnectedZip } = await import("./export");
  const files = scaffoldConnectedBundle({ app: sampleApp, tables, appName: "Sales Dash" });
  const keys = Object.keys(files);
  for (const k of [
    "app/package.json", "app/src/App.tsx", "app/src/data.js",
    "db/schema.sql", "db/seed.sql",
    "server/server.mjs", "server/package.json", "README.md",
  ]) {
    assert.ok(keys.includes(k), `connected bundle includes ${k}`);
  }
  // app is in REMOTE mode (queries the server; no baked rows)
  assert.ok(files["app/src/data.js"].includes("/api/query"), "app uses remote data layer");
  assert.ok(!keys.includes("app/src/rows.js"), "no baked rows in connected bundle");
  const appPkg = JSON.parse(files["app/package.json"]);
  assert.ok(!appPkg.dependencies["@duckdb/duckdb-wasm"], "remote app omits duckdb");
  // db dump is Postgres dialect, generated from the rows
  assert.ok(files["db/schema.sql"].includes("DOUBLE PRECISION"), "schema is postgres dialect");
  assert.ok(files["db/schema.sql"].includes('CREATE TABLE "sales"'), "schema creates the table");
  assert.ok(files["db/seed.sql"].includes("INSERT INTO \"sales\""), "seed inserts rows");
  // server ships the read-only guard + targets pg
  assert.ok(files["server/server.mjs"].includes("assertReadOnly") && files["server/server.mjs"].includes("/api/query"), "server has guard + endpoint");
  assert.ok(JSON.parse(files["server/package.json"]).dependencies.pg, "server depends on pg");

  const { zip, filename } = await buildConnectedZip({ app: sampleApp, tables, appName: "Sales Dash" });
  assert.equal(filename, "sales-dash-bundle.zip", "bundle filename");
  assert.ok(Buffer.isBuffer(zip) && zip.length > 0, "bundle zips");

  // guard: connected bundle requires rows
  assert.throws(() => scaffoldConnectedBundle({ app: sampleApp }), /requires tables/, "connected needs tables");
}

console.log("export.test.ts: all assertions passed");
