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
}

export interface DataProfile {
  source: { filename: string; format: "csv" | "xlsx" | "json"; sheetName?: string };
  rowCount: number;
  columns: ColumnProfile[];
  sampleRows: Record<string, unknown>[];
}

// Produced in the browser by ingest(). `rows` stays client-side (feeds the
// data layer); only `profile` is sent to the server.
export interface IngestResult {
  profile: DataProfile;
  rows: Record<string, unknown>[];
}

// What the BFF returns to the browser after codegen.
export interface GeneratedFile { path: string; content: string; }
export interface GeneratedApp {
  files: GeneratedFile[];
  summary?: string;
  /** Tailwind CSS compiled server-side from the app's class names (Phase: styling).
   *  Present on build turns when compilation succeeded; absent on edits/heals and
   *  on any compile failure, in which case the sandbox falls back to the Play CDN. */
  css?: string;
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
}