// storage/duckdb.ts — StorageEngine #1: embedded DuckDB on the BFF.
// Chosen for M1 because its SQL dialect is deliberately Postgres-compatible:
// the SQL the model already generates runs on both, so swapping in the
// Postgres adapter (M2) is a config change, not a prompt-contract change.
//
// Layout inside one persistent .duckdb file:
//   - one SCHEMA per project ("p_<projectId>") holding that project's tables —
//     the same isolation maps 1:1 onto Postgres schemas later;
//   - main._datasets — the metadata registry (filenames, profiles, row counts).
//
// Ingestion reuses the exact mechanism proven in the browser engine: rows are
// written to a temp .json file and loaded with read_json_auto, so server-side
// type inference matches what users saw client-side.
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { assertReadOnly } from "./guard";
import {
  PROJECT_ID_RE, TABLE_NAME_RE,
  type StorageEngine, type DatasetUpload, type DatasetMeta, type QueryOptions, type QueryResult,
  type ProjectRecord, type VersionRecord,
} from "./types";

const DEFAULT_ROW_CAP = 10_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const qid = (s: string) => `"${s.replace(/"/g, '""')}"`; // quote an identifier
const qstr = (s: string) => `'${s.replace(/'/g, "''")}'`; // quote a string literal

function schemaFor(projectId: string): string {
  if (!PROJECT_ID_RE.test(projectId)) throw new Error(`invalid projectId "${projectId}"`);
  return `p_${projectId}`;
}
function checkTableName(t: string): void {
  if (!TABLE_NAME_RE.test(t)) throw new Error(`invalid table name "${t}"`);
}

export class DuckDBStorage implements StorageEngine {
  readonly dialect = "duckdb" as const;
  private instance!: DuckDBInstance;
  private ready: Promise<void>;

  constructor(private dbPath: string) {
    this.ready = this.guardInit();
  }

  /** Storage outages degrade, never crash (the ECONNREFUSED-kills-the-BFF
   *  incident): init failures are CAUGHT here — an uncaught rejection parked
   *  on a constructor field takes the whole process down on modern Node —
   *  logged once with the actionable fix, and RETRIED lazily on next use so
   *  bringing the database back restores service without a restart. */
  private initFailed = false;
  private warnedDown = false;
  private guardInit(): Promise<void> {
    return this.init().then(
      () => { this.initFailed = false; },
      (err: any) => {
        this.initFailed = true;
        if (!this.warnedDown) {
          this.warnedDown = true;
          console.warn(`[storage] ${this.dialect} unavailable (${err?.code ?? err?.message ?? err}) — persistence degraded, requests that need it will fail with a clear error. Is 'docker compose up -d db' running? Retrying on next use.`);
        }
      },
    );
  }
  private async ensure(): Promise<void> {
    await this.ready;
    if (this.initFailed) {
      this.ready = this.guardInit();
      await this.ready;
      if (this.initFailed) throw new Error(`${this.dialect} storage is unavailable (connection refused) — start it with 'docker compose up -d db' and retry`);
    }
  }

  private async init(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.instance = await DuckDBInstance.create(this.dbPath);
    const conn = await this.instance.connect();
    try {
      await conn.run(`CREATE TABLE IF NOT EXISTS main._datasets (
        project_id VARCHAR NOT NULL,
        table_name VARCHAR NOT NULL,
        filename   VARCHAR NOT NULL,
        row_count  BIGINT  NOT NULL,
        profile_json VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT now(),
        PRIMARY KEY (project_id, table_name)
      )`);
      await conn.run(`CREATE TABLE IF NOT EXISTS main._projects (
        project_id VARCHAR PRIMARY KEY,
        name       VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT now(),
        edited_at  TIMESTAMP DEFAULT now()
      )`);
      await conn.run(`CREATE TABLE IF NOT EXISTS main._versions (
        project_id  VARCHAR NOT NULL,
        version_num BIGINT  NOT NULL,
        label       VARCHAR NOT NULL,
        app_json    VARCHAR NOT NULL,
        created_at  TIMESTAMP DEFAULT now(),
        PRIMARY KEY (project_id, version_num)
      )`);
    } finally {
      conn.disconnectSync();
    }
  }

  private async connect(): Promise<DuckDBConnection> {
    await this.ensure();
    return this.instance.connect();
  }

  async replaceDatasets(projectId: string, datasets: DatasetUpload[]): Promise<DatasetMeta[]> {
    const schema = schemaFor(projectId);
    for (const d of datasets) checkTableName(d.tableName);

    const conn = await this.connect();
    try {
      await conn.run(`CREATE SCHEMA IF NOT EXISTS ${qid(schema)}`);

      // load/replace each incoming table via a temp JSON file + read_json_auto
      for (const d of datasets) {
        const tmp = join(tmpdir(), `t2ui_${schema}_${d.tableName}_${Date.now()}.json`);
        writeFileSync(tmp, JSON.stringify(d.rows));
        try {
          await conn.run(
            `CREATE OR REPLACE TABLE ${qid(schema)}.${qid(d.tableName)} AS ` +
            `SELECT * FROM read_json_auto(${qstr(tmp.replace(/\\/g, "/"))})`,
          );
        } finally {
          rmSync(tmp, { force: true });
        }
      }

      // drop project tables that are no longer in the set (replace-all semantics)
      const keep = new Set(datasets.map((d) => d.tableName));
      const existing = await conn.runAndReadAll(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = ${qstr(schema)}`,
      );
      for (const row of existing.getRowObjectsJson()) {
        const t = String(row.table_name);
        if (!keep.has(t)) await conn.run(`DROP TABLE IF EXISTS ${qid(schema)}.${qid(t)}`);
      }

      // refresh the registry for this project
      await conn.run(`DELETE FROM main._datasets WHERE project_id = ${qstr(projectId)}`);
      for (const d of datasets) {
        await conn.run(
          `INSERT INTO main._datasets (project_id, table_name, filename, row_count, profile_json)
           VALUES ($1, $2, $3, $4, $5)`,
          { 1: projectId, 2: d.tableName, 3: d.filename, 4: d.rows.length, 5: JSON.stringify(d.profile) } as any,
        );
      }
      return datasets.map((d) => ({
        tableName: d.tableName, filename: d.filename, rowCount: d.rows.length, profile: d.profile,
      }));
    } finally {
      conn.disconnectSync();
    }
  }

  async listDatasets(projectId: string): Promise<DatasetMeta[]> {
    schemaFor(projectId); // validates
    const conn = await this.connect();
    try {
      const r = await conn.runAndReadAll(
        `SELECT table_name, filename, row_count, profile_json
         FROM main._datasets WHERE project_id = ${qstr(projectId)} ORDER BY table_name`,
      );
      return r.getRowObjectsJson().map((row: any) => ({
        tableName: String(row.table_name),
        filename: String(row.filename),
        rowCount: Number(row.row_count),
        profile: JSON.parse(String(row.profile_json)),
      }));
    } finally {
      conn.disconnectSync();
    }
  }

  async query(projectId: string, sql: string, opts: QueryOptions = {}): Promise<QueryResult> {
    const schema = schemaFor(projectId);
    if (!opts.allowWrites) assertReadOnly(sql); // writes seam (M4): policy, not redesign
    const rowCap = opts.rowCap ?? DEFAULT_ROW_CAP;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const conn = await this.connect();
    try {
      const work = (async () => {
        // Fresh connection per query, so USE can't leak scope across requests.
        await conn.run(`USE ${qid(schema)}`);
        const reader = await conn.runAndReadUntil(sql, rowCap + 1);
        // getRowObjectsJS gives JS built-ins (Dates serialize to ISO), but BIGINT
        // arrives as native bigint, which JSON.stringify rejects. Convert to Number —
        // identical tradeoff to the in-browser DuckDB-WASM engine (counts/sums chart fine;
        // precision past 2^53 is theoretical for this data).
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
      // On timeout this also tears down the connection doing the work.
      conn.disconnectSync();
    }
  }


  // ---- M3: project persistence -------------------------------------------
  private static ms(v: unknown): number {
    return v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  }

  async upsertProject(projectId: string, name: string): Promise<void> {
    schemaFor(projectId); // validates
    const conn = await this.connect();
    try {
      await conn.run(
        `INSERT INTO main._projects (project_id, name) VALUES ($1, $2)
         ON CONFLICT (project_id) DO UPDATE SET name = excluded.name, edited_at = now()`,
        { 1: projectId, 2: name } as any,
      );
    } finally {
      conn.disconnectSync();
    }
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const conn = await this.connect();
    try {
      const projects = (await conn.runAndReadAll(
        `SELECT project_id, name, created_at, edited_at FROM main._projects ORDER BY edited_at DESC`,
      )).getRowObjectsJS() as any[];
      const counts = (await conn.runAndReadAll(
        `SELECT project_id, count(*) AS n FROM main._versions GROUP BY project_id`,
      )).getRowObjectsJS() as any[];
      const tables = (await conn.runAndReadAll(
        `SELECT project_id, table_name FROM main._datasets ORDER BY table_name`,
      )).getRowObjectsJS() as any[];
      const countBy = new Map(counts.map((r) => [String(r.project_id), Number(r.n)]));
      const tablesBy = new Map<string, string[]>();
      for (const r of tables) {
        const k = String(r.project_id);
        tablesBy.set(k, [...(tablesBy.get(k) ?? []), String(r.table_name)]);
      }
      return projects.map((r) => ({
        projectId: String(r.project_id),
        name: String(r.name),
        createdAt: DuckDBStorage.ms(r.created_at),
        editedAt: DuckDBStorage.ms(r.edited_at),
        versionCount: countBy.get(String(r.project_id)) ?? 0,
        tableNames: tablesBy.get(String(r.project_id)) ?? [],
      }));
    } finally {
      conn.disconnectSync();
    }
  }

  async getProject(projectId: string) {
    schemaFor(projectId);
    const conn = await this.connect();
    try {
      const rows = (await conn.runAndReadAll(
        `SELECT project_id, name, created_at, edited_at FROM main._projects WHERE project_id = ${qstr(projectId)}`,
      )).getRowObjectsJS() as any[];
      if (!rows.length) return null;
      const versions = (await conn.runAndReadAll(
        `SELECT version_num, label, app_json, created_at FROM main._versions
         WHERE project_id = ${qstr(projectId)} ORDER BY version_num`,
      )).getRowObjectsJS() as any[];
      const r = rows[0];
      return {
        project: {
          projectId: String(r.project_id),
          name: String(r.name),
          createdAt: DuckDBStorage.ms(r.created_at),
          editedAt: DuckDBStorage.ms(r.edited_at),
        },
        versions: versions.map((v): VersionRecord => ({
          num: Number(v.version_num),
          label: String(v.label),
          app: JSON.parse(String(v.app_json)),
          createdAt: DuckDBStorage.ms(v.created_at),
        })),
      };
    } finally {
      conn.disconnectSync();
    }
  }

  async saveVersion(projectId: string, v: { num: number; label: string; app: unknown }): Promise<void> {
    schemaFor(projectId);
    const conn = await this.connect();
    try {
      await conn.run(
        `INSERT INTO main._versions (project_id, version_num, label, app_json) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, version_num) DO UPDATE SET label = excluded.label, app_json = excluded.app_json`,
        { 1: projectId, 2: v.num, 3: v.label, 4: JSON.stringify(v.app) } as any,
      );
      await conn.run(`UPDATE main._projects SET edited_at = now() WHERE project_id = ${qstr(projectId)}`);
    } finally {
      conn.disconnectSync();
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    const schema = schemaFor(projectId);
    const conn = await this.connect();
    try {
      await conn.run(`DROP SCHEMA IF EXISTS ${qid(schema)} CASCADE`);
      await conn.run(`DELETE FROM main._datasets WHERE project_id = ${qstr(projectId)}`);
      await conn.run(`DELETE FROM main._versions WHERE project_id = ${qstr(projectId)}`);
      await conn.run(`DELETE FROM main._projects WHERE project_id = ${qstr(projectId)}`);
    } finally {
      conn.disconnectSync();
    }
  }

  async close(): Promise<void> {
    await this.ensure();
    this.instance.closeSync?.();
  }
}