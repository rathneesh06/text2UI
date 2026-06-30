// bff/design-rag/render.ts — render an exemplar App.tsx to a PNG (cold-start).
//
// Reuses the export pipeline's SOURCE: transpile the App.tsx (the repo's exact
// ts.transpileModule recipe), wire the allowed deps via an import map to esm.sh
// (the same deps the sandbox uses), inject the mock ./data + ./selection
// modules, inline the compiled Tailwind CSS, then screenshot at 1280px with
// headless Chromium.
//
// Playwright is LAZY-imported inside renderToPng, so this module (and its pure
// helpers + tests) load fine before `npm i -D playwright`. The pure helpers
// (transpile/rewrite/buildRenderHtml) are unit-tested; the browser launch is an
// integration step run via the seed CLI.

import ts from "typescript";
import { compileCss } from "../tailwind";
import type { GeneratedFile } from "../../shared/types";
import { DATA_MODULE_JS, SELECTION_MODULE_JS } from "./render-data";

export const DEFAULT_ESM_BASE = process.env.DESIGN_RAG_ESM_BASE ?? "https://esm.sh";
export const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const REACT_V = "18.3.1";

/** TSX -> browser ESM (same options as eval/scorers.ts checkCompiles). */
export function transpileTsx(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText;
}

/** Point the exemplar's relative data/selection imports at our injected modules. */
export function rewriteAppImports(js: string): string {
  return js
    .replace(/(["'])\.\/data\1/g, '"app-data"')
    .replace(/(["'])\.\/selection\1/g, '"app-selection"');
}

/** A base64 data: URL ES module, usable as an import-map target. */
export function dataUrl(js: string): string {
  return "data:text/javascript;base64," + Buffer.from(js, "utf8").toString("base64");
}

function cdnImports(esmBase: string): Record<string, string> {
  return {
    react: `${esmBase}/react@${REACT_V}`,
    "react-dom": `${esmBase}/react-dom@${REACT_V}`,
    "react-dom/client": `${esmBase}/react-dom@${REACT_V}/client`,
    "react/jsx-runtime": `${esmBase}/react@${REACT_V}/jsx-runtime`,
    recharts: `${esmBase}/recharts@2.13.0?deps=react@${REACT_V},react-dom@${REACT_V}`,
    "lucide-react": `${esmBase}/lucide-react@0.460.0?deps=react@${REACT_V}`,
  };
}

/** Assemble the full HTML page that mounts the (already transpiled+rewritten) app. */
export function buildRenderHtml(opts: { appJs: string; css?: string; esmBase?: string }): string {
  const esmBase = opts.esmBase ?? DEFAULT_ESM_BASE;
  const importmap = {
    imports: {
      ...cdnImports(esmBase),
      "app-app": dataUrl(opts.appJs),
      "app-data": dataUrl(DATA_MODULE_JS),
      "app-selection": dataUrl(SELECTION_MODULE_JS),
    },
  };
  const mount = [
    'import App from "app-app";',
    'import React from "react";',
    'import { createRoot } from "react-dom/client";',
    'const el = document.getElementById("root");',
    "createRoot(el).render(React.createElement(App));",
  ].join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
<style>${opts.css ?? ""}
html,body{margin:0;background:#ffffff;font-family:Inter,ui-sans-serif,system-ui,sans-serif;}</style>
<script type="importmap">${JSON.stringify(importmap)}</script>
</head><body><div id="root"></div>
<script type="module">${mount}</script>
</body></html>`;
}

export interface RenderOpts { width?: number; height?: number; settleMs?: number; fullPage?: boolean; }

/** Render HTML to a PNG via the shared render queue (single reused Chromium,
 *  concurrency-capped). Replaces the old launch-a-browser-per-call path so a
 *  burst of enrollments no longer spawns a burst of browsers. */
export async function renderToPng(html: string, opts: RenderOpts = {}): Promise<Buffer> {
  const { getRenderQueue } = await import("./render-service");
  return getRenderQueue().render(html, opts);
}

/** Render an Apache ECharts `option` (a JS object expression as a string) to PNG.
 *  Loads echarts from esm.sh, inits a chart, calls setOption, screenshots. Used
 *  by the ECharts gallery import for chart types Recharts lacks (gauge, funnel,
 *  radar, treemap, sankey, …). NOTE: needs network access to esm.sh at run time. */
export async function renderEChartsOption(optionExpr: string, opts: RenderOpts = {}): Promise<Buffer> {
  const base = DEFAULT_ESM_BASE;
  const w = opts.width ?? 900, h = opts.height ?? 520;
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:16px;background:#ffffff;font-family:Inter,system-ui,sans-serif}#c{width:${w - 32}px;height:${h - 32}px}</style>
</head><body><div id="c"></div>
<script type="module">
import * as echarts from "${base}/echarts@5.5.1";
const chart = echarts.init(document.getElementById("c"));
chart.setOption(${optionExpr});
</script></body></html>`;
  const { getRenderQueue } = await import("./render-service");
  return getRenderQueue().render(html, { width: w, height: h, settleMs: opts.settleMs ?? 1500, fullPage: false });
}

export interface RenderExemplarDeps {
  compileCss?: (files: GeneratedFile[]) => Promise<string | null>;
  renderToPng?: (html: string, opts?: RenderOpts) => Promise<Buffer>;
  esmBase?: string;
  renderOpts?: RenderOpts;
}

/** End-to-end for one exemplar: transpile -> rewrite -> compile CSS -> render. */
export async function renderExemplarToPng(code: string, deps: RenderExemplarDeps = {}): Promise<Buffer> {
  const compile = deps.compileCss ?? compileCss;
  const render = deps.renderToPng ?? renderToPng;
  const appJs = rewriteAppImports(transpileTsx(code));
  const css = (await compile([{ path: "App.tsx", content: code }])) ?? "";
  const html = buildRenderHtml({ appJs, css, esmBase: deps.esmBase });
  return render(html, deps.renderOpts);
}
