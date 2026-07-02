// bff/deck/outline-planner.ts — STAGE 1 of the two-stage planner. Decides the STORY:
// audience, goal, slide budget, and an ordered list of slide intents (roles + key
// messages). It never writes slide content — that's stage 2. On an edit turn it receives
// the current deck and returns a minimally-changed outline. Returns null on failure.
import type { Dataset } from "../../shared/types";
import type { DeckSpec, OutlineNode, DeckMeta } from "../../shared/deck-spec";
import { callGemini, ORCHESTRATE_OPTS, type GenResult, type GenOptions } from "../aiflow";
import { evidenceText, type EvidenceCatalog } from "./facts";

export type Run = (system: string, user: string, opts?: GenOptions) => Promise<GenResult>;
const TIMEOUT = Number(process.env.DECK_PLANNER_TIMEOUT_MS ?? 20000);
const ROLES = ["title", "agenda", "kpi", "trend", "comparison", "breakdown", "table", "callout", "recommendation", "section", "appendix"];

export const OUTLINE_SCHEMA = {
  type: "object",
  properties: {
    meta: {
      type: "object",
      properties: {
        title: { type: "string" }, subtitle: { type: "string" },
        audience: { type: "string", enum: ["investor", "board", "executive", "sales", "technical", "academic", "general"] },
        goal: { type: "string" }, tone: { type: "string", enum: ["formal", "confident", "neutral", "energetic"] },
        theme: { type: "string", enum: ["light", "dark"] },
        slideBudget: { type: "integer" },
      },
      required: ["title", "audience"],
    },
    outline: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          role: { type: "string", enum: ROLES },
          keyMessage: { type: "string" },
          suggested: { type: "string", enum: ["chart", "table", "bullets", "kpis", "text"] },
        },
        required: ["id", "role", "keyMessage"],
      },
    },
  },
  required: ["meta", "outline"],
};

const SYSTEM = `You are the OUTLINE planner for a presentation generator. You decide the story, not the slide content. Output ONLY JSON: { meta, outline[] } and nothing else.

- Read the evidence and the user's request. Infer audience and goal.
- Produce an ordered outline of slide intents. Each node has a role and a one-line keyMessage.
- Roles: title, agenda, kpi, trend (over time), comparison, breakdown (by category), table, callout, recommendation, section (divider), appendix.
- Open with a title. For investor/board/executive audiences, end with a recommendation.
- Aim for 10-14 slides. Include an overview/scorecard early, then several trend/breakdown/comparison slides and at least one table.
- Set meta.theme to "dark" if the user asks for a dark/dark-themed/dark-mode deck, otherwise "light".
- Respect the requested slide count if given.
- Ground every intent in the evidence; do not promise slides the data can't support.

On an EDIT turn you receive the CURRENT deck — return the full updated outline, changing as little as possible.`;

function buildUser(datasets: Dataset[], evidence: EvidenceCatalog, userPrompt: string, current?: DeckSpec, context?: string): string {
  const parts = context ? [context, ""] : [];
  parts.push("EVIDENCE:", evidenceText(evidence), "");
  if (current) { parts.push("CURRENT DECK (edit — keep ids/order where possible):", JSON.stringify({ meta: current.meta, outline: current.outline }), "", "USER EDIT:"); }
  else parts.push("USER REQUEST:");
  parts.push(userPrompt);
  return parts.join("\n");
}

const strip = (t: string) => t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

export interface OutlineInput { datasets: Dataset[]; evidence: EvidenceCatalog; userPrompt: string; currentSpec?: DeckSpec; context?: string; }

export async function planOutline(input: OutlineInput, run: Run = callGemini, timeoutMs = TIMEOUT): Promise<{ meta: DeckMeta; outline: OutlineNode[] } | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  const call = (async () => {
    try {
      const { text } = await run(SYSTEM, buildUser(input.datasets, input.evidence, input.userPrompt, input.currentSpec, input.context), { ...ORCHESTRATE_OPTS, responseSchema: OUTLINE_SCHEMA });
      const o = JSON.parse(strip(text));
      if (!o?.meta?.title || !Array.isArray(o.outline) || !o.outline.length) return null;
      const meta: DeckMeta = { title: String(o.meta.title), subtitle: o.meta.subtitle, audience: o.meta.audience ?? "general", goal: o.meta.goal, tone: o.meta.tone, theme: o.meta.theme === "dark" ? "dark" : o.meta.theme === "light" ? "light" : undefined, slideBudget: o.meta.slideBudget };
      const outline: OutlineNode[] = o.outline
        .filter((n: any) => n && n.role && n.keyMessage)
        .map((n: any, i: number) => ({ id: String(n.id ?? `${n.role}-${i}`), role: ROLES.includes(n.role) ? n.role : "callout", keyMessage: String(n.keyMessage), suggested: n.suggested }));
      console.log(`[deck-outline] "${meta.title}" (${meta.audience}) — ${outline.length} slide intents`);
      return { meta, outline };
    } catch (e) { console.warn(`[deck-outline] failed: ${(e as Error).message}`); return null; }
  })();
  return Promise.race([call, timeout]);
}