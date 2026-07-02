// bff/deck/edit-planner.ts — turns a refinement instruction into TARGETED edit ops
// against the existing deck (by id), instead of re-planning the whole thing. This is what
// makes "make the revenue chart a pie" or "shorten slide 4's bullets" actually work on the
// element the user means. The model sees a compact, id-annotated view of the current deck
// and returns the smallest set of ops. Returns null on failure so the caller can fall back
// to a full replan.
import type { DeckSpec } from "../../shared/deck-spec";
import type { EditOp } from "./edit-ops";
import { callGemini, ORCHESTRATE_OPTS, type GenResult, type GenOptions } from "../aiflow";

export type Run = (system: string, user: string, opts?: GenOptions) => Promise<GenResult>;
const TIMEOUT = Number(process.env.DECK_EDIT_TIMEOUT_MS ?? 20000);

const OP = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["setTheme", "setMeta", "setSlideText", "setChartType", "updateChart", "setBullets", "removeBlock", "addBlock", "removeSlide", "addSlide", "moveSlide"] },
    theme: { type: "string", enum: ["light", "dark"] },
    title: { type: "string" }, subtitle: { type: "string" }, message: { type: "string" },
    slideId: { type: "string" }, blockId: { type: "string" },
    chartType: { type: "string", enum: ["line", "bar", "area", "pie"] },
    role: { type: "string", enum: ["kpi", "trend", "comparison", "breakdown", "table", "callout", "recommendation", "section"] },
    items: { type: "array", items: { type: "string" } },
    toIndex: { type: "integer" }, afterSlideId: { type: "string" },
  },
  required: ["op"],
};
export const EDIT_SCHEMA = { type: "object", properties: { ops: { type: "array", items: OP } }, required: ["ops"] };

const SYSTEM = `You edit an existing slide deck by emitting TARGETED operations, not by rewriting it. Output ONLY JSON: { ops: [...] }.

You are given a compact, id-annotated view of the current deck. Reference existing slide ids and block ids EXACTLY. Make the SMALLEST set of ops that satisfies the request; do not touch anything the user didn't ask about.

Ops:
- setTheme { theme }                              — light/dark
- setMeta { title?, subtitle? }                   — deck title/subtitle
- setSlideText { slideId, title?, message? }
- setChartType { slideId, blockId, chartType }    — line|bar|area|pie
- setBullets { slideId, blockId, items[] }
- removeBlock { slideId, blockId }
- removeSlide { slideId }
- moveSlide { slideId, toIndex }
- addSlide { afterSlideId? }  (a title is enough; the deck will fill visuals)

Examples: "make the revenue chart a pie" → setChartType on that chart's block; "drop the SLA slide" → removeSlide; "dark theme" → setTheme dark; "shorten slide 3 bullets" → setBullets.`;

function deckView(spec: DeckSpec): string {
  const slides = spec.slides.map((s, i) => {
    const blocks = s.blocks.map((b) => {
      const t = (b as any).title ? ` "${(b as any).title}"` : "";
      const ct = b.type === "chart" ? ` ${b.chartType}` : "";
      return `    [${b.id}] ${b.type}${ct}${t}`;
    }).join("\n");
    return `  #${i} slide "${s.id}" (${s.role}): ${s.title}\n${blocks}`;
  }).join("\n");
  return `Deck "${spec.meta.title}" theme=${spec.meta.theme ?? "light"}\n${slides}`;
}

const strip = (t: string) => t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

function coerce(raw: any): EditOp[] {
  if (!Array.isArray(raw?.ops)) return [];
  const out: EditOp[] = [];
  for (const o of raw.ops) {
    if (!o || typeof o.op !== "string") continue;
    switch (o.op) {
      case "setTheme": if (o.theme === "dark" || o.theme === "light") out.push({ op: "setTheme", theme: o.theme }); break;
      case "setMeta": out.push({ op: "setMeta", title: o.title, subtitle: o.subtitle }); break;
      case "setSlideText": if (o.slideId) out.push({ op: "setSlideText", slideId: o.slideId, title: o.title, message: o.message }); break;
      case "setChartType": if (o.slideId && o.blockId && o.chartType) out.push({ op: "setChartType", slideId: o.slideId, blockId: o.blockId, chartType: o.chartType }); break;
      case "setBullets": if (o.slideId && o.blockId && Array.isArray(o.items)) out.push({ op: "setBullets", slideId: o.slideId, blockId: o.blockId, items: o.items.map(String) }); break;
      case "removeBlock": if (o.slideId && o.blockId) out.push({ op: "removeBlock", slideId: o.slideId, blockId: o.blockId }); break;
      case "removeSlide": if (o.slideId) out.push({ op: "removeSlide", slideId: o.slideId }); break;
      case "moveSlide": if (o.slideId && typeof o.toIndex === "number") out.push({ op: "moveSlide", slideId: o.slideId, toIndex: o.toIndex }); break;
      case "addSlide": out.push({ op: "addSlide", slide: { id: "", role: (o.role || "breakdown"), title: o.title || "New slide", blocks: [] }, afterSlideId: o.afterSlideId }); break;
      default: break; // updateChart/addBlock need richer payloads — handled by full replan fallback
    }
  }
  return out;
}

export async function planEdits(spec: DeckSpec, userPrompt: string, context = "", run: Run = callGemini, timeoutMs = TIMEOUT): Promise<EditOp[] | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  const user = `${context ? context + "\n\n" : ""}CURRENT DECK:\n${deckView(spec)}\n\nEDIT REQUEST:\n${userPrompt}`;
  const attempt = async (useSchema: boolean) => {
    const opts = useSchema ? { ...ORCHESTRATE_OPTS, responseSchema: EDIT_SCHEMA } : { ...ORCHESTRATE_OPTS };
    const { text } = await run(SYSTEM, user, opts);
    return coerce(JSON.parse(strip(text)));
  };
  const call = (async () => {
    // Try structured output first; if the model rejects the schema (some models 400 on
    // response schemas), retry in plain-JSON mode — the SYSTEM prompt already demands JSON
    // and coerce() sanitizes it. This keeps targeted edits working instead of always
    // falling back to a full rebuild.
    try {
      const ops = await attempt(true);
      console.log(`[deck-edit] planned ${ops.length} op(s)`);
      return ops;
    } catch (e1) {
      console.warn(`[deck-edit] schema call failed (${(e1 as Error).message}) — retrying without schema`);
      try {
        const ops = await attempt(false);
        console.log(`[deck-edit] planned ${ops.length} op(s) (schemaless)`);
        return ops;
      } catch (e2) { console.warn(`[deck-edit] failed: ${(e2 as Error).message}`); return null; }
    }
  })();
  return Promise.race([call, timeout]);
}