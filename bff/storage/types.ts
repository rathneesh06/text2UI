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
export interface GeneratedApp { files: GeneratedFile[]; summary?: string; }

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

// ---- Server/storage-only exports --------------------------------------
// Regexes used by the server to validate incoming `projectId` and table names.
export const PROJECT_ID_RE = /^[a-zA-Z0-9_-]+$/;
export const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DatasetUpload {
  tableName: string;
  filename: string;
  rows: Record<string, unknown>[];
  profile: DataProfile;
}

export interface DatasetMeta { tableName: string; filename: string; rowCount: number; profile: DataProfile }

export type QueryOptions = { allowWrites?: boolean; rowCap?: number; timeoutMs?: number };
export type QueryResult = { rows: Record<string, unknown>[]; truncated: boolean };

export type ProjectRecord = {
  projectId: string; name: string; createdAt: number; editedAt: number; versionCount: number; tableNames: string[]
};
export type VersionRecord = { num: number; label: string; app: unknown; createdAt: number };

export interface StorageEngine {
  readonly dialect: "duckdb" | "postgres";
  replaceDatasets(projectId: string, datasets: DatasetUpload[]): Promise<DatasetMeta[]>;
  listDatasets(projectId: string): Promise<DatasetMeta[]>;
  query(projectId: string, sql: string, opts?: QueryOptions): Promise<QueryResult>;
  upsertProject(projectId: string, name: string): Promise<void>;
  listProjects(): Promise<ProjectRecord[]>;
  getProject(projectId: string): Promise<{ project: { projectId: string; name: string; createdAt: number; editedAt: number }; versions: VersionRecord[] } | null>;
  saveVersion(projectId: string, v: { num: number; label: string; app: unknown }): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  close(): Promise<void>;
}

// Wave 5 / P8 Step 3: tenant-scoped storage. Same surface as StorageEngine but
// every call carries a tenantId. Implemented by a thin adapter (see
// bff/storage/tenant-scope.ts) that namespaces the projectId per tenant and wraps
// an unmodified StorageEngine — so the concrete DuckDB/Postgres engines are untouched.
export interface TenantStorageEngine {
  readonly dialect: "duckdb" | "postgres";
  replaceDatasets(tenantId: string, projectId: string, datasets: DatasetUpload[]): Promise<DatasetMeta[]>;
  listDatasets(tenantId: string, projectId: string): Promise<DatasetMeta[]>;
  query(tenantId: string, projectId: string, sql: string, opts?: QueryOptions): Promise<QueryResult>;
  upsertProject(tenantId: string, projectId: string, name: string): Promise<void>;
  listProjects(tenantId: string): Promise<ProjectRecord[]>;
  getProject(tenantId: string, projectId: string): Promise<{ project: { projectId: string; name: string; createdAt: number; editedAt: number }; versions: VersionRecord[] } | null>;
  saveVersion(tenantId: string, projectId: string, v: { num: number; label: string; app: unknown }): Promise<void>;
  deleteProject(tenantId: string, projectId: string): Promise<void>;
  close(): Promise<void>;
}