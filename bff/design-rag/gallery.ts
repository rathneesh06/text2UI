// bff/design-rag/gallery.ts — render-spec import adapter (Increments 2 & 3).
//
// A GallerySpec is a small renderable chart/dashboard spec with provenance. The
// adapter renders each via the right path and yields ImportItems for runImport.
// Two renderer kinds:
//   - 'recharts': self-contained TSX (default-exported component, inline data),
//      rendered through the SAME harness as exemplars (Tailwind + Recharts).
//      Carries `code`, so the density gate applies — keeps dashboards compact.
//   - 'echarts':  an ECharts `option` expression, rendered via esm.sh echarts.
//      Chart-level (no grid), so no `code`/density gate.
//
// Tremor note: tremor-raw is a copy-paste component library whose charts ARE
// Recharts under the hood; rather than bundle its local utils/Radix/tailwind-
// variants deps, the Tremor aesthetic is covered by the Recharts specs here.

import type { DesignSourceAdapter, ImportItem } from "./import";
import type { DesignMode } from "./store";
import { renderExemplarToPng, renderEChartsOption } from "./render";

export type GalleryRenderer = "recharts" | "echarts";

export interface GallerySpec {
  id: string;
  renderer: GalleryRenderer;
  code: string;                // TSX (recharts) or an ECharts option expression (echarts)
  domainHint?: string;
  mode?: DesignMode;
  license: string;
  attribution: string;
  sourceUrl?: string | null;
}

export interface GalleryDeps {
  renderRecharts?: (code: string) => Promise<Buffer>;
  renderEcharts?: (optionExpr: string) => Promise<Buffer>;
  onError?: (id: string, err: Error) => void;
}

export function makeGalleryAdapter(name: string, specs: GallerySpec[], deps: GalleryDeps = {}): DesignSourceAdapter {
  const renderRecharts = deps.renderRecharts ?? ((code: string) => renderExemplarToPng(code));
  const renderEcharts = deps.renderEcharts ?? ((opt: string) => renderEChartsOption(opt));
  return {
    name,
    async *items(): AsyncIterable<ImportItem> {
      for (const spec of specs) {
        let png: Buffer;
        try {
          png = spec.renderer === "echarts" ? await renderEcharts(spec.code) : await renderRecharts(spec.code);
        } catch (err) {
          deps.onError?.(spec.id, err as Error);
          continue; // one bad spec never aborts the batch
        }
        yield {
          png,
          domainHint: spec.domainHint,
          mode: spec.mode ?? "dashboard",
          license: spec.license,
          attribution: spec.attribution,
          sourceUrl: spec.sourceUrl ?? null,
          // density gate only for full TSX dashboards, not single ECharts charts
          code: spec.renderer === "recharts" ? spec.code : undefined,
        };
      }
    },
  };
}
