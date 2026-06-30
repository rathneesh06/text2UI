// bff/export.ts — Wave 1 / N5 (full-app export), Step 1: the scaffolder.
//
// Turns a generated app + its data into a COMPLETE, conventional Vite + React +
// TypeScript + Tailwind-v4 project as a path->content map. Unlike the Sandpack
// sandbox (which injects compiled CSS and mounts in-page), the exported project
// builds the normal way: `npm install && npm run build`. Styling is reproduced
// with Tailwind v4's first-party Vite plugin + an @theme block that matches the
// server compile (bff/tailwind.ts), so the look is faithful AND rebuildable.
//
// Data layer reuses the SAME pure factories the sandbox uses (src/lib/data), so
// there's no second implementation to drift:
//   - inline (default): rows baked into src/rows.js; DuckDB-WASM loads from the
//     jsDelivr CDN at runtime, so the build stays self-contained.
//   - remote: src/data.js POSTs to a BFF /api/query (the bridge to N3 — Step 4).

import type { GeneratedApp } from "../shared/types";
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { toSchemaSql, toSeedSql } from "./dbexport";
import {
  dataModuleFiles,
  remoteDataModuleFiles,
  type TableData,
  type RemoteDataConfig,
} from "../src/lib/data";

export type ExportDataMode = "inline" | "remote";

export interface ExportInput {
  app: GeneratedApp;
  /** Inline mode needs the rows; remote mode ignores them. */
  tables?: TableData[];
  /** Used for package.json name + index.html <title>. */
  appName?: string;
  dataMode?: ExportDataMode;
  /** Required when dataMode === "remote". */
  remote?: RemoteDataConfig;
}

// Runtime deps every exported app relies on (mirrors the sandbox BASE_DEPS).
const BASE_DEPS: Record<string, string> = {
  react: "^18.3.1",
  "react-dom": "^18.3.1",
  recharts: "^2.13.0",
  "react-is": "^18.3.1",
  "lucide-react": "^0.460.0",
};
const INLINE_DATA_DEPS: Record<string, string> = {
  "@duckdb/duckdb-wasm": "1.32.0",
};
const DEV_DEPS: Record<string, string> = {
  "@types/react": "^18.3.0",
  "@types/react-dom": "^18.3.0",
  "@vitejs/plugin-react": "^4.3.0",
  "@tailwindcss/vite": "^4.0.0",
  tailwindcss: "^4.0.0",
  typescript: "^5.6.0",
  vite: "^5.4.0",
};

/** Theme tokens kept in sync with bff/tailwind.ts THEME (Inter + shadow scale). */
const THEME_BLOCK = `@theme {
  --font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --shadow-sm: 0 1px 2px 0 rgb(15 23 42 / 0.04);
  --shadow: 0 1px 3px 0 rgb(15 23 42 / 0.06), 0 1px 2px -1px rgb(15 23 42 / 0.06);
  --shadow-md: 0 4px 12px -2px rgb(15 23 42 / 0.08), 0 2px 6px -2px rgb(15 23 42 / 0.05);
  --shadow-lg: 0 12px 28px -8px rgb(15 23 42 / 0.12), 0 4px 10px -4px rgb(15 23 42 / 0.08);
}`;

/** npm package names must be lowercase, url-safe, non-empty. */
export function slugifyAppName(name: string | undefined): string {
  const s = (name ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-_.]+|[-_.]+$/g, "");
  return s || "text2ui-app";
}

/** Strip the pipeline markers in case they survived into stored file content. */
function stripMarkers(code: string): string {
  return code
    .replace(/^\s*\/\/__SUMMARY__.*$/gm, "")
    .replace(/^\s*\/\/__END__\s*$/gm, "")
    .replace(/^\s+/, "");
}

/** Pick the entry component (an App.* file if present, else the first file). */
function pickMain(files: GeneratedApp["files"]): GeneratedApp["files"][number] {
  return files.find((f) => /(^|\/)App\.(jsx?|tsx?)$/i.test(f.path)) ?? files[0];
}

function packageJson(name: string, mode: ExportDataMode): string {
  const deps = mode === "inline" ? { ...BASE_DEPS, ...INLINE_DATA_DEPS } : { ...BASE_DEPS };
  const pkg = {
    name,
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    dependencies: sortKeys(deps),
    devDependencies: sortKeys(DEV_DEPS),
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
`;

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2020",
      useDefineForClassFields: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      allowJs: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: "react-jsx",
      // lenient on purpose: a downloadable app should `npm run build` even if the
      // generated TSX has loose types (vite build transpiles, it does not typecheck).
      strict: false,
    },
    include: ["src", "index.html"],
  },
  null,
  2,
) + "\n";

function indexHtml(title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

const MAIN_TSX = `import "./index.css";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");
createRoot(el).render(React.createElement(App));
`;

function indexCss(): string {
  return `@import "tailwindcss";

${THEME_BLOCK}

body { font-family: var(--font-sans); }
`;
}

const SELECTION_JS = `export function selectFeature(payload) {
  if (typeof window !== "undefined" && window.parent && typeof window.parent.postMessage === "function") {
    window.parent.postMessage({ type: "t2ui.featureSelected", payload }, "*");
  }
}
`;

const GITIGNORE = `node_modules/\ndist/\n*.log\n.DS_Store\n`;

function readme(name: string, mode: ExportDataMode): string {
  const dataNote =
    mode === "inline"
      ? "Your data is baked into `src/rows.js`. The app runs fully self-contained (DuckDB-WASM loads from a CDN at runtime, so an internet connection is needed the first time)."
      : "This build queries a backend at runtime via `src/data.js` (`/api/query`). Point it at your own database/BFF.";
  return `# ${name}

Generated by text2UI. A standalone Vite + React + TypeScript + Tailwind v4 app.

## Run

\`\`\`bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build -> dist/
npm run preview  # preview the production build
\`\`\`

## Data

${dataNote}

## Structure

- \`src/App.tsx\` — the generated UI.
- \`src/data.js\` — the data layer (\`import { rows, query } from "./data"\`).
- \`src/selection.js\` — the \`selectFeature\` helper.
- \`src/index.css\` — Tailwind v4 entry + theme tokens.
`;
}

/**
 * Build the complete project as a path->content map.
 * Keys are POSIX-relative paths (e.g. "src/App.tsx", "package.json").
 */
export function scaffoldProject(input: ExportInput): Record<string, string> {
  const { app } = input;
  if (!app?.files?.length) throw new Error("export: generated app has no files");

  const mode: ExportDataMode = input.dataMode ?? "inline";
  if (mode === "remote" && !input.remote) throw new Error('export: remote mode requires a "remote" config');
  if (mode === "inline" && !(input.tables && input.tables.length)) {
    throw new Error("export: inline mode requires tables[] with rows");
  }

  const name = slugifyAppName(input.appName ?? app.summary);
  const title = input.appName?.trim() || "text2UI app";
  const main = pickMain(app.files);

  // The generated component(s). The entry one is forced to src/App.tsx so the
  // fixed main.tsx import (`./App`) always resolves; any other generated files
  // keep their relative path under src/.
  const out: Record<string, string> = {};
  for (const f of app.files) {
    const isMain = f.path === main.path;
    const rel = isMain ? "src/App.tsx" : "src/" + f.path.replace(/^\/+/, "");
    out[rel] = stripMarkers(f.content);
  }

  // Data layer: reuse the sandbox's pure factories, but relocate the leading-
  // slash sandbox paths (/data.js, /rows.js) under src/.
  const dataFiles = mode === "remote" ? remoteDataModuleFiles(input.remote!) : dataModuleFiles(input.tables!);
  for (const [k, v] of Object.entries(dataFiles)) out["src/" + k.replace(/^\/+/, "")] = v;

  out["src/selection.js"] = SELECTION_JS;
  out["src/main.tsx"] = MAIN_TSX;
  out["src/index.css"] = indexCss();
  out["index.html"] = indexHtml(title);
  out["package.json"] = packageJson(name, mode);
  out["vite.config.ts"] = VITE_CONFIG;
  out["tsconfig.json"] = TSCONFIG;
  out[".gitignore"] = GITIGNORE;
  out["README.md"] = readme(title, mode);

  return out;
}

/** Zip a path->content map into a single archive (Buffer, ready to stream to a
 *  client). DEFLATE-compressed; deterministic ordering for stable output. */
export async function zipFiles(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const path of Object.keys(files).sort()) {
    zip.file(path, files[path]);
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/** Scaffold + zip in one call. Returns the archive Buffer and a download name. */
export async function buildExportZip(input: ExportInput): Promise<{ zip: Buffer; filename: string }> {
  const files = scaffoldProject(input);
  const zip = await zipFiles(files);
  const filename = slugifyAppName(input.appName ?? input.app.summary) + ".zip";
  return { zip, filename };
}

// ===== N3: the "connected" bundle (app + database + query server) ===========

/** The standalone read-only Postgres query server shipped in the bundle. */
function queryServerSource(): string {
  return readFileSync(new URL("./templates/query-server.mjs", import.meta.url), "utf8");
}

function connectedReadme(title: string, projectId: string): string {
  return `# ${title} - connected bundle

A standalone app wired to YOUR Postgres database. Three pieces:

- \`app/\`    - the React app (remote data mode: it queries a backend, not bundled rows)
- \`server/\` - a tiny read-only query server that runs SQL against your Postgres
- \`db/\`     - the data as portable SQL (\`schema.sql\` + \`seed.sql\`)

## 1. Load the data into your Postgres

\`\`\`bash
psql "<your-connection-string>" -f db/schema.sql
psql "<your-connection-string>" -f db/seed.sql
\`\`\`
(Or point the app at a database that already has these tables.)

## 2. Start the query server (serves /api/query, read-only)

\`\`\`bash
cd server
npm install
# PowerShell:  $env:DATABASE_URL="postgres://user:pass@host:5432/db"
# bash:        export DATABASE_URL="postgres://user:pass@host:5432/db"
npm start            # http://localhost:8787
\`\`\`

## 3. Run the app

\`\`\`bash
cd app
npm install
npm run dev          # http://localhost:5173
\`\`\`

The app posts SQL to \`http://localhost:8787/api/query\` (project id \`${projectId}\`).
Only read statements are allowed; writes/DDL/multi-statements are rejected by the
server's guard. To point at a different backend, edit \`app/src/data.js\`.
`;
}

/** Build the full connected bundle as a path->content map:
 *  app/ (remote-mode scaffold) + server/ (query shim) + db/ (Postgres dump) + README. */
export function scaffoldConnectedBundle(input: ExportInput): Record<string, string> {
  const { app } = input;
  if (!app?.files?.length) throw new Error("export: generated app has no files");
  if (!(input.tables && input.tables.length)) {
    throw new Error("connected bundle requires tables[] with rows");
  }
  const name = slugifyAppName(input.appName ?? app.summary);
  const title = input.appName?.trim() || "text2UI app";

  const out: Record<string, string> = {};

  // app/ - remote-mode scaffold pointing at the local query server
  const appFiles = scaffoldProject({
    app,
    appName: input.appName,
    dataMode: "remote",
    remote: { bffUrl: "http://localhost:8787", projectId: name },
  });
  for (const [k, v] of Object.entries(appFiles)) out["app/" + k] = v;

  // db/ - Postgres dump generated from the rows
  const dumpTables = input.tables.map((t) => ({ tableName: t.tableName, rows: t.rows }));
  out["db/schema.sql"] = toSchemaSql(dumpTables, "postgres");
  out["db/seed.sql"] = toSeedSql(dumpTables, "postgres");

  // server/ - standalone read-only query server (Postgres)
  out["server/server.mjs"] = queryServerSource();
  out["server/package.json"] =
    JSON.stringify(
      {
        name: name + "-query-server",
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: { start: "node server.mjs" },
        dependencies: { pg: "^8.21.0" },
      },
      null,
      2,
    ) + "\n";

  out["README.md"] = connectedReadme(title, name);
  return out;
}

export async function buildConnectedZip(input: ExportInput): Promise<{ zip: Buffer; filename: string }> {
  const files = scaffoldConnectedBundle(input);
  const zip = await zipFiles(files);
  const filename = slugifyAppName(input.appName ?? input.app.summary) + "-bundle.zip";
  return { zip, filename };
}
