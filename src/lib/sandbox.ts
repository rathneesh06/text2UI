// sandbox.ts — pipeline stage 4b (BROWSER, host-side, framework-agnostic core).
// Pure logic the React <Sandbox> component consumes:
//   - buildSandpackConfig(): merges generated files + data layer + entry into a
//     ready-to-mount Sandpack config.
//   - extractRuntimeError(): turns a SandpackMessage into a self-heal error string.
// No JSX here on purpose — the actual mount lives in src/components/Sandbox.tsx.

import type { GeneratedApp } from "../../shared/types";
import { dataModuleFiles, remoteDataModuleFiles, DATA_RUNTIME_DEPS, type TableData, type RemoteDataConfig } from "./data";

export interface SandpackConfig {
  files: Record<string, string>;
  customSetup: { dependencies: Record<string, string>; entry: string };
  mainFile: string; // the generated file to show in an editor, if any
  /** True when no compiled CSS was shipped and the sandbox must load the Play
   *  CDN as a fallback (the component wires this into externalResources). */
  needsCdnFallback: boolean;
}

// Base deps every generated app can rely on (matches the assembler's contract).
// recharts needs react-is at runtime, and Sandpack's CDN resolver does NOT
// reliably pull recharts' transitive deps — so react-is is declared explicitly.
const BASE_DEPS: Record<string, string> = {
  react: "^18.0.0",
  "react-dom": "^18.0.0",
  recharts: "^2.13.0", // pinned to v2; v3 changes the internal module layout
  "react-is": "^18.0.0",
  "lucide-react": "^0.460.0", // icon set the model is fluent in (design-system contract)
};

/** The Tailwind Play CDN — FALLBACK only, used when the server didn't ship
 *  compiled CSS (compile failed, or this is an edit/heal reusing the build's
 *  CSS). The primary path is compiled CSS injected via SANDBOX_INDEX_HTML. */
export const SANDBOX_EXTERNAL_RESOURCES: string[] = [];

/** The sandbox document. IMPORTANT: Sandpack's bundler STRIPS the <head> of a
 *  custom index.html (documented Sandpack behavior), so styles must NOT be
 *  injected here — compiled CSS is bundled via the entry's `import "./styles.css"`,
 *  and the CDN fallback is supplied through the Sandbox component's
 *  externalResources (which Sandpack injects itself). The font <link> is kept
 *  as best-effort; if the bundler drops it, the CSS font stack still applies. */
export function sandboxIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>text2UI preview</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
}

const SELECTION_HELPER_SRC = `export function selectFeature(payload) {
  if (typeof window !== "undefined" && window.parent && typeof window.parent.postMessage === "function") {
    window.parent.postMessage({ type: "t2ui.featureSelected", payload }, "*");
  }
}
`;

function withLeadingSlash(p: string): string {
  return p.startsWith("/") ? p : "/" + p;
}
// Route generated code files to .tsx so the TS-capable bundler strips types.
// (The model emits TypeScript regardless of the prompt; valid JS is valid in .tsx too.)
// Non-code files (.css, etc.) keep their extension.
function normalizeCodePath(p: string): string {
  const s = withLeadingSlash(p);
  return /\.(jsx?|tsx?)$/i.test(s) ? s.replace(/\.(jsx?|tsx?)$/i, ".tsx") : s;
}
function importSpecifier(path: string): string {
  return "./" + path.replace(/^\//, "").replace(/\.(jsx?|tsx?)$/i, "");
}

// React 18 entry that mounts the generated component's default export.
// When compiled CSS is present we import it HERE (not via index.html <head>,
// which Sandpack's bundler strips — see buildSandpackConfig). Importing a .css
// file from the entry goes through the bundler, which injects it into the DOM.
function entrySource(mainImport: string, hasCss: boolean): string {
  return `${hasCss ? `import "./styles.css";\n` : ""}import React from "react";
import { createRoot } from "react-dom/client";
import App from "${mainImport}";

const el = document.getElementById("root");
createRoot(el).render(React.createElement(App));
`;
}

/** Merge the generated app + the data layer into a Sandpack config.
 *  Inline mode (default): rows are embedded, DuckDB-WASM runs in the sandbox.
 *  Remote mode: /data.js fetches the BFF's /api/query — no rows, no WASM dep. */
export function buildSandpackConfig(
  app: GeneratedApp,
  tables: TableData[],
  remote?: RemoteDataConfig,
): SandpackConfig {
  if (!app.files.length) throw new Error("generated app has no files");
  if (!remote && !tables.length) throw new Error("no datasets to mount");

  // normalize generated file paths (leading slash + code files -> .tsx)
  const generated: Record<string, string> = {};
  for (const f of app.files) generated[normalizeCodePath(f.path)] = f.content;

  // pick the entry component: an App.* file if present, else the first file
  const paths = Object.keys(generated);
  const mainFile =
    paths.find((p) => /(^|\/)App\.(jsx?|tsx?)$/i.test(p)) ?? paths[0];

  const hasCss = !!app.css;
  const files: Record<string, string> = {
    ...generated,
    ...(remote ? remoteDataModuleFiles(remote) : dataModuleFiles(tables)),
    "/selection.tsx": SELECTION_HELPER_SRC,
    "/index.tsx": entrySource(importSpecifier(mainFile), hasCss),
    // index.html only carries fonts + a transparent body. CSS does NOT go here:
    // Sandpack's bundler strips the <head>, so compiled CSS is bundled via the
    // entry's `import "./styles.css"` instead, and the CDN fallback rides on
    // the Sandbox component's externalResources (which Sandpack injects itself).
    "/public/index.html": sandboxIndexHtml(),
  };
  if (hasCss) files["/styles.css"] = app.css as string;

  return {
    files,
    customSetup: {
      // remote mode needs no DuckDB-WASM in the sandbox
      dependencies: remote ? { ...BASE_DEPS } : { ...BASE_DEPS, ...DATA_RUNTIME_DEPS },
      entry: "/index.tsx",
    },
    mainFile,
    needsCdnFallback: !app.css,
  };
}

// SandpackMessage shapes vary by version; compile + runtime errors both surface
// as { type: "action", action: "show-error", title?, message?, path?, line? }.
// Kept defensive so a field rename upstream degrades to a generic message.
export function extractRuntimeError(message: any): string | null {
  if (!message || typeof message !== "object") return null;
  if (message.type === "action" && message.action === "show-error") {
    const where = message.path ? ` (${message.path}${message.line ? ":" + message.line : ""})` : "";
    const text = [message.title, message.message].filter(Boolean).join(": ");
    return (text || "Unknown render error") + where;
  }
  return null;
}