// shared/deck-spec.ts — the Deck Spec Graph: the canonical, editable state of a
// presentation. Mirrors the dashboard spec pattern but models a *story*, not a board
// of widgets. Two planning stages write into it: the outline planner fills `outline`
// (narrative beats + slide intents); the slide planner expands those into `slides`
// (typed roles + content blocks). A deterministic compiler turns it into a .pptx.
// The spec persists across turns so each prompt edits the same deck.
import type { Agg, Dimension, Metric, Filter } from "./dashboard-spec";

export type Audience = "investor" | "board" | "executive" | "sales" | "technical" | "academic" | "general";
export type Tone = "formal" | "confident" | "neutral" | "energetic";

/** Narrative role of a slide — drives layout + validation. */
export type SlideRole =
  | "title" | "agenda" | "kpi" | "trend" | "comparison" | "breakdown"
  | "table" | "callout" | "recommendation" | "section" | "appendix";

// ---- content blocks --------------------------------------------------------
export interface HeadingBlock { type: "heading"; text: string; }
export interface BulletsBlock { type: "bullets"; items: string[]; }
export interface CalloutBlock { type: "callout"; text: string; emphasis?: "info" | "good" | "warn"; }
export interface NoteBlock { type: "note"; text: string; }
export interface KpiItem { label: string; metric: Metric; table: string; filters?: Filter[]; format?: Metric["format"]; }
export interface KpisBlock { type: "kpis"; items: KpiItem[]; }
export interface TableBlock {
  type: "table"; table: string;
  title?: string;
  columns: { col: string; label?: string; agg?: Agg }[];
  groupBy?: Dimension[]; filters?: Filter[]; limit?: number;
}
/** A chart bound to data (reuses the dashboard binding vocabulary). The compiler
 *  builds the SQL and resolves real values before rendering — no invented numbers. */
export interface ChartBlock {
  type: "chart";
  title?: string;             // caption shown above the chart (needed for multi-chart slides)
  chartType: "line" | "bar" | "area" | "pie";
  table: string;
  x: Dimension;
  series: Metric[];
  filters?: Filter[];
  sort?: { by: "x" | "y"; dir: "asc" | "desc" };
  limit?: number;
}
export type Block = HeadingBlock | BulletsBlock | CalloutBlock | NoteBlock | KpisBlock | TableBlock | ChartBlock;

// ---- slides & outline ------------------------------------------------------
export interface Slide {
  id: string;
  role: SlideRole;
  title: string;
  message?: string;           // the one-line takeaway for this slide
  blocks: Block[];
  notes?: string;             // speaker notes
}

export interface OutlineNode {
  id: string;                 // becomes the slide id
  role: SlideRole;
  keyMessage: string;
  suggested?: "chart" | "table" | "bullets" | "kpis" | "text";
}

export interface DeckMeta {
  title: string;
  subtitle?: string;
  audience: Audience;
  goal?: string;
  tone?: Tone;
  slideBudget?: number;       // target slide count
}

export interface DeckConstraints {
  maxSlides?: number;         // hard cap
  maxBulletsPerSlide?: number;
  maxBulletWords?: number;
}

export interface DeckSpec {
  version: 1;
  meta: DeckMeta;
  outline: OutlineNode[];
  slides: Slide[];
  constraints?: DeckConstraints;
}

// ---- compiled form (compiler input) ----------------------------------------
// Chart/table/kpi blocks are resolved to real values here so the pptx compiler is
// pure rendering: it never touches data or SQL.
export interface ResolvedChart {
  chartType: ChartBlock["chartType"];
  labels: (string | number)[];
  series: { name: string; values: number[] }[];
}
export interface ResolvedTable { columns: string[]; rows: (string | number)[][]; }
export interface ResolvedKpi { label: string; value: string; }

export interface CompiledBlock {
  block: Block;
  chart?: ResolvedChart;
  table?: ResolvedTable;
  kpis?: ResolvedKpi[];
}
export interface CompiledSlide {
  id: string;
  role: SlideRole;
  title: string;
  message?: string;
  blocks: CompiledBlock[];
  notes?: string;
}
export interface CompiledDeck {
  meta: DeckMeta;
  slides: CompiledSlide[];
  warnings: string[];
}