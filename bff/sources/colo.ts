// sources/colo.ts — STEP 4 of the MySQL track. Exposes the curated full-history
// ticket snapshot ("colo data") to the dashboard pipeline:
//   • coloProfiles()  → the analytics-view DataProfiles for the orchestrator/LLM
//   • coloQuery(sql)  → read-only queries the generated dashboard runs at runtime
//
// IMPORTANT (concurrency): a live dashboard fires many queries at once. We must
// therefore open the snapshot DuckDB ONCE and reuse that single instance for
// every connection — exactly like the main storage engine. Creating a fresh
// instance per query makes concurrent calls collide on the file's lock and fail
// ("Data Load Error" with all-but-one query erroring out).
import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { assertReadOnly } from "../storage/guard";
import type { QueryResult } from "../storage/types";
import type { Dataset } from "../../shared/types";
import { applyModelOn } from "./model";

/** Reserved projectId the BFF recognizes as "use the colo snapshot, not a normal project". */
export const COLO_PROJECT_ID = "colosnapshot";
/** Human-facing name shown in the UI and given to the LLM. */
export const COLO_LABEL = "colo data";
/** Path to the snapshot DuckDB produced by db:snapshot + db:model. */
export const COLO_DB = process.env.COLO_SNAPSHOT_DB || "./.t2ui/snapshot.duckdb";

export function coloAvailable(): boolean {
  return existsSync(COLO_DB);
}

// ---- one shared, long-lived instance for the whole process ----
let instanceP: Promise<DuckDBInstance> | null = null;
function getInstance(): Promise<DuckDBInstance> {
  if (!instanceP) instanceP = DuckDBInstance.create(COLO_DB);
  return instanceP;
}

// The model (CREATE OR REPLACE VIEW …) is built once; the promise is the cache.
let modelP: Promise<Dataset[]> | null = null;
function ensureModel(force = false): Promise<Dataset[]> {
  if (force) modelP = null;
  if (!modelP) {
    modelP = (async () => {
      const inst = await getInstance();
      const c = await inst.connect();
      try {
        const { datasets } = await applyModelOn(c);
        return datasets;
      } finally {
        c.disconnectSync();
      }
    })().catch((e) => { modelP = null; throw e; }); // don't cache failures
  }
  return modelP;
}

/** The curated views, profiled for the planner. Built once, then cached. */
export async function coloProfiles(force = false): Promise<Dataset[]> {
  return ensureModel(force);
}

/** Read-only query against the snapshot. Mirrors DuckDBStorage.query()'s shape.
 *  Reuses the shared instance so concurrent dashboard queries don't collide. */
export async function coloQuery(
  sql: string,
  opts: { rowCap?: number; timeoutMs?: number } = {},
): Promise<QueryResult> {
  assertReadOnly(sql);
  const rowCap = opts.rowCap ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  await ensureModel();                 // guarantee the views exist
  const inst = await getInstance();    // shared instance, new connection per call
  const conn = await inst.connect();
  try {
    const work = (async () => {
      const reader = await conn.runAndReadUntil(sql, rowCap + 1);
      const all = (reader.getRowObjectsJS() as Record<string, unknown>[]).map((row) => {
        for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
        return row;
      });
      return { rows: all.slice(0, rowCap), truncated: all.length > rowCap };
    })();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`query exceeded ${timeoutMs}ms`)), timeoutMs).unref?.(),
    );
    return await Promise.race([work, timeout]);
  } finally {
    conn.disconnectSync();
  }
}