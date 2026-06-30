// bff/deck/handler.ts — the spec-driven PPT endpoint. Runs the full pipeline the design
// doc prescribes: extract facts → plan outline → validate narrative → plan slides →
// validate content → compile (resolve real data) → render .pptx. Returns the editable
// DeckSpec alongside the artifact, so each turn edits the same deck. Deps are injectable
// so the whole thing is unit-testable without a server or live model.
import type { Dataset } from "../../shared/types";
import type { DeckSpec } from "../../shared/deck-spec";
import { extractFacts, type QueryFn } from "./facts";
import { planOutline } from "./outline-planner";
import { planSlides } from "./slide-planner";
import { validateNarrative } from "./narrative-validate";
import { validateContent } from "./content-validate";
import { compileDeck } from "./compile";
import { renderCompiledDeck } from "./pptx";

export interface DeckBuildDeps {
  query?: QueryFn;
  planOutlineFn?: typeof planOutline;
  planSlidesFn?: typeof planSlides;
}

const slug = (s: string) => (s || "deck").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "deck";

export async function handleDeckBuild(body: unknown, deps: DeckBuildDeps = {}): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  if (!Array.isArray(b.datasets) || !b.datasets.length) return { status: 400, body: { error: "datasets[] is required" } };
  if (typeof b.userPrompt !== "string" || !b.userPrompt.trim()) return { status: 400, body: { error: "userPrompt is required" } };

  const datasets = b.datasets as Dataset[];
  const currentSpec = b.currentSpec as DeckSpec | undefined;
  const planOutlineFn = deps.planOutlineFn ?? planOutline;
  const planSlidesFn = deps.planSlidesFn ?? planSlides;

  // 1) evidence
  const evidence = await extractFacts(datasets, deps.query);

  // 2) outline (story) + 3) narrative validation
  const outlineRes = await planOutlineFn({ datasets, evidence, userPrompt: b.userPrompt, currentSpec });
  if (!outlineRes) return { status: 502, body: { error: "outline planner could not produce a story" } };
  const { outline, warnings: nWarn } = validateNarrative(outlineRes.meta, outlineRes.outline, currentSpec?.constraints?.maxSlides ?? 20);

  // 4) slides (content) + 5) content/density validation
  const slidesRes = await planSlidesFn({ datasets, evidence, outline, meta: outlineRes.meta, userPrompt: b.userPrompt, currentSpec });
  if (!slidesRes) return { status: 502, body: { error: "slide planner could not expand the outline" } };
  const { slides, warnings: cWarn } = validateContent(slidesRes, datasets, {
    maxBullets: currentSpec?.constraints?.maxBulletsPerSlide,
    maxBulletWords: currentSpec?.constraints?.maxBulletWords,
  });

  // 6) canonical spec
  const spec: DeckSpec = { version: 1, meta: outlineRes.meta, outline, slides, constraints: currentSpec?.constraints };

  // 7) compile (resolve real data) + 8) render
  const compiled = await compileDeck(spec, datasets, deps.query);
  if (!compiled.slides.length) return { status: 422, body: { error: "deck had no valid slides after validation", warnings: [...nWarn, ...cWarn, ...compiled.warnings] } };
  const pptx = await renderCompiledDeck(compiled);

  return {
    status: 200,
    body: {
      spec,
      filename: slug(spec.meta.title) + ".pptx",
      pptxBase64: pptx.toString("base64"),
      warnings: [...nWarn, ...cWarn, ...compiled.warnings],
    },
  };
}