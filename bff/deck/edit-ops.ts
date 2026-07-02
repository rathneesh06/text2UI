// bff/deck/edit-ops.ts — the addressable-edit engine. Instead of re-planning the whole
// deck on every refinement (which loses fine-grained changes), edits are expressed as
// typed operations that TARGET a slide/block by id and mutate just that node. This is the
// "structured state change, not artifact bytes" idea from the design doc, applied to decks.
// assignIds() gives every slide/block a stable handle (including charts the Visual Planner
// synthesized) so the user can say "the revenue chart" and we know exactly what they mean.
import type { DeckSpec, Slide, Block, ChartBlock } from "../../shared/deck-spec";
import type { Dimension, Metric } from "../../shared/dashboard-spec";

// ---- stable ids ------------------------------------------------------------
export function assignIds(spec: DeckSpec): DeckSpec {
  const slides = spec.slides.map((s, si) => {
    const sid = s.id || `s${si + 1}`;
    const blocks = s.blocks.map((b, bi) => (b.id ? b : { ...b, id: `${sid}-${b.type}${bi + 1}` }));
    return { ...s, id: sid, blocks };
  });
  return { ...spec, slides };
}

// ---- typed edit operations -------------------------------------------------
export type ChartPatch = { title?: string; x?: Dimension; series?: Metric[]; sort?: ChartBlock["sort"]; limit?: number };

export type EditOp =
  | { op: "setTheme"; theme: "light" | "dark" }
  | { op: "setMeta"; title?: string; subtitle?: string }
  | { op: "setSlideText"; slideId: string; title?: string; message?: string }
  | { op: "setChartType"; slideId: string; blockId: string; chartType: ChartBlock["chartType"] }
  | { op: "updateChart"; slideId: string; blockId: string; patch: ChartPatch }
  | { op: "setBullets"; slideId: string; blockId: string; items: string[] }
  | { op: "removeBlock"; slideId: string; blockId: string }
  | { op: "addBlock"; slideId: string; block: Block }
  | { op: "removeSlide"; slideId: string }
  | { op: "addSlide"; slide: Slide; afterSlideId?: string }
  | { op: "moveSlide"; slideId: string; toIndex: number };

export interface ApplyResult { spec: DeckSpec; applied: number; warnings: string[] }

const findSlide = (spec: DeckSpec, id: string) => spec.slides.findIndex((s) => s.id === id);
const findBlock = (s: Slide, id: string) => s.blocks.findIndex((b) => b.id === id);

/** Apply a list of edit operations to a spec deterministically. Missing targets are
 *  skipped with a warning rather than throwing, so one bad op can't wreck the deck. */
export function applyEdit(input: DeckSpec, ops: EditOp[]): ApplyResult {
  let spec: DeckSpec = { ...input, meta: { ...input.meta }, slides: input.slides.map((s) => ({ ...s, blocks: [...s.blocks] })) };
  const warnings: string[] = [];
  let applied = 0;
  const warn = (m: string) => warnings.push(m);

  const editBlock = (slideId: string, blockId: string, fn: (b: Block) => Block | null): boolean => {
    const si = findSlide(spec, slideId);
    if (si < 0) { warn(`slide "${slideId}" not found`); return false; }
    const bi = findBlock(spec.slides[si], blockId);
    if (bi < 0) { warn(`block "${blockId}" not found on ${slideId}`); return false; }
    const next = fn(spec.slides[si].blocks[bi]);
    const blocks = [...spec.slides[si].blocks];
    if (next) blocks[bi] = next; else blocks.splice(bi, 1);
    spec.slides[si] = { ...spec.slides[si], blocks };
    return true;
  };

  for (const op of ops) {
    switch (op.op) {
      case "setTheme": spec.meta.theme = op.theme; applied++; break;
      case "setMeta":
        if (op.title !== undefined) spec.meta.title = op.title;
        if (op.subtitle !== undefined) spec.meta.subtitle = op.subtitle;
        applied++; break;
      case "setSlideText": {
        const si = findSlide(spec, op.slideId);
        if (si < 0) { warn(`slide "${op.slideId}" not found`); break; }
        spec.slides[si] = { ...spec.slides[si], ...(op.title !== undefined ? { title: op.title } : {}), ...(op.message !== undefined ? { message: op.message } : {}) };
        applied++; break;
      }
      case "setChartType":
        if (editBlock(op.slideId, op.blockId, (b) => (b.type === "chart" ? { ...b, chartType: op.chartType } : b))) applied++;
        break;
      case "updateChart":
        if (editBlock(op.slideId, op.blockId, (b) => (b.type === "chart" ? { ...b, ...op.patch } : b))) applied++;
        break;
      case "setBullets":
        if (editBlock(op.slideId, op.blockId, (b) => (b.type === "bullets" ? { ...b, items: op.items } : b))) applied++;
        break;
      case "removeBlock":
        if (editBlock(op.slideId, op.blockId, () => null)) applied++;
        break;
      case "addBlock": {
        const si = findSlide(spec, op.slideId);
        if (si < 0) { warn(`slide "${op.slideId}" not found`); break; }
        const block = op.block.id ? op.block : { ...op.block, id: `${op.slideId}-${op.block.type}${spec.slides[si].blocks.length + 1}` };
        spec.slides[si] = { ...spec.slides[si], blocks: [...spec.slides[si].blocks, block] };
        applied++; break;
      }
      case "removeSlide": {
        const si = findSlide(spec, op.slideId);
        if (si < 0) { warn(`slide "${op.slideId}" not found`); break; }
        spec.slides = spec.slides.filter((_, i) => i !== si);
        applied++; break;
      }
      case "addSlide": {
        const slide = op.slide.id ? op.slide : { ...op.slide, id: `s${spec.slides.length + 1}` };
        const at = op.afterSlideId ? findSlide(spec, op.afterSlideId) + 1 : spec.slides.length;
        spec.slides = [...spec.slides.slice(0, at), slide, ...spec.slides.slice(at)];
        applied++; break;
      }
      case "moveSlide": {
        const si = findSlide(spec, op.slideId);
        if (si < 0) { warn(`slide "${op.slideId}" not found`); break; }
        const [moved] = spec.slides.splice(si, 1);
        const to = Math.max(0, Math.min(op.toIndex, spec.slides.length));
        spec.slides.splice(to, 0, moved);
        applied++; break;
      }
      default: warn(`unknown op "${(op as any).op}"`);
    }
  }
  return { spec, applied, warnings };
}

/** Human-readable summary of what an edit changed (for the chat reply). */
export function describeOps(ops: EditOp[]): string[] {
  return ops.map((op) => {
    switch (op.op) {
      case "setTheme": return `Set theme to ${op.theme}`;
      case "setMeta": return `Updated the deck ${op.title !== undefined ? "title" : "subtitle"}`;
      case "setSlideText": return `Retitled a slide`;
      case "setChartType": return `Changed a chart to a ${op.chartType} chart`;
      case "updateChart": return `Updated a chart${op.patch.title ? ` ("${op.patch.title}")` : ""}`;
      case "setBullets": return `Rewrote a slide's bullets`;
      case "removeBlock": return `Removed an element`;
      case "addBlock": return `Added a ${op.block.type}`;
      case "removeSlide": return `Removed a slide`;
      case "addSlide": return `Added slide "${op.slide.title}"`;
      case "moveSlide": return `Reordered a slide`;
      default: return "Made a change";
    }
  });
}