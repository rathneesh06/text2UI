// bff/design-rag/caption.ts — turn a design screenshot into a structured note.
//
// captionDesign(png) asks a Gemini vision model for STRICT JSON describing the
// design's VISUAL structure (not its data), then tolerant-parses it into a
// DesignNote — the same parse idiom as parseReportDoc/parseDeckDoc. The note is
// a second retrieval signal AND injectable guidance for the build prompt.
//
// The model call is injected (like generateReport's `run`) so the parse logic is
// fully testable offline. The system prompt forbids transcribing any data/labels
// from the image — keeps the corpus free of copyable content and stray PII.

import { callGemini, type GenOptions, type ImagePart } from "../aiflow";

export interface DesignNote {
  domain: string;
  chartTypes: string[];
  layout: string;     // "kpi-row + 2x2 grid", "sidebar + table", ...
  density: string;    // "spacious" | "dense"
  whatsGood: string;  // one sentence
}

export const CAPTION_OPTS: GenOptions = { temperature: 0.2, thinkingBudget: 0 };

export const CAPTION_SYSTEM = [
  "You are a senior product designer analyzing a DATA DASHBOARD screenshot.",
  "Describe its VISUAL DESIGN only. NEVER transcribe data values, labels, names, or any text content from the image.",
  "Output ONLY a JSON object — no prose, no markdown fences — matching this shape:",
  '{"domain": string, "chartTypes": string[], "layout": string, "density": "spacious"|"dense", "whatsGood": string}',
  '- domain: the business domain the design appears built for (e.g. "sales","finance","logistics") or "generic".',
  '- chartTypes: the visual chart kinds present (e.g. "bar","line","donut","kpi-card","table","map").',
  '- layout: a terse structural pattern, e.g. "kpi-row + 2x2 grid" or "sidebar + table".',
  '- density: "spacious" or "dense".',
  "- whatsGood: ONE sentence on what makes the composition effective.",
].join("\n");

export type VisionRun = (system: string, user: string, image: ImagePart) => Promise<string>;

/** Default vision call: one multimodal Gemini turn returning raw text. */
async function defaultVisionRun(system: string, user: string, image: ImagePart): Promise<string> {
  const r = await callGemini(system, user, CAPTION_OPTS, [image]);
  return r.text;
}

/** Caption a PNG design into a DesignNote. `run` is injectable for tests. */
export async function captionDesign(
  png: Buffer,
  opts: { domainHint?: string } = {},
  run: VisionRun = defaultVisionRun,
): Promise<DesignNote> {
  const user = opts.domainHint
    ? `This dashboard was generated for the "${opts.domainHint}" domain. Caption it as the specified JSON.`
    : "Caption this dashboard design as the specified JSON.";
  const image: ImagePart = { mimeType: "image/png", dataB64: png.toString("base64") };
  const text = await run(CAPTION_SYSTEM, user, image);
  return parseDesignNote(text, opts.domainHint);
}

/** Tolerant parse of the model's JSON into a sanitized DesignNote. Lenient by
 *  design — a sloppy caption shouldn't fail ingest — but throws if there is no
 *  JSON object at all (a sign the call genuinely failed). */
export function parseDesignNote(text: string, domainHint?: string): DesignNote {
  const s = (text || "").replace(/```json|```/g, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < 0 || b < a) throw new Error("caption: no JSON object in model output");
  let obj: any;
  try { obj = JSON.parse(s.slice(a, b + 1)); }
  catch { throw new Error("caption: model output was not valid JSON"); }
  return {
    domain: typeof obj.domain === "string" && obj.domain.trim() ? obj.domain.trim() : (domainHint ?? "generic"),
    chartTypes: Array.isArray(obj.chartTypes)
      ? obj.chartTypes.map((c: any) => String(c)).filter((c: string) => c.trim().length > 0)
      : [],
    layout: typeof obj.layout === "string" ? obj.layout : "",
    density: obj.density === "dense" ? "dense" : "spacious",
    whatsGood: typeof obj.whatsGood === "string" ? obj.whatsGood : "",
  };
}

/** One-line, injectable rendering of a note for the build prompt (used by
 *  retrieval in a later increment). Kept here with the type it formats. */
export function formatDesignNote(n: DesignNote): string {
  const charts = n.chartTypes.length ? n.chartTypes.join(", ") : "—";
  return `domain: ${n.domain}; layout: ${n.layout || "—"}; charts: ${charts}; density: ${n.density}; note: ${n.whatsGood || "—"}`;
}
