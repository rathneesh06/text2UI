// storage/postgres.ts — StorageEngine #2: Postgres. Selected with STORAGE=postgres
// + PG_URL. Same shape as the DuckDB engine on purpose:
//   - one SCHEMA per project ("p_<projectId>");
//   - public._datasets metadata registry;
//   - replace-all dataset semantics; read-only, capped, timed-out queries.
//
// Differences forced by the engine:
//   - No read_json_auto: tables are CREATEd from the client's DataProfile column
//     types, then filled with one INSERT ... SELECT FROM jsonb_to_recordset()
//     per chunk (typed, null-safe, single round trip per chunk).
//   - Read-only is enforced FOR REAL here: every query runs inside
//     BEGIN TRANSACTION READ ONLY, with SET LOCAL statement_timeout and
//     SET LOCAL search_path. The SQL classifier still runs first (defense in
//     depth + consistent error messages across engines).
//   - BIGINT/NUMERIC arrive as strings from node-postgres by default; type
//     parsers below convert to Number — same tradeoff as both DuckDB engines.
import pg from "pg";
import Cursor from "pg-cursor";
import { assertReadOnly } from "./guard";
import {
  PROJECT_ID_RE, TABLE_NAME_RE,
  type StorageEngine, type DatasetUpload, type DatasetMeta, type QueryOptions, type QueryResult,
  type ProjectRecord, type VersionRecord,
} from "./types";
import type { ColumnType, DataProfile } from "../../shared/types";
import { DESIGN_EMBED_DIM } from "../design-rag/config";

const DEFAULT_ROW_CAP = 10_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const INSERT_CHUNK = 5_000;

// int8 (20) and numeric (1700) parse to strings by default; charts need numbers.
// Identical precision tradeoff (>2^53) to the DuckDB engines.
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;

function schemaFor(projectId: string): string {
  if (!PROJECT_ID_RE.test(projectId)) throw new Error(`invalid projectId "${projectId}"`);
  return `p_${projectId}`;
}
function checkTableName(t: string): void {
  if (!TABLE_NAME_RE.test(t)) throw new Error(`invalid table name "${t}"`);
}

const PG_TYPE: Record<ColumnType, string> = {
  integer: "BIGINT",
  number: "DOUBLE PRECISION",
  boolean: "BOOLEAN",
  date: "TIMESTAMP",
  string: "TEXT",
};

/** Column list for CREATE TABLE / jsonb_to_recordset — from the profile, or
 *  inferred from the first row when the profile carries no columns. */
function columnDefs(profile: DataProfile, rows: Record<string, unknown>[]): { name: string; pgType: string }[] {
  if (profile.columns?.length) {
    return profile.columns.map((c) => ({ name: c.name, pgType: PG_TYPE[c.type] ?? "TEXT" }));
  }
  const first = rows[0] ?? {};
  return Object.keys(first).map((name) => {
    const v = first[name];
    const pgType = typeof v === "number" ? "DOUBLE PRECISION" : typeof v === "boolean" ? "BOOLEAN" : "TEXT";
    return { name, pgType };
  });
}

export class PostgresStorage implements StorageEngine {
  readonly dialect = "postgres" as const;
  private pool: pg.Pool;
  private ready: Promise<void>;
  /** True once the pgvector _design_refs corpus migrated; false if pgvector
   *  is absent. Lets callers know retrieval is available without throwing. */
  designRefsReady = false;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS public._datasets (
      project_id  TEXT NOT NULL,
      table_name  TEXT NOT NULL,
      filename    TEXT NOT NULL,
      row_count   BIGINT NOT NULL,
      profile_json TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (project_id, table_name)
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS public._projects (
      project_id TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      edited_at  TIMESTAMPTZ DEFAULT now()
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS public._versions (
      project_id  TEXT NOT NULL,
      version_num BIGINT NOT NULL,
      label       TEXT NOT NULL,
      app_json    TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (project_id, version_num)
    )`);
    // Design Retrieval corpus (best-effort, isolated): see initDesignRefs().
    await this.initDesignRefs();
  }

  /** Design-RAG corpus migration (pgvector). Best-effort + isolated: if the
   *  `vector` extension isn't installed in this Postgres image, this throws and
   *  we swallow it — the core tables above and the whole app still run, and
   *  retrieval degrades to the text exemplar. Use the pgvector/pgvector image
   *  (or otherwise install pgvector) to enable it. */
  private async initDesignRefs(): Promise<void> {
    const dim = DESIGN_EMBED_DIM;
    try {
      await this.pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public._design_refs (
        id          TEXT PRIMARY KEY,
        domain      TEXT NOT NULL,
        mode        TEXT NOT NULL DEFAULT 'dashboard',
        image_path  TEXT NOT NULL,
        phash       TEXT NOT NULL,
        caption     TEXT,
        tags        JSONB DEFAULT '{}'::jsonb,
        source      TEXT NOT NULL,
        license     TEXT,
        attribution TEXT,
        source_url  TEXT,
        quality     REAL DEFAULT 0,
        img_embed   vector(${dim}),
        cap_embed   vector(${dim}),
        retrievals  INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT now()
      )`);
      // Backfill provenance columns on databases created before they existed.
      await this.pool.query(`ALTER TABLE public._design_refs ADD COLUMN IF NOT EXISTS attribution TEXT`);
      await this.pool.query(`ALTER TABLE public._design_refs ADD COLUMN IF NOT EXISTS source_url TEXT`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_design_refs_img_hnsw
        ON public._design_refs USING hnsw (img_embed vector_cosine_ops)`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_design_refs_domain
        ON public._design_refs (domain, mode, quality)`);
      await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_design_refs_phash
        ON public._design_refs (phash)`);
      this.designRefsReady = true;
    } catch (err) {
      this.designRefsReady = false;
      console.warn(
        `[design-rag] _design_refs migration skipped: ${(err as Error).message}. ` +
          `Retrieval degrades to the text exemplar; use the pgvector/pgvector image to enable it.`,
      );
    }
  }

  async replaceDatasets(projectId: string, datasets: DatasetUpload[]): Promise<DatasetMeta[]> {
    await this.ready;
    const schema = schemaFor(projectId);
    for (const d of datasets) checkTableName(d.tableName);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${qid(schema)}`);

      for (const d of datasets) {
        const cols = columnDefs(d.profile, d.rows);
        if (!cols.length) throw new Error(`dataset "${d.tableName}" has no columns`);
        const colDDL = cols.map((c) => `${qid(c.name)} ${c.pgType}`).join(", ");
        const recordDefs = cols.map((c) => `${qid(c.name)} ${c.pgType}`).join(", ");
        const colList = cols.map((c) => qid(c.name)).join(", ");

        await client.query(`DROP TABLE IF EXISTS ${qid(schema)}.${qid(d.tableName)}`);
        await client.query(`CREATE TABLE ${qid(schema)}.${qid(d.tableName)} (${colDDL})`);
        for (let i = 0; i < d.rows.length; i += INSERT_CHUNK) {
          const chunk = d.rows.slice(i, i + INSERT_CHUNK);
          await client.query(
            `INSERT INTO ${qid(schema)}.${qid(d.tableName)} (${colList})
             SELECT ${colList} FROM jsonb_to_recordset($1::jsonb) AS r(${recordDefs})`,
            [JSON.stringify(chunk)],
          );
        }
      }

      // replace-all: drop project tables not in the incoming set
      const keep = new Set(datasets.map((d) => d.tableName));
      const existing = await client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [schema],
      );
      for (const row of existing.rows) {
        if (!keep.has(row.table_name)) {
          await client.query(`DROP TABLE IF EXISTS ${qid(schema)}.${qid(row.table_name)}`);
        }
      }

      // refresh registry
      await client.query(`DELETE FROM public._datasets WHERE project_id = $1`, [projectId]);
      for (const d of datasets) {
        await client.query(
          `INSERT INTO public._datasets (project_id, table_name, filename, row_count, profile_json)
           VALUES ($1, $2, $3, $4, $5)`,
          [projectId, d.tableName, d.filename, d.rows.length, JSON.stringify(d.profile)],
        );
      }
      await client.query("COMMIT");
      return datasets.map((d) => ({
        tableName: d.tableName, filename: d.filename, rowCount: d.rows.length, profile: d.profile,
      }));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async listDatasets(projectId: string): Promise<DatasetMeta[]> {
    await this.ready;
    schemaFor(projectId); // validates
    const r = await this.pool.query(
      `SELECT table_name, filename, row_count, profile_json
       FROM public._datasets WHERE project_id = $1 ORDER BY table_name`, [projectId],
    );
    return r.rows.map((row: any) => ({
      tableName: row.table_name,
      filename: row.filename,
      rowCount: Number(row.row_count),
      profile: JSON.parse(row.profile_json),
    }));
  }

  async query(projectId: string, sql: string, opts: QueryOptions = {}): Promise<QueryResult> {
    await this.ready;
    const schema = schemaFor(projectId);
    if (!opts.allowWrites) assertReadOnly(sql); // classifier first: consistent errors across engines
    const rowCap = opts.rowCap ?? DEFAULT_ROW_CAP;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const client = await this.pool.connect();
    try {
      // The database-level guarantee the DuckDB engine can't give us:
      await client.query(`BEGIN TRANSACTION READ ONLY`);
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
      await client.query(`SET LOCAL search_path TO ${qid(schema)}`);
      const cursor = client.query(new Cursor(sql));
      try {
        const all = (await cursor.read(rowCap + 1)) as Record<string, unknown>[];
        return { rows: all.slice(0, rowCap), truncated: all.length > rowCap };
      } finally {
        await cursor.close().catch(() => {});
      }
    } finally {
      await client.query("COMMIT").catch(() => client.query("ROLLBACK").catch(() => {}));
      client.release();
    }
  }


  // ---- M3: project persistence -------------------------------------------
  private static ms(v: unknown): number {
    return v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  }

  async upsertProject(projectId: string, name: string): Promise<void> {
    await this.ready;
    schemaFor(projectId);
    await this.pool.query(
      `INSERT INTO public._projects (project_id, name) VALUES ($1, $2)
       ON CONFLICT (project_id) DO UPDATE SET name = EXCLUDED.name, edited_at = now()`,
      [projectId, name],
    );
  }

  async listProjects(): Promise<ProjectRecord[]> {
    await this.ready;
    const r = await this.pool.query(`
      SELECT p.project_id, p.name, p.created_at, p.edited_at,
             COALESCE(v.n, 0) AS version_count,
             COALESCE(d.tables, ARRAY[]::text[]) AS table_names
      FROM public._projects p
      LEFT JOIN (SELECT project_id, count(*) AS n FROM public._versions GROUP BY project_id) v USING (project_id)
      LEFT JOIN (SELECT project_id, array_agg(table_name ORDER BY table_name) AS tables FROM public._datasets GROUP BY project_id) d USING (project_id)
      ORDER BY p.edited_at DESC`);
    return r.rows.map((row: any) => ({
      projectId: row.project_id,
      name: row.name,
      createdAt: PostgresStorage.ms(row.created_at),
      editedAt: PostgresStorage.ms(row.edited_at),
      versionCount: Number(row.version_count),
      tableNames: row.table_names ?? [],
    }));
  }

  async getProject(projectId: string) {
    await this.ready;
    schemaFor(projectId);
    const p = await this.pool.query(
      `SELECT project_id, name, created_at, edited_at FROM public._projects WHERE project_id = $1`, [projectId],
    );
    if (!p.rows.length) return null;
    const v = await this.pool.query(
      `SELECT version_num, label, app_json, created_at FROM public._versions WHERE project_id = $1 ORDER BY version_num`,
      [projectId],
    );
    const row = p.rows[0];
    return {
      project: {
        projectId: row.project_id,
        name: row.name,
        createdAt: PostgresStorage.ms(row.created_at),
        editedAt: PostgresStorage.ms(row.edited_at),
      },
      versions: v.rows.map((x: any): VersionRecord => ({
        num: Number(x.version_num),
        label: x.label,
        app: JSON.parse(x.app_json),
        createdAt: PostgresStorage.ms(x.created_at),
      })),
    };
  }

  async saveVersion(projectId: string, v: { num: number; label: string; app: unknown }): Promise<void> {
    await this.ready;
    schemaFor(projectId);
    await this.pool.query(
      `INSERT INTO public._versions (project_id, version_num, label, app_json) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, version_num) DO UPDATE SET label = EXCLUDED.label, app_json = EXCLUDED.app_json`,
      [projectId, v.num, v.label, JSON.stringify(v.app)],
    );
    await this.pool.query(`UPDATE public._projects SET edited_at = now() WHERE project_id = $1`, [projectId]);
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.ready;
    const schema = schemaFor(projectId);
    await this.pool.query(`DROP SCHEMA IF EXISTS ${qid(schema)} CASCADE`);
    await this.pool.query(`DELETE FROM public._datasets WHERE project_id = $1`, [projectId]);
    await this.pool.query(`DELETE FROM public._versions WHERE project_id = $1`, [projectId]);
    await this.pool.query(`DELETE FROM public._projects WHERE project_id = $1`, [projectId]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}