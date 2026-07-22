// shared/types.ts — the only types that cross the client/server boundary.
// Imported by both src/ (browser) and bff/ (server). One source of truth.

export type ColumnType = "integer" | "number" | "boolean" | "date" | "string";

export interface ColumnProfile {
  name: string;
  type: ColumnType;
  nullable: boolean;
  uniqueCount: number;
  sampleValues: unknown[];
  min?: number | string;
  max?: number | string;
  avg?: number;                                   // mean, numeric columns
  nullCount?: number;                             // count of NULLs
  topValues?: { value: unknown; count: number }[]; // most frequent values, categoricals
  statsExact?: boolean;                           // true ONLY when topValues/uniqueCount came from a
                                                  // full pass (exact SQL or full in-memory data) —
                                                  // the exhaustiveness guard may hard-drop only then
}

/** A verified table relationship — the ONLY thing widget.join may compile
 *  against. "constraint" = declared in the source database; "measured" =
 *  proven by executed uniqueness + containment checks on the actual data.
 *  Name-heuristic candidates (semantic layer) are advisory and never compile. */
export interface ForeignKeyEdge {
  col: string;        // column on THIS table (the many side)
  refTable: string;   // referenced table (the one side)
  refCol: string;     // referenced column (unique on refTable)
  verified: "constraint" | "measured";
}

export interface DataProfile {
  source: { filename: string; format: "csv" | "xlsx" | "json"; sheetName?: string };
  rowCount: number;
  columns: ColumnProfile[];
  sampleRows: Record<string, unknown>[];
  foreignKeys?: ForeignKeyEdge[]; // verified outgoing edges (A3)
}

// Produced in the browser by ingest(). `rows` stays client-side (feeds the
// data layer); only `profile` is sent to the server.
export interface IngestResult {
  profile: DataProfile;
  rows: Record<string, unknown>[];
}

// What the BFF returns to the browser after codegen.
export interface GeneratedFile { path: string; content: string; }
/** Wave 4 / N2b: which generation pipeline to run. The dashboard is the original;
 *  pdf and ppt are peer pipelines selected at the landing screen. */
export type OutputMode = "dashboard" | "pdf" | "ppt";

/** Orchestrator (Phase 1): the structured brief a planner LLM emits from the
 *  data + user prompt. Chooses the output mode and fully specifies the build so
 *  the generator gets complete context (features + palette + narrative). */
export interface BriefChart { type: string; x: string; y: string; why?: string }
export interface BriefPalette { primary: string; accent: string; neutrals: string[]; vibe: string }
export interface OrchestratorBrief {
  outputMode: OutputMode;
  title: string;
  narrative: string;
  kpis: string[];
  charts: BriefChart[];
  palette: BriefPalette;
  designDirection: string;
  enhancedPrompt: string;
}
export interface ClarificationNeeded { needsClarification: true; question: string }
/** The turn wants an ANSWER, not an artifact: questions about the data/artifact,
 *  greetings, feedback. dataQuestion=true means a correct answer needs computing
 *  over the full data (route to the snapshot text2SQL path for server sources). */
export interface RespondTurn { respond: true; reply: string; dataQuestion?: boolean }
export type OrchestratorResult = OrchestratorBrief | ClarificationNeeded | RespondTurn;
export interface ChatMessage { role: "user" | "assistant"; content: string }

/** Structured report the model returns for the PDF pipeline; rendered deterministically. */
export interface ReportKpi { label: string; value: string }
export interface ReportTable { columns: string[]; rows: string[][] }
export interface ReportSection {
  heading: string;
  body?: string;
  bullets?: string[];
  table?: ReportTable;
}
export interface ReportDoc {
  title: string;
  subtitle?: string;
  kpis?: ReportKpi[];
  sections: ReportSection[];
}

/** Structured slide deck the model returns for the PPT pipeline; rendered deterministically. */
export interface DeckTable { columns: string[]; rows: string[][] }
export interface DeckSlide {
  title: string;
  bullets?: string[];
  table?: DeckTable;
  notes?: string; // speaker notes
}
export interface DeckDoc {
  title: string;
  subtitle?: string;
  slides: DeckSlide[];
}

export interface GeneratedApp {
  files: GeneratedFile[];
  summary?: string;
  /** Tailwind CSS compiled server-side from the app's class names (Phase: styling).
   *  Present on build turns when compilation succeeded; absent on edits/heals and
   *  on any compile failure, in which case the sandbox falls back to the Play CDN. */
  css?: string;
  /** Wave 4 / P6: cost & latency summary for the generation (set by the server). */
  metrics?: GenerationMetrics;
}

/** Wave 4 / P6: cost & latency accounting (shared so the UI can render it). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface PhaseAgg {
  calls: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
}
export interface GenerationMetrics {
  calls: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  model: string;
  byPhase: Record<string, PhaseAgg>;
}

// What the browser sends the BFF to drive a build / edit / self-heal turn.
// A dataset = one uploaded file, loaded into one SQL table (tableName).
export interface Dataset {
  tableName: string;
  profile: DataProfile;
}
export type DataAccess = "inline" | "remote";

export interface AssembleInput {
  datasets: Dataset[];
  userPrompt: string;
  currentCode?: string; // present on edit turns
  lastError?: string;   // present on self-heal turns
  /** inline = rows shipped into the sandbox (default); remote = query() hits the BFF */
  dataAccess?: DataAccess;
  /** SQL dialect hints for the model — injected by the SERVER from the active
   *  storage engine (never trusted from the client). Default: duckdb. */
  sqlDialect?: "duckdb" | "postgres";
  /** Phase 3 design-plan pass: a short layout plan produced by a cheap pre-pass
   *  and injected into BUILD turns only. Server-generated; ignored on edit/heal. */
  plan?: string;
  /** Wave 0 / N2a: Markdown converted from user-uploaded documents (PDF/Word/PPT)
   *  via the markitdown sidecar, used as CONTEXT only (not queryable data).
   *  Injected into BUILD turns only; ignored on edit/heal. */
  docContext?: string;
  /** Wave 3 / N4: the model's domain self-classification, set by the SERVER only
   *  when rule-based detection wasn't confident (build turns). Feeds the matching
   *  domain prior + exemplar. A Domain string; ignored if unrecognized. */
  modelDomain?: string;
  /** Design Retrieval (design-RAG): a text block of retrieved design-reference
   *  notes, injected into BUILD turns in place of the static text exemplar when
   *  present. Server-generated; the ref IMAGES travel separately to the model
   *  call. Empty/absent -> the build uses exemplarBlock() exactly as before. */
  referenceBlock?: string;
}