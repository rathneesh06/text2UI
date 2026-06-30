// bff/deck/pptx.ts — the deterministic Deck Compiler. Pure rendering: a CompiledDeck
// (data already resolved) becomes a 16:9 .pptx via pptxgenjs. Slide roles map to
// layouts; chart blocks become NATIVE PowerPoint charts (editable in PowerPoint), not
// images. No LLM, no SQL, no invented values reach this layer.
import pptxgen from "pptxgenjs";
import type { CompiledDeck, CompiledSlide, CompiledBlock, ResolvedChart } from "../../shared/deck-spec";

const ACCENT = "4F46E5";
const ACCENT2 = "06B6D4";
const INK = "0F172A";
const MUTED = "64748B";
const LINE = "E2E8F0";
const BG = "FFFFFF";
const SERIES = [ACCENT, ACCENT2, "818CF8", "94A3B8", "A5B4FC", "C7D2FE"];

function chartData(c: ResolvedChart) {
  const labels = c.labels.map((l) => String(l));
  return c.series.map((s) => ({ name: s.name, labels, values: s.values }));
}

function addChart(pptx: pptxgen, s: pptxgen.Slide, c: ResolvedChart, x: number, y: number, w: number, h: number) {
  const data = chartData(c);
  const common = { x, y, w, h, chartColors: SERIES, showLegend: c.series.length > 1, legendPos: "b" as const,
    catAxisLabelColor: MUTED, valAxisLabelColor: MUTED, catAxisLabelFontSize: 10, valAxisLabelFontSize: 10 };
  if (c.chartType === "pie") {
    s.addChart(pptx.ChartType.pie, [{ name: data[0]?.name ?? "", labels: data[0]?.labels ?? [], values: data[0]?.values ?? [] }],
      { ...common, showLegend: true, showPercent: true });
  } else if (c.chartType === "bar") {
    s.addChart(pptx.ChartType.bar, data, { ...common, barDir: "col" });
  } else if (c.chartType === "area") {
    s.addChart(pptx.ChartType.area, data, common);
  } else {
    s.addChart(pptx.ChartType.line, data, { ...common, lineSmooth: false, lineDataSymbol: "none" });
  }
}

function header(pptx: pptxgen, s: pptxgen.Slide, slide: CompiledSlide) {
  s.background = { color: BG };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: ACCENT } });
  s.addText(slide.title, { x: 0.6, y: 0.36, w: 12.3, h: 0.7, fontSize: 24, bold: true, color: INK });
  if (slide.message) s.addText(slide.message, { x: 0.6, y: 1.06, w: 12.3, h: 0.45, fontSize: 13.5, color: MUTED, italic: true });
  s.addShape(pptx.ShapeType.line, { x: 0.6, y: slide.message ? 1.56 : 1.2, w: 12.3, h: 0, line: { color: LINE, width: 1 } });
}

function footer(pptx: pptxgen, s: pptxgen.Slide, idx: number, total: number, title: string) {
  s.addText(title, { x: 0.6, y: 7.12, w: 9, h: 0.3, fontSize: 9, color: MUTED });
  s.addText(`${idx} / ${total}`, { x: 11.6, y: 7.12, w: 1.3, h: 0.3, fontSize: 9, color: MUTED, align: "right" });
}

interface Cell { x: number; y: number; w: number; h: number; }
function gridCells(n: number, area: Cell, gap = 0.3): Cell[] {
  const cols = n <= 1 ? 1 : n === 2 ? 2 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const cw = (area.w - gap * (cols - 1)) / cols;
  const ch = (area.h - gap * (rows - 1)) / rows;
  const cells: Cell[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    cells.push({ x: area.x + c * (cw + gap), y: area.y + r * (ch + gap), w: cw, h: ch });
  }
  return cells;
}

function kpiStrip(pptx: pptxgen, s: pptxgen.Slide, kpis: { label: string; value: string }[], y: number) {
  const items = kpis.slice(0, 6);
  const gap = 0.25;
  const w = (12.3 - gap * (items.length - 1)) / items.length;
  items.forEach((k, i) => {
    const x = 0.6 + i * (w + gap);
    s.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 1.2, fill: { color: "F8FAFC" }, line: { color: LINE, width: 1 }, rectRadius: 0.07 });
    s.addShape(pptx.ShapeType.rect, { x, y, w: 0.07, h: 1.2, fill: { color: i % 2 ? ACCENT2 : ACCENT } });
    s.addText(k.label.toUpperCase(), { x: x + 0.2, y: y + 0.14, w: w - 0.32, h: 0.35, fontSize: 9, color: MUTED, bold: true });
    s.addText(k.value, { x: x + 0.2, y: y + 0.48, w: w - 0.32, h: 0.62, fontSize: 22, bold: true, color: INK });
  });
}

function visualCell(pptx: pptxgen, s: pptxgen.Slide, cb: CompiledBlock, cell: Cell) {
  const cap = (cb.block as any).title as string | undefined;
  let { x, y, w, h } = cell;
  if (cap) { s.addText(cap, { x, y, w, h: 0.3, fontSize: 12, bold: true, color: INK }); y += 0.34; h -= 0.34; }
  if (cb.chart) addChart(pptx, s, cb.chart, x, y, w, h);
  else if (cb.table) {
    const t = cb.table;
    const head = t.columns.map((c) => ({ text: c, options: { bold: true, color: BG, fill: { color: ACCENT } } }));
    const rows = t.rows.slice(0, 8).map((r) => r.map((c) => ({ text: String(c ?? ""), options: { color: INK } })));
    s.addTable([head, ...rows], { x, y, w, fontSize: 10, border: { type: "solid", color: LINE, pt: 1 }, autoPage: false });
  }
}

function renderSlide(pptx: pptxgen, slide: CompiledSlide, idx: number, total: number, deckTitle: string) {
  // Hero (title / section).
  if (slide.role === "title" || slide.role === "section") {
    const t = pptx.addSlide();
    const section = slide.role === "section";
    t.background = { color: section ? INK : BG };
    const ink = section ? BG : INK;
    t.addShape(pptx.ShapeType.rect, { x: 0.7, y: 3.2, w: 1.4, h: 0.09, fill: { color: ACCENT } });
    t.addText(slide.title, { x: 0.7, y: 2.0, w: 12, h: 1.2, fontSize: 42, bold: true, color: ink });
    if (slide.message) t.addText(slide.message, { x: 0.7, y: 3.5, w: 12, h: 0.8, fontSize: 18, color: section ? LINE : MUTED });
    if (slide.notes) t.addNotes(slide.notes);
    return;
  }

  const s = pptx.addSlide();
  header(pptx, s, slide);

  // Gather blocks by kind so a slide can hold a KPI strip PLUS a grid of charts/tables.
  const kpis = slide.blocks.filter((b) => b.kpis).flatMap((b) => b.kpis!);
  const visuals = slide.blocks.filter((b) => b.chart || b.table);
  const bulletsCB = slide.blocks.find((b) => b.block.type === "bullets");
  const calloutCB = slide.blocks.find((b) => b.block.type === "callout");

  let top = slide.message ? 1.75 : 1.4;
  const bottom = calloutCB ? 5.95 : 6.95;

  if (kpis.length) { kpiStrip(pptx, s, kpis, top); top += 1.45; }

  if (visuals.length === 1 && bulletsCB && bulletsCB.block.type === "bullets") {
    visualCell(pptx, s, visuals[0], { x: 0.6, y: top, w: 7.6, h: bottom - top });
    s.addText(bulletsCB.block.items.map((bt) => ({ text: bt, options: { bullet: true, color: INK, fontSize: 14, paraSpaceAfter: 9 } })),
      { x: 8.5, y: top, w: 4.4, h: bottom - top, valign: "top" });
  } else if (visuals.length) {
    const cells = gridCells(visuals.length, { x: 0.6, y: top, w: 12.3, h: bottom - top });
    visuals.forEach((cb, i) => visualCell(pptx, s, cb, cells[i]));
  } else if (bulletsCB && bulletsCB.block.type === "bullets") {
    s.addText(bulletsCB.block.items.map((bt) => ({ text: bt, options: { bullet: true, color: INK, fontSize: 18, paraSpaceAfter: 12 } })),
      { x: 0.8, y: top, w: 11.8, h: bottom - top, valign: "top" });
  }

  if (calloutCB && calloutCB.block.type === "callout") {
    const c = calloutCB.block;
    const fill = c.emphasis === "good" ? "ECFDF5" : c.emphasis === "warn" ? "FEF2F2" : "EEF2FF";
    s.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 6.05, w: 12.3, h: 0.85, fill: { color: fill }, line: { color: LINE, width: 1 }, rectRadius: 0.06 });
    s.addText(c.text, { x: 0.9, y: 6.05, w: 11.7, h: 0.85, fontSize: 14, color: INK, valign: "middle", bold: true });
  }

  if (slide.notes) s.addNotes(slide.notes);
  footer(pptx, s, idx, total, deckTitle);
}

export async function renderCompiledDeck(deck: CompiledDeck): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
  pptx.layout = "WIDE";
  pptx.author = "text2UI";
  pptx.title = deck.meta.title;

  // Ensure there is a title slide.
  if (!deck.slides.some((s) => s.role === "title")) {
    const t = pptx.addSlide();
    t.background = { color: BG };
    t.addShape(pptx.ShapeType.rect, { x: 0.7, y: 3.2, w: 1.2, h: 0.08, fill: { color: ACCENT } });
    t.addText(deck.meta.title, { x: 0.7, y: 2.1, w: 12, h: 1.1, fontSize: 40, bold: true, color: INK });
    if (deck.meta.subtitle) t.addText(deck.meta.subtitle, { x: 0.7, y: 3.45, w: 12, h: 0.7, fontSize: 18, color: MUTED });
  }

  deck.slides.forEach((slide, i) => renderSlide(pptx, slide, i + 1, deck.slides.length, deck.meta.title));

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}