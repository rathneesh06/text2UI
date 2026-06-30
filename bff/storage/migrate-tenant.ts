// bff/storage/migrate-tenant.ts — Wave 5 / P8 Step 3: one-time data migration.
//
// Step 3 changed a project's storage key to `<tenant>__<projectId>`, so a project's
// schema moved from `p_<projectId>` to `p_<tenant>__<projectId>` and its metadata
// rows are keyed by the composed id. This CLI re-namespaces any PRE-tenancy data
// (project ids with no "__") into a target tenant (default "public"), so existing
// projects/datasets/versions carry over instead of disappearing.
//
//   npm run migrate:tenant                 # uses STORAGE/STORAGE_PATH or PG_URL from env
//   npm run migrate:tenant -- --tenant=public
//
// Idempotent: already-namespaced ids (containing "__") are skipped.

import { DuckDBInstance } from "@duckdb/node-api";
import { Pool } from "pg";
import { PROJECT_ID_RE } from "./types";

const qid = (s: string) => '"' + s.replace(/"/g, '""') + '"';

export interface MigrationResult { engine: string; migrated: string[]; skipped: string[] }

function assertTenant(tenant: string): void {
  if (!PROJECT_ID_RE.test(tenant) || tenant.includes("__")) {
    throw new Error(`invalid tenant "${tenant}" (must match ${PROJECT_ID_RE.source}, no "__")`);
  }
}
const isOld = (id: string) => !id.includes("__");

// ---- DuckDB (no ALTER SCHEMA RENAME — copy tables, then drop) --------------
export async function migrateDuckDb(dbPath: string, tenant = "public"): Promise<MigrationResult> {
  assertTenant(tenant);
  const inst = await DuckDBInstance.create(dbPath);
  const conn = await inst.connect();
  const migrated: string[] = [];
  const skipped: string[] = [];
  try {
    const ids = new Set<string>();
    for (const t of ["_projects", "_datasets", "_versions"]) {
      const r = await conn.run(`SELECT DISTINCT project_id FROM main.${qid(t)}`);
      for (const row of await r.getRowObjects()) ids.add(String((row as any).project_id));
    }
    for (const pid of ids) {
      if (!isOld(pid)) { skipped.push(pid); continue; }
      const newKey = `${tenant}__${pid}`;
      const oldSchema = `p_${pid}`, newSchema = `p_${newKey}`;
      await conn.run(`CREATE SCHEMA IF NOT EXISTS ${qid(newSchema)}`);
      const tbls = await conn.run(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${oldSchema.replace(/'/g, "''")}'`);
      for (const row of await tbls.getRowObjects()) {
        const tn = String((row as any).table_name);
        await conn.run(`CREATE TABLE ${qid(newSchema)}.${qid(tn)} AS SELECT * FROM ${qid(oldSchema)}.${qid(tn)}`);
      }
      await conn.run(`DROP SCHEMA IF EXISTS ${qid(oldSchema)} CASCADE`);
      for (const t of ["_projects", "_datasets", "_versions"]) {
        await conn.run(`UPDATE main.${qid(t)} SET project_id = '${newKey.replace(/'/g, "''")}' WHERE project_id = '${pid.replace(/'/g, "''")}'`);
      }
      migrated.push(pid);
    }
  } finally {
    conn.disconnectSync?.();
  }
  return { engine: "duckdb", migrated, skipped };
}

// ---- Postgres (ALTER SCHEMA RENAME) ----------------------------------------
export async function migratePostgres(pgUrl: string, tenant = "public"): Promise<MigrationResult> {
  assertTenant(tenant);
  const pool = new Pool({ connectionString: pgUrl });
  const migrated: string[] = [];
  const skipped: string[] = [];
  const client = await pool.connect();
  try {
    const ids = new Set<string>();
    for (const t of ["_projects", "_datasets", "_versions"]) {
      const r = await client.query(`SELECT DISTINCT project_id FROM public.${qid(t)}`);
      for (const row of r.rows) ids.add(String(row.project_id));
    }
    for (const pid of ids) {
      if (!isOld(pid)) { skipped.push(pid); continue; }
      const newKey = `${tenant}__${pid}`;
      const oldSchema = `p_${pid}`, newSchema = `p_${newKey}`;
      await client.query("BEGIN");
      try {
        const exists = await client.query(
          `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [oldSchema],
        );
        if (exists.rowCount) await client.query(`ALTER SCHEMA ${qid(oldSchema)} RENAME TO ${qid(newSchema)}`);
        for (const t of ["_projects", "_datasets", "_versions"]) {
          await client.query(`UPDATE public.${qid(t)} SET project_id = $1 WHERE project_id = $2`, [newKey, pid]);
        }
        await client.query("COMMIT");
        migrated.push(pid);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
  return { engine: "postgres", migrated, skipped };
}

/** CLI entry: pick the engine from env, run, print a summary. */
export async function runMigration(env: NodeJS.ProcessEnv = process.env, tenant = "public"): Promise<MigrationResult> {
  const kind = (env.STORAGE ?? "duckdb").toLowerCase();
  if (kind === "postgres") {
    if (!env.PG_URL) throw new Error("STORAGE=postgres requires PG_URL");
    return migratePostgres(env.PG_URL, tenant);
  }
  return migrateDuckDb(env.STORAGE_PATH ?? "bff/data/text2ui.duckdb", tenant);
}

// Run when invoked directly: `tsx bff/storage/migrate-tenant.ts -- --tenant=public`
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.find((a) => a.startsWith("--tenant="));
  const tenant = arg ? arg.split("=")[1] : "public";
  runMigration(process.env, tenant)
    .then((r) => { console.log(`[migrate] ${r.engine}: migrated ${r.migrated.length}, skipped ${r.skipped.length}`); if (r.migrated.length) console.log("  migrated:", r.migrated.join(", ")); })
    .catch((e) => { console.error("[migrate] failed:", e.message); process.exit(1); });
}
