// bff/report.ts — Wave 4 / N2b: the PDF report pipeline.
//
// A peer pipeline to the dashboard generator: assemble a report prompt (reusing
// the same domain enrichment), have the model return a STRUCTURED report (JSON),
// then render it deterministically to a PDF with pdfkit (pure Node, no Chromium).
// The model produces content; we own the layout.

import PDFDocument from "pdfkit";
import type { Dataset, ReportDoc } from "../shared/types";
import { buildEnrichment, schemaSummary } from "./domain";
import { callGemini, type GenOptions } from "./aiflow";

export const REPORT_OPTS: GenOptions = { temperature: 0.4, thinkingBudget: 0 };

export const REPORT_SYSTEM = [
  "You are a senior data analyst producing a concise, executive-ready REPORT from a dataset.",
  "Output ONLY a JSON object — no prose, no markdown fences — matching this shape:",
  '{"title": string, "subtitle"?: string, "kpis"?: [{"label": string, "value": string}],',
  ' "sections": [{"heading": string, "body"?: string, "bullets"?: [string],',
  '   "table"?: {"columns": [string], "rows": [[string]]}}]}',
  "Rules: 4-6 sections; lead with the headline finding; put 3-5 KPIs if the data supports them;",
  "ground every number in the described data and NEVER invent columns; keep prose tight.",
].join("\n");

/** Build the report prompt — schema + domain prior + (optional) document context. */
export function assembleReport(
  datasets: Dataset[],
  userPrompt: string,
  opts: { docContext?: string } = {},
): { system_prompt: string; user_prompt: string } {
  const { block } = buildEnrichment(datasets);
  const user_prompt = [
    "Dataset schema: " + schemaSummary(datasets),
    "",
    block, // domain priors + stat-reasoning guidance (shared with the dashboard pipeline)
    opts.docContext?.trim() ? "\nReference context from uploaded documents:\n" + opts.docContext.trim() : "",
    "",
    "User request: " + userPrompt,
    "Produce the report as the specified JSON.",
  ].filter(Boolean).join("\n");
  return { system_prompt: REPORT_SYSTEM, user_prompt };
}

/** Tolerant parse of the model's JSON into a sanitized ReportDoc. Throws if unusable. */
export function parseReportDoc(text: string): ReportDoc {
  const s = (text || "").replace(/```json|```/g, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < 0 || b < a) throw new Error("report: no JSON object in model output");
  let obj: any;
  try { obj = JSON.parse(s.slice(a, b + 1)); }
  catch { throw new Error("report: model output was not valid JSON"); }
  if (typeof obj.title !== "string" || !Array.isArray(obj.sections)) {
    throw new Error("report: JSON missing title/sections");
  }
  const sections = obj.sections
    .filter((x: any) => x && typeof x.heading === "string")
    .map((x: any) => ({
      heading: String(x.heading),
      body: typeof x.body === "string" ? x.body : undefined,
      bullets: Array.isArray(x.bullets) ? x.bullets.map((b: any) => String(b)) : undefined,
      table:
        x.table && Array.isArray(x.table.columns) && Array.isArray(x.table.rows)
          ? {
              columns: x.table.columns.map((c: any) => String(c)),
              rows: x.table.rows.map((r: any) => (Array.isArray(r) ? r.map((c: any) => String(c)) : [])),
            }
          : undefined,
    }));
  if (!sections.length) throw new Error("report: no valid sections");
  const kpis = Array.isArray(obj.kpis)
    ? obj.kpis
        .filter((k: any) => k && k.label != null && k.value != null)
        .map((k: any) => ({ label: String(k.label), value: String(k.value) }))
    : undefined;
  return {
    title: String(obj.title),
    subtitle: typeof obj.subtitle === "string" ? obj.subtitle : undefined,
    kpis: kpis && kpis.length ? kpis : undefined,
    sections,
  };
}

const ACCENT = "#4f46e5";
const INK = "#0f172a";
const MUTED = "#64748b";

/** Render a ReportDoc to a PDF buffer. Basic, clean, single-accent styling. */
export function renderReportPdf(doc: ReportDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: 54, info: { Title: doc.title } });
    const chunks: Buffer[] = [];
    pdf.on("data", (c) => chunks.push(c as Buffer));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const left = pdf.page.margins.left;
    const width = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;

    // Title block
    pdf.fillColor(ACCENT).rect(left, pdf.y, 36, 4).fill();
    pdf.moveDown(0.6);
    pdf.fillColor(INK).font("Helvetica-Bold").fontSize(22).text(doc.title, { width });
    if (doc.subtitle) pdf.moveDown(0.2).fillColor(MUTED).font("Helvetica").fontSize(12).text(doc.subtitle, { width });
    pdf.moveDown(0.8);

    // KPI row
    if (doc.kpis?.length) {
      const n = Math.min(doc.kpis.length, 4);
      const gap = 12;
      const boxW = (width - gap * (n - 1)) / n;
      const top = pdf.y;
      const boxH = 56;
      doc.kpis.slice(0, n).forEach((k, i) => {
        const x = left + i * (boxW + gap);
        pdf.roundedRect(x, top, boxW, boxH, 6).fillAndStroke("#f8fafc", "#e2e8f0");
        pdf.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(k.value, x + 10, top + 10, { width: boxW - 20, ellipsis: true });
        pdf.fillColor(MUTED).font("Helvetica").fontSize(8).text(k.label.toUpperCase(), x + 10, top + 34, { width: boxW - 20, ellipsis: true });
      });
      pdf.y = top + boxH + 18;
      pdf.x = left;
    }

    // Sections
    for (const sec of doc.sections) {
      ensureSpace(pdf, 60);
      pdf.fillColor(ACCENT).font("Helvetica-Bold").fontSize(13).text(sec.heading, left, pdf.y, { width });
      pdf.moveDown(0.3);
      if (sec.body) pdf.fillColor(INK).font("Helvetica").fontSize(10.5).text(sec.body, { width, align: "left" }).moveDown(0.3);
      if (sec.bullets?.length) {
        for (const b of sec.bullets) {
          pdf.fillColor(INK).font("Helvetica").fontSize(10.5).text("•  " + b, left + 8, pdf.y, { width: width - 8 });
        }
        pdf.moveDown(0.3);
      }
      if (sec.table) drawTable(pdf, sec.table, left, width);
      pdf.moveDown(0.8);
    }

    pdf.end();
  });
}

function ensureSpace(pdf: PDFKit.PDFDocument, needed: number): void {
  if (pdf.y + needed > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
}

/** Monospace table so columns align without manual width math; flows + paginates. */
function drawTable(pdf: PDFKit.PDFDocument, table: { columns: string[]; rows: string[][] }, left: number, width: number): void {
  const cols = table.columns.length || 1;
  const cellChars = Math.max(6, Math.floor((width / cols) / 5)); // ~5pt per Courier char at 9pt
  const fmt = (cells: string[]) =>
    table.columns.map((_, i) => pad(String(cells[i] ?? ""), cellChars)).join(" ");
  ensureSpace(pdf, 24);
  pdf.font("Courier-Bold").fontSize(9).fillColor(INK).text(fmt(table.columns), left, pdf.y, { width });
  pdf.font("Courier").fontSize(9).fillColor(INK);
  for (const r of table.rows) {
    ensureSpace(pdf, 14);
    pdf.text(fmt(r), left, pdf.y, { width });
  }
}
function pad(s: string, n: number): string {
  const t = s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
  return t.padEnd(n, " ");
}

/** Full pipeline: prompt -> model (injected) -> parse -> render. */
export async function generateReport(
  input: { datasets: Dataset[]; userPrompt: string; docContext?: string },
  run: (system: string, user: string) => Promise<string> = (s, u) => callGemini(s, u, REPORT_OPTS).then((r) => r.text),
): Promise<{ doc: ReportDoc; pdf: Buffer }> {
  const { system_prompt, user_prompt } = assembleReport(input.datasets, input.userPrompt, { docContext: input.docContext });
  const text = await run(system_prompt, user_prompt);
  const doc = parseReportDoc(text);
  const pdf = await renderReportPdf(doc);
  return { doc, pdf };
}
