// bff/deck/handler.ts — spec-driven PPT endpoints.
//   handleDeckBuild: facts → outline → validate → slides → validate → visual-planner →
//     assign ids → compile → render. Stores v1 in the Spec Store, returns a deckId.
//   handleDeckEdit: loads the current spec by deckId, turns the instruction into TARGETED
//     edit ops (fall back to a full replan), applies them, recompiles/renders, commits a
//     new version. This is what makes fine-grained "change the revenue chart" edits work.
import type { Dataset } from "../../shared/types";
import type { DeckSpec } from "../../shared/deck-spec";
import { extractFacts, type QueryFn } from "./facts";
import { planOutline } from "./outline-planner";
import { planSlides } from "./slide-planner";
import { validateNarrative } from "./narrative-validate";
import { validateContent } from "./content-validate";
import { ensureVisuals } from "./visual-fallback";
import { getCatalog } from "./catalog-store";
import { compileDeck, type AssetResolver } from "./compile";
import { renderCompiledDeck } from "./pptx";
import type { Asset } from "../../shared/ingest";
import { assignIds, applyEdit, describeOps, type EditOp } from "./edit-ops";
import { planEdits } from "./edit-planner";
import { createDeck, currentSpec, commit } from "./spec-store";
import { recordTurn, updateSummary, sessionContextText } from "./session-store";

export interface DeckBuildDeps {
  query?: QueryFn;
  planOutlineFn?: typeof planOutline;
  planSlidesFn?: typeof planSlides;
  planEditsFn?: typeof planEdits;
  resolveAsset?: AssetResolver;   // resolve ImageBlock.assetId → embeddable data URL
  assets?: Asset[];               // images uploaded this turn (for deterministic logo placement)
}

const slug = (s: string) => (s || "deck").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "deck";
const themeFromPrompt = (p: string): "light" | "dark" | undefined => {
  const s = p.toLowerCase();
  return /\bdark\b/.test(s) ? "dark" : /\blight\b/.test(s) ? "light" : undefined;
};

/** Plan a full DeckSpec (no compile/render). Shared by build and the replan fallback. */
async function buildSpec(datasets: Dataset[], userPrompt: string, deps: DeckBuildDeps, currentSpec?: DeckSpec, context?: string): Promise<{ spec: DeckSpec; warnings: string[] } | null> {
  const planOutlineFn = deps.planOutlineFn ?? planOutline;
  const planSlidesFn = deps.planSlidesFn ?? planSlides;
  const evidence = await extractFacts(datasets, deps.query);
  const catalog = getCatalog(datasets);   // Semantic Modeling Service → governed vocabulary

  const outlineRes = await planOutlineFn({ datasets, evidence, userPrompt, currentSpec, context });
  if (!outlineRes) return null;
  const { outline, warnings: nWarn } = validateNarrative(outlineRes.meta, outlineRes.outline, currentSpec?.constraints?.maxSlides ?? 20);

  const slidesRes = await planSlidesFn({ datasets, evidence, catalog, outline, meta: outlineRes.meta, userPrompt, currentSpec, context });
  if (!slidesRes) return null;
  const { slides, warnings: cWarn } = validateContent(slidesRes, datasets, {
    maxBullets: currentSpec?.constraints?.maxBulletsPerSlide, maxBulletWords: currentSpec?.constraints?.maxBulletWords,
  });
  const { slides: finalSlides } = ensureVisuals(slides, datasets, catalog);

  const wantsTheme = themeFromPrompt(userPrompt);
  const theme: "light" | "dark" = wantsTheme ?? outlineRes.meta.theme ?? currentSpec?.meta.theme ?? "light";
  const spec: DeckSpec = { version: 1, meta: { ...outlineRes.meta, theme }, outline, slides: finalSlides, constraints: currentSpec?.constraints };
  return { spec, warnings: [...nWarn, ...cWarn] };
}

async function compileAndRender(spec: DeckSpec, datasets: Dataset[], query?: QueryFn, resolveAsset?: AssetResolver) {
  const compiled = await compileDeck(spec, datasets, query, resolveAsset);
  const pptx = await renderCompiledDeck(compiled);
  return { compiled, pptxBase64: pptx.toString("base64"), filename: slug(spec.meta.title) + ".pptx" };
}

/** Deterministically place the first uploaded image as a logo on the title slide. */
function attachLogo(spec: DeckSpec, assets?: Asset[]): DeckSpec {
  const img = assets?.find((a) => a.kind === "image");
  if (!img) return spec;
  const ti = spec.slides.findIndex((s) => s.role === "title");
  if (ti < 0 || spec.slides[ti].blocks.some((b) => b.type === "image")) return spec;
  const slides = spec.slides.map((s, i) => i === ti ? { ...s, blocks: [...s.blocks, { type: "image" as const, assetId: img.id, caption: img.name }] } : s);
  return { ...spec, slides };
}

function validate(body: any): { status: number; body: any } | null {
  if (!body || typeof body !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  if (!Array.isArray(body.datasets) || !body.datasets.length) return { status: 400, body: { error: "datasets[] is required" } };
  if (typeof body.userPrompt !== "string" || !body.userPrompt.trim()) return { status: 400, body: { error: "userPrompt is required" } };
  return null;
}

export async function handleDeckBuild(body: unknown, deps: DeckBuildDeps = {}): Promise<{ status: number; body: any }> {
  const bad = validate(body); if (bad) return bad;
  const b = body as any;
  const datasets = b.datasets as Dataset[];

  const planned = await buildSpec(datasets, b.userPrompt, deps, b.currentSpec);
  if (!planned) return { status: 502, body: { error: "planner could not produce a deck" } };

  const spec = assignIds(attachLogo(planned.spec, deps.assets));
  const { compiled, pptxBase64, filename } = await compileAndRender(spec, datasets, deps.query, deps.resolveAsset);
  if (!compiled.slides.length) return { status: 422, body: { error: "deck had no valid slides", warnings: [...planned.warnings, ...compiled.warnings] } };

  const { deckId, version } = createDeck(spec, "Initial deck");
  recordTurn(deckId, "user", b.userPrompt);
  updateSummary(deckId, spec, `Created "${spec.meta.title}"`);
  recordTurn(deckId, "assistant", spec.meta.title);
  return { status: 200, body: { deckId, version, spec, compiled, filename, pptxBase64, warnings: [...planned.warnings, ...compiled.warnings] } };
}

export async function handleDeckEdit(body: unknown, deps: DeckBuildDeps = {}): Promise<{ status: number; body: any }> {
  const bad = validate(body); if (bad) return bad;
  const b = body as any;
  const datasets = b.datasets as Dataset[];
  const planEditsFn = deps.planEditsFn ?? planEdits;

  // Source of truth: the stored spec; fall back to a client-sent spec if the store missed
  // (e.g. server restarted), else there's nothing to edit → do a fresh build.
  let base: DeckSpec | undefined = (b.deckId && currentSpec(b.deckId)) || (b.currentSpec as DeckSpec | undefined);
  if (!base) return handleDeckBuild(body, deps);

  const context = sessionContextText(b.deckId);   // rolling summary + recent turns
  if (b.deckId) recordTurn(b.deckId, "user", b.userPrompt);

  const themeOps: EditOp[] = [];
  const wantsTheme = themeFromPrompt(b.userPrompt);
  if (wantsTheme && base.meta.theme !== wantsTheme) themeOps.push({ op: "setTheme", theme: wantsTheme });

  const ops = (await planEditsFn(base, b.userPrompt, context)) ?? [];
  const all = [...themeOps, ...ops];

  let next: DeckSpec;
  let warnings: string[];
  let summary: string[];
  if (all.length) {
    const r = applyEdit(base, all);
    // Newly added slides come in empty — synthesize visuals for them from the catalog so
    // "add a slide about X" yields a real chart, not just a heading. Only NEW slides are
    // touched, so a user's "remove the chart" on an existing slide isn't undone.
    const baseIds = new Set(base.slides.map((s) => s.id));
    const addedIds = r.spec.slides.filter((s) => !baseIds.has(s.id)).map((s) => s.id);
    if (addedIds.length) {
      const cat = getCatalog(datasets);
      const filled = ensureVisuals(r.spec.slides.filter((s) => addedIds.includes(s.id)), datasets, cat).slides;
      const byId = new Map(filled.map((s) => [s.id, s]));
      r.spec = { ...r.spec, slides: r.spec.slides.map((s) => byId.get(s.id) ?? s) };
    }
    next = assignIds(r.spec);
    warnings = r.warnings;
    summary = describeOps(all);
  } else {
    // Couldn't turn it into targeted ops → full replan, keeping the deck identity + context.
    const planned = await buildSpec(datasets, b.userPrompt, deps, base, context);
    if (!planned) return { status: 502, body: { error: "could not apply that edit" } };
    next = assignIds(planned.spec);
    warnings = planned.warnings;
    summary = ["Rebuilt the deck from your request"];
  }

  const { compiled, pptxBase64, filename } = await compileAndRender(next, datasets, deps.query, deps.resolveAsset);
  if (!compiled.slides.length) return { status: 422, body: { error: "edit produced an empty deck", warnings } };

  // Commit a new version under the same deckId (or adopt the deck if the store had missed).
  const committed = b.deckId ? commit(b.deckId, next, summary.join("; ")) : null;
  const deckId = committed ? b.deckId : createDeck(next, "Adopted deck").deckId;
  const version = committed ? committed.version : 1;

  updateSummary(deckId, next, summary.join("; "));
  recordTurn(deckId, "assistant", summary.join("; "));

  return { status: 200, body: { deckId, version, spec: next, compiled, filename, pptxBase64, warnings, summary } };
}