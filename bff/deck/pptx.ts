// bff/deck/pptx.ts — the deterministic Deck Compiler. Pure rendering: a CompiledDeck
// (data already resolved) becomes a 16:9 .pptx via pptxgenjs. Slide roles map to
// layouts; chart blocks become NATIVE PowerPoint charts (editable in PowerPoint), not
// images. Honors meta.theme (light/dark) via a palette threaded through every helper.
import pptxgen from "pptxgenjs";
import type { CompiledDeck, CompiledSlide, CompiledBlock, ResolvedChart } from "../../shared/deck-spec";

interface Palette { BG: string; INK: string; MUTED: string; LINE: string; CARD: string; SECTION: string; ACCENT: string; ACCENT2: string; SERIES: string[]; }
function palette(theme?: "light" | "dark"): Palette {
  if (theme === "dark") return {
    BG: "0B1220", INK: "F1F5F9", MUTED: "94A3B8", LINE: "334155", CARD: "111C30", SECTION: "020617",
    ACCENT: "6366F1", ACCENT2: "22D3EE", SERIES: ["6366F1", "22D3EE", "818CF8", "A5B4FC", "C7D2FE", "67E8F9"],
  };
  return {
    BG: "FFFFFF", INK: "0F172A", MUTED: "64748B", LINE: "E2E8F0", CARD: "F8FAFC", SECTION: "0F172A",
    ACCENT: "4F46E5", ACCENT2: "06B6D4", SERIES: ["4F46E5", "06B6D4", "818CF8", "94A3B8", "A5B4FC", "C7D2FE"],
  };
}

function chartData(c: ResolvedChart) {
  const labels = c.labels.map((l) => String(l));
  return c.series.map((s) => ({ name: s.name, labels, values: s.values }));
}

function addChart(pptx: pptxgen, s: pptxgen.Slide, c: ResolvedChart, x: number, y: number, w: number, h: number, p: Palette) {
  const data = chartData(c);
  const common = { x, y, w, h, chartColors: p.SERIES, showLegend: c.series.length > 1, legendPos: "b" as const,
    legendColor: p.MUTED, catAxisLabelColor: p.MUTED, valAxisLabelColor: p.MUTED, catAxisLabelFontSize: 10, valAxisLabelFontSize: 10,
    valGridLine: { color: p.LINE, style: "solid" as const, size: 1 } };
  if (c.chartType === "pie") {
    s.addChart(pptx.ChartType.pie, [{ name: data[0]?.name ?? "", labels: data[0]?.labels ?? [], values: data[0]?.values ?? [] }],
      { ...common, showLegend: true, showPercent: true, dataLabelColor: p.BG });
  } else if (c.chartType === "bar") {
    s.addChart(pptx.ChartType.bar, data, { ...common, barDir: "col" });
  } else if (c.chartType === "area") {
    s.addChart(pptx.ChartType.area, data, common);
  } else {
    s.addChart(pptx.ChartType.line, data, { ...common, lineSmooth: false, lineDataSymbol: "none" });
  }
}

function header(pptx: pptxgen, s: pptxgen.Slide, slide: CompiledSlide, p: Palette) {
  s.background = { color: p.BG };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: p.ACCENT } });
  s.addText(slide.title, { x: 0.6, y: 0.36, w: 12.3, h: 0.7, fontSize: 24, bold: true, color: p.INK });
  if (slide.message) s.addText(slide.message, { x: 0.6, y: 1.06, w: 12.3, h: 0.45, fontSize: 13.5, color: p.MUTED, italic: true });
  s.addShape(pptx.ShapeType.line, { x: 0.6, y: slide.message ? 1.56 : 1.2, w: 12.3, h: 0, line: { color: p.LINE, width: 1 } });
}

function footer(pptx: pptxgen, s: pptxgen.Slide, idx: number, total: number, title: string, p: Palette) {
  s.addText(title, { x: 0.6, y: 7.12, w: 9, h: 0.3, fontSize: 9, color: p.MUTED });
  s.addText(`${idx} / ${total}`, { x: 11.6, y: 7.12, w: 1.3, h: 0.3, fontSize: 9, color: p.MUTED, align: "right" });
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

function kpiStrip(pptx: pptxgen, s: pptxgen.Slide, kpis: { label: string; value: string }[], y: number, p: Palette) {
  const items = kpis.slice(0, 6);
  const gap = 0.25;
  const w = (12.3 - gap * (items.length - 1)) / items.length;
  items.forEach((k, i) => {
    const x = 0.6 + i * (w + gap);
    s.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 1.2, fill: { color: p.CARD }, line: { color: p.LINE, width: 1 }, rectRadius: 0.07 });
    s.addShape(pptx.ShapeType.rect, { x, y, w: 0.07, h: 1.2, fill: { color: i % 2 ? p.ACCENT2 : p.ACCENT } });
    s.addText(k.label.toUpperCase(), { x: x + 0.2, y: y + 0.14, w: w - 0.32, h: 0.35, fontSize: 9, color: p.MUTED, bold: true });
    s.addText(k.value, { x: x + 0.2, y: y + 0.48, w: w - 0.32, h: 0.62, fontSize: 22, bold: true, color: p.INK });
  });
}

function visualCell(pptx: pptxgen, s: pptxgen.Slide, cb: CompiledBlock, cell: Cell, p: Palette) {
  const cap = (cb.block as any).title as string | undefined;
  let { x, y, w, h } = cell;
  if (cap) { s.addText(cap, { x, y, w, h: 0.3, fontSize: 12, bold: true, color: p.INK }); y += 0.34; h -= 0.34; }
  if (cb.chart) addChart(pptx, s, cb.chart, x, y, w, h, p);
  else if (cb.image) {
    const iw = cb.image.width ?? 4, ih = cb.image.height ?? 3;
    const scale = Math.min(w / iw, h / ih);
    const dw = iw * scale, dh = ih * scale;
    s.addImage({ data: cb.image.dataUrl, x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh });
  }
  else if (cb.table) {
    const t = cb.table;
    const head = t.columns.map((c) => ({ text: c, options: { bold: true, color: "FFFFFF", fill: { color: p.ACCENT } } }));
    const rows = t.rows.slice(0, 8).map((r) => r.map((c) => ({ text: String(c ?? ""), options: { color: p.INK } })));
    s.addTable([head, ...rows], { x, y, w, fontSize: 10, color: p.INK, border: { type: "solid", color: p.LINE, pt: 1 }, autoPage: false });
  }
}

function renderSlide(pptx: pptxgen, slide: CompiledSlide, idx: number, total: number, deckTitle: string, p: Palette) {
  // Hero (title / section).
  if (slide.role === "title" || slide.role === "section") {
    const t = pptx.addSlide();
    const section = slide.role === "section";
    t.background = { color: section ? p.SECTION : p.BG };
    const ink = section ? "FFFFFF" : p.INK;
    t.addShape(pptx.ShapeType.rect, { x: 0.7, y: 3.2, w: 1.4, h: 0.09, fill: { color: p.ACCENT } });
    t.addText(slide.title, { x: 0.7, y: 2.0, w: 12, h: 1.2, fontSize: 42, bold: true, color: ink });
    if (slide.message) t.addText(slide.message, { x: 0.7, y: 3.5, w: 12, h: 0.8, fontSize: 18, color: section ? "CBD5E1" : p.MUTED });
    const logo = slide.blocks.find((b) => b.image)?.image;
    if (logo) {
      const iw = logo.width ?? 4, ih = logo.height ?? 2, s2 = Math.min(3 / iw, 1.1 / ih);
      t.addImage({ data: logo.dataUrl, x: 0.7, y: 0.7, w: iw * s2, h: ih * s2 });
    }
    if (slide.notes) t.addNotes(slide.notes);
    return;
  }

  const s = pptx.addSlide();
  header(pptx, s, slide, p);

  const kpis = slide.blocks.filter((b) => b.kpis).flatMap((b) => b.kpis!);
  const visuals = slide.blocks.filter((b) => b.chart || b.table || b.image);
  const bulletsCB = slide.blocks.find((b) => b.block.type === "bullets");
  const calloutCB = slide.blocks.find((b) => b.block.type === "callout");

  let top = slide.message ? 1.75 : 1.4;
  const bottom = calloutCB ? 5.95 : 6.95;

  if (kpis.length) { kpiStrip(pptx, s, kpis, top, p); top += 1.45; }

  if (visuals.length === 1 && bulletsCB && bulletsCB.block.type === "bullets") {
    visualCell(pptx, s, visuals[0], { x: 0.6, y: top, w: 7.6, h: bottom - top }, p);
    s.addText(bulletsCB.block.items.map((bt) => ({ text: bt, options: { bullet: true, color: p.INK, fontSize: 14, paraSpaceAfter: 9 } })),
      { x: 8.5, y: top, w: 4.4, h: bottom - top, valign: "top" });
  } else if (visuals.length) {
    const cells = gridCells(visuals.length, { x: 0.6, y: top, w: 12.3, h: bottom - top });
    visuals.forEach((cb, i) => visualCell(pptx, s, cb, cells[i], p));
  } else if (bulletsCB && bulletsCB.block.type === "bullets") {
    s.addText(bulletsCB.block.items.map((bt) => ({ text: bt, options: { bullet: true, color: p.INK, fontSize: 18, paraSpaceAfter: 12 } })),
      { x: 0.8, y: top, w: 11.8, h: bottom - top, valign: "top" });
  }

  if (calloutCB && calloutCB.block.type === "callout") {
    const c = calloutCB.block;
    const fill = c.emphasis === "good" ? "ECFDF5" : c.emphasis === "warn" ? "FEF2F2" : "EEF2FF";
    const dark = p.BG === "0B1220";
    const cfill = dark ? p.CARD : fill;
    s.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 6.05, w: 12.3, h: 0.85, fill: { color: cfill }, line: { color: p.LINE, width: 1 }, rectRadius: 0.06 });
    s.addText(c.text, { x: 0.9, y: 6.05, w: 11.7, h: 0.85, fontSize: 14, color: p.INK, valign: "middle", bold: true });
  }

  if (slide.notes) s.addNotes(slide.notes);
  footer(pptx, s, idx, total, deckTitle, p);
}

export async function renderCompiledDeck(deck: CompiledDeck): Promise<Buffer> {
  const p = palette(deck.meta.theme);
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
  pptx.layout = "WIDE";
  pptx.author = "text2UI";
  pptx.title = deck.meta.title;

  if (!deck.slides.some((s) => s.role === "title")) {
    const t = pptx.addSlide();
    t.background = { color: p.BG };
    t.addShape(pptx.ShapeType.rect, { x: 0.7, y: 3.2, w: 1.4, h: 0.09, fill: { color: p.ACCENT } });
    t.addText(deck.meta.title, { x: 0.7, y: 2.0, w: 12, h: 1.2, fontSize: 42, bold: true, color: p.INK });
    if (deck.meta.subtitle) t.addText(deck.meta.subtitle, { x: 0.7, y: 3.5, w: 12, h: 0.8, fontSize: 18, color: p.MUTED });
  }

  deck.slides.forEach((slide, i) => renderSlide(pptx, slide, i + 1, deck.slides.length, deck.meta.title, p));

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}