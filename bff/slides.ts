// bff/slides.ts — Wave 4 / N2b: the PPT (slide deck) pipeline.
//
// Peer to the dashboard and PDF pipelines. The model returns a STRUCTURED deck
// (JSON), which we render deterministically to a .pptx with pptxgenjs (pure Node,
// no Chromium). Reuses the same domain enrichment, so a finance deck aims high.

import pptxgen from "pptxgenjs";
import type { Dataset, DeckDoc } from "../shared/types";
import { buildEnrichment, schemaSummary } from "./domain";
import { callGemini, type GenOptions } from "./aiflow";

export const DECK_OPTS: GenOptions = { temperature: 0.45, thinkingBudget: 0 };

export const DECK_SYSTEM = [
  "You are a management consultant building an executive slide deck from a dataset.",
  "Output ONLY a JSON object — no prose, no markdown fences — matching this shape:",
  '{"title": string, "subtitle"?: string,',
  ' "slides": [{"title": string, "bullets"?: [string], "notes"?: string,',
  '   "table"?: {"columns": [string], "rows": [[string]]}}]}',
  "Rules: 6-9 slides; slide 1 is the title/agenda; one idea per slide; bullets are short (max ~12 words);",
  "include at most one data table where it earns its place; add brief speaker notes;",
  "ground every number in the described data and NEVER invent columns.",
].join("\n");

/** Build the deck prompt — schema + domain prior + (optional) document context. */
export function assembleDeck(
  datasets: Dataset[],
  userPrompt: string,
  opts: { docContext?: string } = {},
): { system_prompt: string; user_prompt: string } {
  const { block } = buildEnrichment(datasets);
  const user_prompt = [
    "Dataset schema: " + schemaSummary(datasets),
    "",
    block, // shared domain priors + stat-reasoning guidance
    opts.docContext?.trim() ? "\nReference context from uploaded documents:\n" + opts.docContext.trim() : "",
    "",
    "User request: " + userPrompt,
    "Produce the deck as the specified JSON.",
  ].filter(Boolean).join("\n");
  return { system_prompt: DECK_SYSTEM, user_prompt };
}

/** Tolerant parse of the model's JSON into a sanitized DeckDoc. Throws if unusable. */
export function parseDeckDoc(text: string): DeckDoc {
  const s = (text || "").replace(/```json|```/g, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < 0 || b < a) throw new Error("deck: no JSON object in model output");
  let obj: any;
  try { obj = JSON.parse(s.slice(a, b + 1)); }
  catch { throw new Error("deck: model output was not valid JSON"); }
  if (typeof obj.title !== "string" || !Array.isArray(obj.slides)) {
    throw new Error("deck: JSON missing title/slides");
  }
  const slides = obj.slides
    .filter((x: any) => x && typeof x.title === "string")
    .map((x: any) => ({
      title: String(x.title),
      bullets: Array.isArray(x.bullets) ? x.bullets.map((b: any) => String(b)) : undefined,
      notes: typeof x.notes === "string" ? x.notes : undefined,
      table:
        x.table && Array.isArray(x.table.columns) && Array.isArray(x.table.rows)
          ? {
              columns: x.table.columns.map((c: any) => String(c)),
              rows: x.table.rows.map((r: any) => (Array.isArray(r) ? r.map((c: any) => String(c)) : [])),
            }
          : undefined,
    }));
  if (!slides.length) throw new Error("deck: no valid slides");
  return {
    title: String(obj.title),
    subtitle: typeof obj.subtitle === "string" ? obj.subtitle : undefined,
    slides,
  };
}

const ACCENT = "4F46E5";
const INK = "0F172A";
const MUTED = "64748B";
const BG = "FFFFFF";

/** Render a DeckDoc to a .pptx buffer. Basic, clean, single-accent styling (16:9). */
export async function renderDeckPptx(deck: DeckDoc): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
  pptx.layout = "WIDE";
  pptx.author = "text2UI";
  pptx.title = deck.title;

  // Title slide
  const title = pptx.addSlide();
  title.background = { color: BG };
  title.addShape(pptx.ShapeType.rect, { x: 0, y: 3.3, w: 1.2, h: 0.08, fill: { color: ACCENT } });
  title.addText(deck.title, { x: 0.7, y: 2.2, w: 12, h: 1.1, fontSize: 40, bold: true, color: INK });
  if (deck.subtitle) title.addText(deck.subtitle, { x: 0.7, y: 3.5, w: 12, h: 0.7, fontSize: 18, color: MUTED });

  // Content slides
  for (const slide of deck.slides) {
    const s = pptx.addSlide();
    s.background = { color: BG };
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: ACCENT } });
    s.addText(slide.title, { x: 0.7, y: 0.45, w: 12, h: 0.9, fontSize: 26, bold: true, color: INK });

    let y = 1.7;
    if (slide.bullets?.length) {
      s.addText(
        slide.bullets.map((t) => ({ text: t, options: { bullet: true, color: INK, fontSize: 18, paraSpaceAfter: 8 } })),
        { x: 0.9, y, w: 11.5, h: Math.min(4.6, slide.bullets.length * 0.55), valign: "top" },
      );
      y += Math.min(4.8, slide.bullets.length * 0.55) + 0.2;
    }
    if (slide.table && slide.table.columns.length) {
      const header = slide.table.columns.map((c) => ({ text: c, options: { bold: true, color: BG, fill: { color: ACCENT } } }));
      const rows = slide.table.rows.map((r) => slide.table!.columns.map((_, i) => ({ text: String(r[i] ?? ""), options: { color: INK } })));
      s.addTable([header, ...rows], { x: 0.9, y: Math.min(y, 4.5), w: 11.5, fontSize: 12, border: { type: "solid", color: "E2E8F0", pt: 1 }, autoPage: false });
    }
    if (slide.notes) s.addNotes(slide.notes);
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}

/** Full pipeline: prompt -> model (injected) -> parse -> render. */
export async function generateDeck(
  input: { datasets: Dataset[]; userPrompt: string; docContext?: string },
  run: (system: string, user: string) => Promise<string> = (s, u) => callGemini(s, u, DECK_OPTS).then((r) => r.text),
): Promise<{ doc: DeckDoc; pptx: Buffer }> {
  const { system_prompt, user_prompt } = assembleDeck(input.datasets, input.userPrompt, { docContext: input.docContext });
  const text = await run(system_prompt, user_prompt);
  const doc = parseDeckDoc(text);
  const pptx = await renderDeckPptx(doc);
  return { doc, pptx };
}
