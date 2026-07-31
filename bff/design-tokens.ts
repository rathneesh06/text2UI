// bff/design-tokens.ts — the visual contract for generated dashboards.
//
// WHY THIS EXISTS ALONGSIDE THE REFERENCE IMAGES
// A reference image teaches composition, density and feel. It does not reliably
// transmit `#F97316`, an 11px uppercase label with 0.05em tracking, or a 40x40
// icon chip at 12% tint — the model approximates what it sees, and approximations
// diverge. Ten dashboards built from the same image still drift.
//
// So the images carry the LAYOUT and this block carries the VALUES. Between them
// there is very little left for the model to invent, which is the point: the
// model should be choosing which metrics matter, not what colour a label is.
//
// Extracted from the curated reference set. Two families, because the corpus
// genuinely contains two and blending them is what makes output look unresolved.
// Pick one per build — never mix.

// "auto" means: the attached reference images carry the palette and typography,
// so this block contributes STRUCTURE ONLY. Use it whenever the curated set spans
// more than one visual family — pinning a palette here while showing the model
// five different ones makes the two fight, and the model resolves the argument by
// blending, which is the one outcome nobody wants.
export type DesignFamily = "editorial" | "modern" | "auto";

const LAYOUT = `
LAYOUT GRAMMAR — follow this order, every dashboard:
1. Header: title (largest text on the page) + one-line subtitle, left. Filter
   controls right, each an UPPERCASE label prefix ("PRIORITY:") beside its select.
2. Insight banner: full width, directly beneath the header. Icon in a rounded
   square, bold headline, one sentence of body. Optional action button, right.
3. KPI row: 3-5 equal-width cards, one row, never wrapping to a second.
4. Chart grid: 2-up (wide + narrow) or 3-up. Never a single full-width chart.
5. Detail table last.

SPACING
- Card padding 24px. Grid gap 20-24px. Page gutter 32px.
- Section rhythm: 24px between the header, banner, KPI row and chart grid.
- Cards in a row are equal height. Chart cards are 320-400px tall.

KPI CARD ANATOMY — identical for every card:
- Label: 11-12px, UPPERCASE, letter-spacing 0.05em, muted colour.
- Icon: 40x40 rounded square (radius 10px), background = accent at 12% opacity,
  icon itself at full accent. Top-right of the card.
- Value: 40-44px, weight 700, tabular-nums so digits align across cards.
- Sublabel: 13px, semantic colour — positive / negative / warning / neutral.

CHARTS
- One accent per chart unless the series are genuinely categorical.
- Area charts get a vertical gradient fade to transparent.
- Donuts have gapped segments and a centred total.
- Axis labels 12px muted. Gridlines horizontal only, 1px, very low contrast.
- Legends below the chart, never floating over it.
`.trim();

const EDITORIAL = `
FAMILY: editorial warm
- Page background #FDF5ED (warm cream). Header band #FFFFFF above it.
- Cards #FFFFFF, radius 16px, border none, shadow barely-there.
- Headings: a high-contrast serif (Playfair Display, Source Serif, or the closest
  available serif). Body and all numerals: Inter-class sans.
- Accents: primary #F97316, crimson #E11D48, mint #10B981, violet #A855F7,
  amber #F59E0B, sky #0EA5E9.
- Insight banner: gradient #F97316 -> #E11D48, white text, radius 16px.
- Categorical palette, in order: #F97316 #E11D48 #A855F7 #F59E0B #10B981 #8B5CF6 #0EA5E9 #84CC16
`.trim();

const MODERN = `
FAMILY: modern violet
- Page background #F8FAFC. Cards #FFFFFF with a 1px #E2E8F0 border, radius 12px,
  shadow none.
- Type: Inter-class sans throughout, headings tight (-0.02em), weight 700.
- Accents: primary #6366F1, violet #8B5CF6, magenta #D946EF, cyan #06B6D4,
  emerald #10B981.
- KPI cards may carry a 3px gradient top border (#6366F1 -> #06B6D4).
- Insight banner: #0F172A card, violet pill label, white text; or a white card
  with a violet-to-magenta gradient border.
- Categorical palette, in order: #6366F1 #8B5CF6 #D946EF #06B6D4 #10B981 #F59E0B #EF4444 #3B82F6
`.trim();

// These prevent the defect class that made the old reference screenshots
// unusable — $NaN, Invalid Date, SLA attainment of 5424%. Those came from a
// synthetic-data harness, but the same failures reach real dashboards whenever
// a divisor is zero or a date column doesn't parse, and the guards cost nothing.
const NUMERIC_SAFETY = `
NUMBER AND DATE SAFETY — non-negotiable, these ship to real users:
- Never divide without guarding the denominator. \`b ? a / b : 0\`, never \`a / b\`.
- Never render a raw computed number. Format through a helper that returns a
  dash for NaN, Infinity, null and undefined. A card showing "—" is fine;
  a card showing "$NaN" is not.
- Parse dates defensively. Check the result is valid before formatting; render a
  dash rather than the string "Invalid Date".
- Clamp bounded metrics. Rates, percentages, attainment, compliance and share
  are 0-100 by definition — clamp them and label the unit.
- Ratios and multiples (ROAS, ARPU) must be sanity-checked against their inputs.
  If revenue < spend then ROAS is below 1; a four-digit multiple means the
  formula is wrong, not that the business is doing well.
- KPI totals must reconcile with the charts beneath them. If the KPI is a sum
  over the same rows the chart plots, compute it from those rows, not separately.
- The insight banner must be derived from the SAME values the KPI cards display.
  A banner asserting a number the cards contradict is worse than no banner.
`.trim();

const AUTO = `
FAMILY: taken from the reference image you chose.
- Do NOT invent a palette. Read the background, surface, accent and text colours
  off your chosen reference and use those, consistently, throughout.
- One accent, used deliberately. A second only for genuine semantic contrast
  (positive vs negative), never for decoration.
- Whatever heading face the reference uses, use it for every heading. Numerals
  always in the sans face, tabular, so figures align down a column.
- Every card in the dashboard gets the SAME background, radius, border and shadow
  as the reference's cards. Uniform, not varied per card.
`.trim();

/** The block injected into the build prompt. Pair with the reference images.
 *
 *  Family "auto" omits the palette so the images supply it — correct when the
 *  curated set spans several families. "editorial"/"modern" pin one, correct when
 *  every reference belongs to that family and you want a single house style. */
export function designTokenBlock(family: DesignFamily = "editorial"): string {
  const familyBlock = family === "editorial" ? EDITORIAL : family === "modern" ? MODERN : AUTO;
  return [
    "DESIGN CONTRACT — follow exactly. Do not substitute your own spacing or structure.",
    familyBlock,
    LAYOUT,
    NUMERIC_SAFETY,
  ].join("\n\n");
}

/** Default family. Set DESIGN_FAMILY=auto when the curated references span more
 *  than one visual family, which is the usual case for a hand-picked set. */
export const DESIGN_FAMILY: DesignFamily = (() => {
  const v = (process.env.DESIGN_FAMILY ?? "").toLowerCase();
  return v === "modern" ? "modern" : v === "auto" ? "auto" : "editorial";
})();