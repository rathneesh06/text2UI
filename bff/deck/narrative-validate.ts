// bff/deck/narrative-validate.ts — the Narrative Validator. Deterministic checks on the
// OUTLINE before slides are built: every deck opens with a title, closes with a
// recommendation for decision-maker audiences, fits its slide budget, and doesn't run
// the same slide role three times in a row. Repairs what it safely can; warns otherwise.
import type { DeckSpec, OutlineNode, SlideRole, Audience } from "../../shared/deck-spec";

const DECISION_AUDIENCES: Audience[] = ["investor", "board", "executive"];
let counter = 0;
const nid = (role: string) => `${role}-${++counter}`;

export interface NarrativeResult { outline: OutlineNode[]; warnings: string[]; }

export function validateNarrative(meta: DeckSpec["meta"], outline: OutlineNode[], maxSlides = 20): NarrativeResult {
  const warnings: string[] = [];
  let nodes = outline.slice();

  // Opens with a title.
  if (!nodes.length || nodes[0].role !== "title") {
    nodes.unshift({ id: nid("title"), role: "title", keyMessage: meta.title });
    warnings.push("added a title slide (deck must open with one)");
  }

  // Decision-maker decks should end on a recommendation/next-steps slide.
  if (DECISION_AUDIENCES.includes(meta.audience) && !nodes.some((n) => n.role === "recommendation")) {
    nodes.push({ id: nid("recommendation"), role: "recommendation", keyMessage: "Recommendation & next steps", suggested: "bullets" });
    warnings.push(`added a recommendation slide (expected for a ${meta.audience} audience)`);
  }

  // Slide budget.
  const budget = meta.slideBudget;
  if (budget && Math.abs(nodes.length - budget) > 2) {
    warnings.push(`outline has ${nodes.length} slides vs a requested ~${budget}; the slide planner will rebalance`);
  }

  // Hard cap.
  if (nodes.length > maxSlides) {
    nodes = nodes.slice(0, maxSlides);
    warnings.push(`trimmed to ${maxSlides} slides (hard cap)`);
  }

  // No three identical roles in a row (sign of a flat narrative).
  let run = 1;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i].role === nodes[i - 1].role) { run++; if (run >= 3) warnings.push(`repeated "${nodes[i].role}" slides — consider varying the story`); }
    else run = 1;
  }

  return { outline: nodes, warnings };
}