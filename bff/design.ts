import type { Domain } from "./domain";

/**
 * DESIGN ENRICHMENT — the visual twin of domain.ts.
 *
 * domain.ts enriches CONTENT (what a great dashboard for this domain computes).
 * design.ts enriches STYLE (what visual identity it wears). The two axes are
 * deliberately independent: the same structure can wear any theme.
 *
 * VIBRANT EDITION: every theme uses a saturated multi-hue palette (8-color chart
 * ramps), a gradient accent, and per-KPI color rotation. Two guardrails remain,
 * both purely for legibility: colors stay harmonized WITHIN a theme's palette,
 * and a given data entity keeps its color across every chart.
 *
 *   1. CRAFT_FLOOR — invariant quality rules applied to EVERY build.
 *   2. THEMES + selectDesign() — curated vibrant identities, chosen by domain.
 *
 * Mechanism (Phase A+B): themes are concrete Tailwind utility classes + chart hex
 * values the model writes directly; the existing Tailwind compile step picks them
 * up. No pipeline change.
 */

/* ------------------------------------------------------------------ */
/* Craft floor — universal, applies to every build regardless of theme */
/* ------------------------------------------------------------------ */

export const CRAFT_FLOOR = `Craft floor (apply to EVERY build — non-negotiable quality rules):
- Spacing: commit to ONE spacing scale (multiples of 4); consistent gaps between every card/section. Favor a compact, information-dense layout over large empty bands — breathable, never cramped.
- Type hierarchy: build hierarchy with FONT WEIGHT and size, not color. At most 3-4 distinct text sizes. Numbers use tabular-nums so they align.
- Color (VIBRANT): embrace the theme's full saturated palette — use its multi-color chart ramp generously, give each KPI card its own vibrant accent color from the theme's chip set, and use the theme's gradient on hero numbers, chart area fills, or accent bars. Two rules only: (a) stay within the theme's palette so colors stay harmonized, not clashing; (b) a given data entity keeps the SAME color across every chart. Keep BODY TEXT high-contrast and readable — put the color in accents, chips, charts, and gradients, never in long text.
- Chart hygiene: gridlines faint and horizontal-only (no vertical lines, no chart border box); axes without lines/ticks; label series directly or with a minimal legend. Cap a single chart's categorical series at 8 colors.
- Micro-states are DESIGNED, not defaulted: visible hover on every interactive element; row hover on tables; real loading (skeleton), empty, and error states.
- Avoid pure black text on pure white; use the theme's tinted neutral for text.`;

/* ------------------------------------------------------------------ */
/* Layout floor — universal: compact, grid-based, fits ~one screen     */
/* ------------------------------------------------------------------ */

export const LAYOUT_FLOOR = `Layout (compact + information-dense — the primary view should read at a glance with minimal scrolling):
- Structure: ONE KPI stat row at the top (responsive grid, e.g. grid-cols-2 lg:grid-cols-4), then charts in a MULTI-COLUMN grid (grid-cols-1 lg:grid-cols-2, occasionally lg:grid-cols-3). Do NOT stack one full-width card per chart down the page — that is the most common mistake.
- Full width is the EXCEPTION for charts: reserve a full-width row for a single primary trend chart; every other chart shares its row with a sibling in the grid.
- Tables are sized to their COLUMN COUNT, never given full width by default: a narrow table (about 5 columns or fewer) sits in a grid cell or shares a row like a chart; only a genuinely wide / many-column table spans a full row, and when it does it scrolls horizontally (wrap it in overflow-x-auto) instead of shrinking the charts. A table must NEVER steal width from the charts — keep charts at a readable minimum (do not collapse a chart below ~360px / one grid column).
- Constrain chart height: put charts in fixed-height cards (about h-64 to h-72) and set the Recharts ResponsiveContainer to a matching height (240-300px). Never let a chart grow tall and push the page down.
- Density over emptiness: tighter gaps and padding (gap-4 to gap-5, card padding p-4 to p-5); fit more per screen rather than leaving large empty bands — but keep it breathable, never cramped.
- Goal: KPIs plus 2-4 charts visible together near one screen, not a long vertical scroll of giant boxes.`;

/* ------------------------------------------------------------------ */
/* Theme library — vibrant identities, one accent FAMILY each          */
/* ------------------------------------------------------------------ */

export interface DesignSystem {
  id: string;
  label: string;
  vibe: string;
  /** Page background + base text (Tailwind classes). May be a tinted canvas. */
  canvas: string;
  /** Card/surface treatment (Tailwind classes). */
  surface: string;
  /** Accent color stem (text-/bg-/border-). */
  accentClass: string;
  /** Accent as hex, for recharts. */
  accentHex: string;
  /** Tailwind gradient classes for hero numbers / accent bars / fills. */
  accentGradient: string;
  /** Soft accent for the primary KPI icon chip. */
  accentSoft: string;
  /** Per-KPI vibrant chip rotation (bg+text classes) — each KPI gets a different one. */
  kpiChips: string[];
  positiveClass: string;
  negativeClass: string;
  /** Vibrant categorical chart ramp (hex), ordered; 6-8 colors, harmonized. */
  categorical: string[];
  /** Faint chart gridline color (hex). */
  gridHex: string;
  /** Built-in heading family utility (no font loading). */
  headingFamily: string;
  typeNote: string;
  radius: string;
  /** recharts bar radius array literal. */
  barRadius: string;
  density: string;
  elevation: string;
}

export const THEMES: Record<string, DesignSystem> = {
  // SALES — cool but vibrant: indigo→violet→cyan with gradient accents.
  aurora: {
    id: "aurora",
    label: "Aurora",
    vibe: "Vibrant cool — indigo, violet, cyan and emerald with gradient accents on a clean canvas",
    canvas: "bg-slate-50 text-slate-900",
    surface: "bg-white border border-slate-200 shadow-sm rounded-xl",
    accentClass: "indigo-600",
    accentHex: "#4f46e5",
    accentGradient: "bg-gradient-to-r from-indigo-500 to-violet-500",
    accentSoft: "bg-indigo-100 text-indigo-700",
    kpiChips: ["bg-indigo-100 text-indigo-700", "bg-violet-100 text-violet-700", "bg-cyan-100 text-cyan-700", "bg-emerald-100 text-emerald-700"],
    positiveClass: "emerald-600",
    negativeClass: "rose-600",
    categorical: ["#4f46e5", "#7c3aed", "#06b6d4", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#f43f5e"],
    gridHex: "#e2e8f0",
    headingFamily: "font-sans",
    typeNote: "Confident headings; hierarchy via weight. Hero KPI numbers may use the gradient as text fill.",
    radius: "rounded-xl",
    barRadius: "[6, 6, 0, 0]",
    density: "Comfortable: card padding p-6, gap-6, max-w-7xl container.",
    elevation: "Soft shadow-sm + faint slate-200 hairline.",
  },

  // FINANCE — confident saturated blues→teals→greens with a vivid pop (modern fintech).
  prism: {
    id: "prism",
    label: "Prism",
    vibe: "Confident and saturated — blues, teals and greens with a vivid pop; modern fintech energy",
    canvas: "bg-white text-slate-900",
    surface: "bg-white border border-slate-200 shadow-sm rounded-xl",
    accentClass: "blue-600",
    accentHex: "#2563eb",
    accentGradient: "bg-gradient-to-r from-blue-600 to-cyan-500",
    accentSoft: "bg-blue-100 text-blue-700",
    kpiChips: ["bg-blue-100 text-blue-700", "bg-teal-100 text-teal-700", "bg-emerald-100 text-emerald-700", "bg-amber-100 text-amber-700"],
    positiveClass: "emerald-600",
    negativeClass: "rose-600",
    categorical: ["#2563eb", "#0891b2", "#0d9488", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6"],
    gridHex: "#e2e8f0",
    headingFamily: "font-sans",
    typeNote: "Crisp, confident type. Lead charts in blue→cyan; reserve amber/violet for emphasis series.",
    radius: "rounded-xl",
    barRadius: "[6, 6, 0, 0]",
    density: "Comfortable: card padding p-6, gap-6.",
    elevation: "Soft shadow-sm + faint slate-200 hairline.",
  },

  // CRM — warm and vivid: coral, amber, magenta, teal; serif headings; tinted canvas.
  sunset: {
    id: "sunset",
    label: "Sunset",
    vibe: "Warm and vivid — coral, amber, magenta and teal with serif headings on a warm canvas",
    canvas: "bg-orange-50 text-stone-900",
    surface: "bg-white border border-orange-100 shadow-sm rounded-2xl",
    accentClass: "orange-600",
    accentHex: "#ea580c",
    accentGradient: "bg-gradient-to-r from-orange-500 to-rose-500",
    accentSoft: "bg-orange-100 text-orange-700",
    kpiChips: ["bg-orange-100 text-orange-700", "bg-rose-100 text-rose-700", "bg-fuchsia-100 text-fuchsia-700", "bg-teal-100 text-teal-700"],
    positiveClass: "emerald-600",
    negativeClass: "red-600",
    categorical: ["#ea580c", "#e11d48", "#d946ef", "#f59e0b", "#14b8a6", "#8b5cf6", "#0ea5e9", "#84cc16"],
    gridHex: "#f5e6dd",
    headingFamily: "font-serif",
    typeNote: "Page + card titles in font-serif (built-in serif stack) for editorial warmth; body font-sans. Sunset gradient (orange→rose) on hero accents.",
    radius: "rounded-2xl",
    barRadius: "[6, 6, 0, 0]",
    density: "Airy: card padding p-6 md:p-7, gap-7, extra room around the header.",
    elevation: "Soft shadow-sm + warm orange-100 hairline.",
  },

  // MARKETING — maximum vibrance: full saturated multi-hue, gradients everywhere.
  pop: {
    id: "pop",
    label: "Pop",
    vibe: "Maximum vibrance — full saturated multi-hue palette, gradient fills, playful campaign energy",
    canvas: "bg-slate-50 text-slate-900",
    surface: "bg-white border border-slate-200 shadow-sm rounded-2xl",
    accentClass: "fuchsia-600",
    accentHex: "#c026d3",
    accentGradient: "bg-gradient-to-r from-fuchsia-500 via-violet-500 to-indigo-500",
    accentSoft: "bg-fuchsia-100 text-fuchsia-700",
    kpiChips: ["bg-fuchsia-100 text-fuchsia-700", "bg-violet-100 text-violet-700", "bg-pink-100 text-pink-700", "bg-cyan-100 text-cyan-700"],
    positiveClass: "emerald-600",
    negativeClass: "rose-600",
    categorical: ["#d946ef", "#8b5cf6", "#ec4899", "#06b6d4", "#f59e0b", "#10b981", "#3b82f6", "#f43f5e"],
    gridHex: "#e2e8f0",
    headingFamily: "font-sans",
    typeNote: "Bold, slightly oversized headings. Use the multi-stop gradient on hero numbers and chart area fills; rotate KPI chips through the full chip set for maximum color.",
    radius: "rounded-2xl",
    barRadius: "[8, 8, 0, 0]",
    density: "Comfortable-airy: card padding p-6, gap-6; pill-shaped (rounded-full) chips/badges.",
    elevation: "Soft shadow-sm + slate-200 hairline; friendly large radius.",
  },

  // WEB ANALYTICS — electric & technical: cyan, lime, violet; dense grid kept.
  spectrum: {
    id: "spectrum",
    label: "Spectrum",
    vibe: "Electric and technical — cyan, lime and violet on a tight, information-dense grid",
    canvas: "bg-slate-50 text-slate-900",
    surface: "bg-white border border-slate-200 shadow-sm rounded-lg",
    accentClass: "cyan-600",
    accentHex: "#0891b2",
    accentGradient: "bg-gradient-to-r from-cyan-500 to-teal-400",
    accentSoft: "bg-cyan-100 text-cyan-700",
    kpiChips: ["bg-cyan-100 text-cyan-700", "bg-violet-100 text-violet-700", "bg-lime-100 text-lime-700", "bg-rose-100 text-rose-700"],
    positiveClass: "emerald-600",
    negativeClass: "rose-600",
    categorical: ["#0891b2", "#8b5cf6", "#84cc16", "#f43f5e", "#f59e0b", "#14b8a6", "#6366f1", "#ec4899"],
    gridHex: "#e2e8f0",
    headingFamily: "font-sans",
    typeNote: "Information-dense type; lean on tabular-nums. Section titles text-sm font-semibold. Electric cyan→teal gradient on key accents.",
    radius: "rounded-lg",
    barRadius: "[4, 4, 0, 0]",
    density: "Compact: card padding p-4, gap-4; tighter table rows (py-2); fit more per screen without crowding.",
    elevation: "Minimal shadow, faint slate-200 hairline; density over decoration.",
  },
};

/* ------------------------------------------------------------------ */
/* Domain affinity → theme                                             */
/* ------------------------------------------------------------------ */

const AFFINITY: Record<Domain, string> = {
  finance: "prism",
  sales: "aurora",
  marketing: "pop",
  web_analytics: "spectrum",
  users_crm: "sunset",
  healthcare: "prism",
  logistics: "spectrum",
  hr_people: "sunset",
  education: "aurora",
  real_estate: "prism",
  generic: "aurora",
};

export function selectDesign(domain: Domain): DesignSystem {
  return THEMES[AFFINITY[domain]] ?? THEMES.aurora;
}

/* ------------------------------------------------------------------ */
/* Render the chosen theme as a prompt block                           */
/* ------------------------------------------------------------------ */

export function designBlock(domain: Domain): string {
  const t = selectDesign(domain);
  return [
    "",
    `Design system to apply — "${t.label}" (${t.vibe}):`,
    `- Canvas: ${t.canvas}. Container max-w-7xl mx-auto p-6 md:p-8 (unless density says otherwise).`,
    `- Cards/surfaces: ${t.surface}. ${t.elevation}`,
    `- Accent: Tailwind ${t.accentClass} for UI; ${t.accentHex} for the primary chart series. Gradient for hero numbers / accent bars / chart fills: "${t.accentGradient}".`,
    `- KPI cards: give EACH card a different vibrant icon chip, rotating through: ${t.kpiChips.join("  |  ")}. (Don't make every KPI the same color — that's the whole point.)`,
    `- Deltas: positive ${t.positiveClass}, negative ${t.negativeClass}.`,
    `- Chart categorical ramp (use generously, in order; same entity keeps its color across charts): ${t.categorical.join(", ")}. Gridlines: ${t.gridHex}. Bar radius: ${t.barRadius}.`,
    `- Typography: ${t.typeNote} (${t.headingFamily}).`,
    `- Shape & density: dominant radius ${t.radius}. ${t.density}`,
    "Make it genuinely colorful: use the full ramp across charts, vary the KPI chip colors, and apply the gradient on at least the hero/primary elements. Keep body text readable and colors within this palette so it reads vibrant-and-intentional, not chaotic.",
  ].join("\n");
}

/* Exposed for tests / future Phase C token generation. */
export const THEME_LIST: string[] = Object.keys(THEMES);
export { AFFINITY };