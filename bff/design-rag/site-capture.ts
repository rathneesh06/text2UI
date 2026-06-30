// bff/design-rag/site-capture.ts — full-app-capture adapter (Increment 5).
//
// For sources that are whole running apps (e.g. TailAdmin, which uses ApexCharts
// so we can't render its components in isolation). You run the app's preview
// server yourself; this navigates a configured list of routes and screenshots
// each via the shared render queue, yielding ImportItems for runImport().
//
// Capturing against an already-running server (rather than spawning one) is the
// robust choice cross-platform — no child-process/port-wait fragility on Windows.
//
// Usage (two terminals):
//   A)  cd <cloned-app> && npm run build && npm run preview   # note the URL
//   B)  TAILADMIN_URL=http://localhost:4173 npm run capture:site -- tailadmin

import "dotenv/config";
import { pathToFileURL } from "node:url";
import type { DesignSourceAdapter, ImportItem } from "./import";
import { runImport } from "./import";
import type { DesignMode } from "./store";
import { getRenderQueue, type RenderJobOpts } from "./render-service";

export interface SiteRoute {
  path: string;
  domainHint?: string;
  mode?: DesignMode;
  width?: number;
  height?: number;
  settleMs?: number;
  fullPage?: boolean;
}

export interface SiteCaptureConfig {
  name: string;
  baseUrl: string;
  routes: SiteRoute[];
  license: string;
  attribution?: string | null;
  sourceUrl?: string | null;
  width?: number;       // defaults applied to every route
  height?: number;
  settleMs?: number;
}

export interface SiteCaptureDeps {
  capture?: (url: string, opts: RenderJobOpts) => Promise<Buffer>;
  onError?: (routePath: string, err: Error) => void;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

export function makeSiteCaptureAdapter(config: SiteCaptureConfig, deps: SiteCaptureDeps = {}): DesignSourceAdapter {
  const capture = deps.capture ?? ((url: string, opts: RenderJobOpts) => getRenderQueue().capture(url, opts));
  return {
    name: config.name,
    async *items(): AsyncIterable<ImportItem> {
      for (const route of config.routes) {
        const url = joinUrl(config.baseUrl, route.path);
        let png: Buffer;
        try {
          png = await capture(url, {
            width: route.width ?? config.width,
            height: route.height ?? config.height,
            settleMs: route.settleMs ?? config.settleMs,
            fullPage: route.fullPage ?? false,
          });
        } catch (err) {
          deps.onError?.(route.path, err as Error);
          continue; // one bad route never aborts the run
        }
        yield {
          png,
          domainHint: route.domainHint,
          mode: route.mode ?? "dashboard",
          license: config.license,
          attribution: config.attribution ?? null,
          sourceUrl: config.sourceUrl ?? url,
          // no `code` -> density gate is skipped; we trust curated full-app sources
        };
      }
    },
  };
}

/** Registry of known full-app sources. */
export const SITE_SOURCES: Record<string, SiteCaptureConfig> = {
  // TailAdmin free (React + Tailwind + ApexCharts). Free build ships ONE rich
  // dashboard at "/"; the other routes are utility pages we skip. License is
  // stated as MIT in the repo README (no LICENSE file — confirm before scaling).
  tailadmin: {
    name: "tailadmin",
    baseUrl: process.env.TAILADMIN_URL ?? "http://localhost:4173",
    routes: [
      { path: "/", domainHint: "sales", width: 1440, height: 1100 }, // KPIs + sales + target + (first rows)
    ],
    license: "MIT",
    attribution: "TailAdmin — free-react-tailwind-admin-dashboard (README: MIT)",
    sourceUrl: "https://github.com/TailAdmin/free-react-tailwind-admin-dashboard",
    settleMs: 2500,
  },
};

// CLI — runs only when executed directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const name = process.argv[2];
  const config = name ? SITE_SOURCES[name] : undefined;
  if (!config) {
    console.error(`usage: capture:site -- <source>   (known: ${Object.keys(SITE_SOURCES).join(", ")})`);
    process.exit(1);
  }
  if ((process.env.STORAGE ?? "").toLowerCase() !== "postgres" || !process.env.PG_URL || !process.env.GEMINI_API_KEY) {
    console.error("capture:site needs STORAGE=postgres, PG_URL, and GEMINI_API_KEY");
    process.exit(1);
  }
  console.log(`[design-rag] capturing ${config.name} from ${config.baseUrl} (${config.routes.length} route(s))`);
  const adapter = makeSiteCaptureAdapter(config, { onError: (r, e) => console.warn(`  route ${r} failed: ${e.message}`) });
  runImport(adapter, { onItemError: (e) => console.warn(`  ingest failed: ${e.message}`) })
    .then((s) => {
      console.log(`[design-rag] ${config.name}: imported ${s.imported}, skipped ${s.skipped}, rejected ${s.rejected}, failed ${s.failed}`);
      process.exit(0);
    })
    .catch((e) => { console.error(`capture failed: ${(e as Error).message}`); process.exit(1); });
}
