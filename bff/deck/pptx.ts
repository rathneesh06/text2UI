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
  s.addText(slide.title, { x: 0.7, y: 0.4, w: 12, h: 0.8, fontSize: 24, bold: true, color: INK });
  if (slide.message) s.addText(slide.message, { x: 0.7, y: 1.15, w: 12, h: 0.5, fontSize: 14, color: MUTED, italic: true });
}

function renderSlide(pptx: pptxgen, slide: CompiledSlide) {
  // Title / section slides get the hero treatment.
  if (slide.role === "title" || slide.role === "section") {
    const t = pptx.addSlide();
    t.background = { color: slide.role === "section" ? INK : BG };
    const ink = slide.role === "section" ? BG : INK;
    t.addShape(pptx.ShapeType.rect, { x: 0.7, y: 3.2, w: 1.2, h: 0.08, fill: { color: ACCENT } });
    t.addText(slide.title, { x: 0.7, y: 2.1, w: 12, h: 1.1, fontSize: 40, bold: true, color: ink });
    if (slide.message) t.addText(slide.message, { x: 0.7, y: 3.45, w: 12, h: 0.7, fontSize: 18, color: slide.role === "section" ? LINE : MUTED });
    if (slide.notes) t.addNotes(slide.notes);
    return;
  }

  const s = pptx.addSlide();
  header(pptx, s, slide);
  let y = slide.message ? 1.8 : 1.5;

  // KPI strip
  const kpiBlock = slide.blocks.find((b) => b.block.type === "kpis" && b.kpis);
  if (kpiBlock?.kpis?.length) {
    const items = kpiBlock.kpis.slice(0, 4);
    const gap = 0.3;
    const w = (12 - gap * (items.length - 1)) / items.length;
    items.forEach((k, i) => {
      const x = 0.7 + i * (w + gap);
      s.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 1.4, fill: { color: "F8FAFC" }, line: { color: LINE, width: 1 }, rectRadius: 0.08 });
      s.addText(k.label.toUpperCase(), { x: x + 0.15, y: y + 0.15, w: w - 0.3, h: 0.4, fontSize: 10, color: MUTED, bold: true });
      s.addText(k.value, { x: x + 0.15, y: y + 0.5, w: w - 0.3, h: 0.7, fontSize: 26, bold: true, color: INK });
    });
    y += 1.7;
  }

  // Chart + bullets can sit side by side; otherwise chart full width.
  const chartCB = slide.blocks.find((b) => b.block.type === "chart" && b.chart);
  const bulletsCB = slide.blocks.find((b) => b.block.type === "bullets");
  const tableCB = slide.blocks.find((b) => b.block.type === "table" && b.table);
  const calloutCB = slide.blocks.find((b) => b.block.type === "callout");

  const remainingH = 7.0 - y;
  if (chartCB?.chart && bulletsCB && bulletsCB.block.type === "bullets") {
    addChart(pptx, s, chartCB.chart, 0.7, y, 7.2, remainingH);
    s.addText(
      bulletsCB.block.items.map((t) => ({ text: t, options: { bullet: true, color: INK, fontSize: 14, paraSpaceAfter: 8 } })),
      { x: 8.2, y, w: 4.4, h: remainingH, valign: "top" },
    );
  } else if (chartCB?.chart) {
    addChart(pptx, s, chartCB.chart, 0.7, y, 12, remainingH);
  } else if (tableCB?.table) {
    const t = tableCB.table;
    const head = t.columns.map((c) => ({ text: c, options: { bold: true, color: BG, fill: { color: ACCENT } } }));
    const rows = t.rows.map((r) => r.map((c) => ({ text: String(c ?? ""), options: { color: INK } })));
    s.addTable([head, ...rows], { x: 0.7, y, w: 12, fontSize: 11, border: { type: "solid", color: LINE, pt: 1 }, autoPage: false });
  } else if (bulletsCB && bulletsCB.block.type === "bullets") {
    s.addText(
      bulletsCB.block.items.map((t) => ({ text: t, options: { bullet: true, color: INK, fontSize: 18, paraSpaceAfter: 10 } })),
      { x: 0.9, y, w: 11.5, h: remainingH, valign: "top" },
    );
  }

  if (calloutCB && calloutCB.block.type === "callout") {
    const c = calloutCB.block;
    const fill = c.emphasis === "good" ? "ECFDF5" : c.emphasis === "warn" ? "FEF2F2" : "EEF2FF";
    s.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: 6.0, w: 12, h: 0.9, fill: { color: fill }, line: { color: LINE, width: 1 }, rectRadius: 0.06 });
    s.addText(c.text, { x: 1.0, y: 6.0, w: 11.4, h: 0.9, fontSize: 15, color: INK, valign: "middle", bold: true });
  }

  if (slide.notes) s.addNotes(slide.notes);
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

  for (const slide of deck.slides) renderSlide(pptx, slide);

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}