// bff/sources/workbench-store.ts — the bridge between the text2SQL workbench and
// the existing generation pipelines. When a workbench chat extracts tables, they
// are snapshotted into a per-source DuckDB file and REGISTERED here as a named
// source. From that point the source behaves exactly like "colo data":
//
//   • GET /api/sources lists it, so the build page offers it next to colo
//   • wbQuery(projectId, sql) serves the compiled dashboard's runtime queries
//     (routed by handleQuery on the wb_ projectId prefix)
//   • the deck route wires query = wbQuery for slide-chart resolution
//
// Unlike the in-memory spec/session stores, the manifest is a small JSON file on
// disk next to the snapshot .duckdb files — extracted data is the user's work
// product and must survive a BFF restart.
//
// Concurrency mirrors sources/colo.ts: ONE shared DuckDBInstance per snapshot file
// (created lazily, cached forever), a fresh connection per query — concurrent
// dashboard widgets otherwise collide on the file lock.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { assertReadOnly } from "../storage/guard";
import type { QueryResult } from "../storage/types";
import type { Dataset } from "../../shared/types";

export const WB_PREFIX = "wb_";
/** Evaluated per call (not at import) so tests can redirect it to a temp dir
 *  BEFORE touching the store — test runs must never write into the production
 *  manifest (that bug published test fixtures onto the real start page). */
export const WB_DIR = () => process.env.WB_DIR || "./.t2ui/workbench";
const MANIFEST = () => join(WB_DIR(), "manifest.json");

export interface WorkbenchSource {
  projectId: string;
  /** For combined sources: the original projectIds merged in (lineage). */
  components?: string[];      // "wb_" + slug — doubles as the /api/query routing key
  label: string;          // human-facing, e.g. "shop_db extract (orders, customers)"
  tenantId: string;
  dbPath: string;
  tables: Dataset[];      // profiles for the planner / build page (schema + samples)
  createdAt: number;
}

export function isWorkbenchProject(projectId: string): boolean {
  return typeof projectId === "string" && projectId.startsWith(WB_PREFIX);
}

// ---- manifest (load once, write-through) -------------------------------------
let manifestCache: WorkbenchSource[] | null = null;

function loadManifest(): WorkbenchSource[] {
  if (manifestCache) return manifestCache;
  try {
    const raw = readFileSync(MANIFEST(), "utf8");
    const parsed = JSON.parse(raw);
    manifestCache = Array.isArray(parsed?.sources) ? parsed.sources : [];
  } catch {
    manifestCache = [];
  }
  // Drop entries whose snapshot file vanished (manual cleanup, fresh checkout).
  manifestCache = manifestCache!.filter((s) => existsSync(s.dbPath));
  return manifestCache!;
}

/** Atomic JSON write: tmp file + rename, so a crash mid-write can never leave a
 *  truncated manifest/stages file (blueprint: "atomic publish semantics"). */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(WB_DIR(), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function saveManifest(sources: WorkbenchSource[]): void {
  writeJsonAtomic(MANIFEST(), { sources });
  manifestCache = sources;
}

/** Slug for ids/filenames: lowercase, [a-z0-9_], deduped against existing ids. */
export function wbSlug(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "extract";
  const existing = new Set(loadManifest().map((s) => s.projectId));
  let id = WB_PREFIX + base;
  for (let i = 2; existing.has(id); i++) id = `${WB_PREFIX}${base}_${i}`;
  return id;
}

/** Where a new snapshot's DuckDB file should be written (caller passes to snapshotMysql). */
export function wbDbPath(projectId: string): string {
  mkdirSync(WB_DIR(), { recursive: true });
  return join(WB_DIR(), `${projectId}.duckdb`);
}

/** Register (or replace) an extracted source. Idempotent on projectId. */
export function registerWorkbenchSource(src: WorkbenchSource): WorkbenchSource {
  const rest = loadManifest().filter((s) => s.projectId !== src.projectId);
  saveManifest([src, ...rest]);
  return src;
}

/** All sources for a tenant — shape-compatible with the /api/sources colo entry. */
export function listWorkbenchSources(tenantId: string): WorkbenchSource[] {
  return loadManifest().filter((s) => s.tenantId === tenantId);
}

export function getWorkbenchSource(projectId: string): WorkbenchSource | null {
  return loadManifest().find((s) => s.projectId === projectId) ?? null;
}

export function removeWorkbenchSource(tenantId: string, projectId: string): boolean {
  const src = loadManifest().find((s) => s.projectId === projectId && s.tenantId === tenantId);
  if (!src) return false;
  saveManifest(loadManifest().filter((s) => s.projectId !== projectId));
  instances.delete(src.dbPath);
  try { rmSync(src.dbPath); } catch { /* file may be held; manifest removal is what matters */ }
  return true;
}

// ---- query path (colo.ts pattern: one instance per file, connection per call) --
const instances = new Map<string, Promise<DuckDBInstance>>();

/** Close and evict the cached instance for a file (best-effort) — needed before
 *  another instance ATTACHes the same file (a hard lock conflict on Windows). */
/** Evict + close a cached instance for a db file (no-op if not cached). Writers
 *  MUST call this before opening a file the query cache may hold (Windows locks). */
export async function releaseInstance(dbPath: string): Promise<void> {
  const p = instances.get(dbPath);
  instances.delete(dbPath);
  if (p) { try { (await p).closeSync(); } catch { /* already closed */ } }
}

function getInstance(dbPath: string): Promise<DuckDBInstance> {
  let p = instances.get(dbPath);
  if (!p) { p = DuckDBInstance.create(dbPath); instances.set(dbPath, p); }
  return p;
}

/** Read-only query against an extracted snapshot. Mirrors coloQuery()'s shape so
 *  handleQuery and the deck route can treat wb and colo interchangeably. */
export async function wbQuery(
  projectId: string,
  sql: string,
  opts: { rowCap?: number; timeoutMs?: number } = {},
): Promise<QueryResult> {
  assertReadOnly(sql);
  const src = getWorkbenchSource(projectId);
  if (!src) throw new Error(`unknown workbench source: ${projectId}`);
  const rowCap = opts.rowCap ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const inst = await getInstance(src.dbPath);
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

// ---- staging: extracts accumulate per-conversation until "Extract DB" ------------
// Chat extracts land in ONE staging DuckDB file per conversation (successive
// extracts append tables into the same file). Nothing is published to the build
// page until finalizeStaged() — the "Extract DB" button — registers that file as
// a single named source. Staging is in-memory + on-disk-file; an unfinalized
// stage does not survive a BFF restart (finalized sources do, via the manifest).
export interface StagedState {
  conversationId: string;
  tenantId: string;
  dbPath: string;
  tables: Dataset[];   // accumulated, deduped by tableName (last extract wins)
}

const STAGES = () => join(WB_DIR(), "stages.json");
const staged = new Map<string, StagedState>();
let stagesLoaded = false;

/** Boot-time reconciliation (blueprint: "keep unpublished stages recoverable"):
 *  load stages.json once, keeping only entries whose snapshot file still exists.
 *  A restart therefore no longer loses staged-but-unpublished work. */
function loadStages(): void {
  if (stagesLoaded) return;
  stagesLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(STAGES(), "utf8"));
    const list: StagedState[] = Array.isArray(parsed?.stages) ? parsed.stages : [];
    for (const st of list) {
      if (st?.conversationId && existsSync(st.dbPath)) staged.set(st.conversationId, st);
    }
  } catch { /* no stages yet */ }
}

function saveStages(): void {
  writeJsonAtomic(STAGES(), { stages: [...staged.values()] });
}

const safeId = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 48) || "conv";

/** The staging DuckDB file for a conversation (stable across extracts). */
export function stagingDbPath(conversationId: string): string {
  mkdirSync(WB_DIR(), { recursive: true });
  return join(WB_DIR(), `stage_${safeId(conversationId)}.duckdb`);
}

/** Merge freshly-snapshotted tables into the conversation's stage. */
export function addStaged(conversationId: string, tenantId: string, dbPath: string, tables: Dataset[]): StagedState {
  loadStages();
  const prev = staged.get(conversationId);
  const merged = prev ? [...prev.tables.filter((t) => !tables.some((n) => n.tableName === t.tableName)), ...tables] : [...tables];
  const state: StagedState = { conversationId, tenantId, dbPath, tables: merged };
  staged.set(conversationId, state);
  saveStages();
  return state;
}

export function getStaged(conversationId: string): StagedState | null {
  loadStages();
  return staged.get(conversationId) ?? null;
}

/** Merge multiple PUBLISHED workbench sources into ONE new source: a fresh
 *  DuckDB file containing every table from every input (collisions suffixed
 *  _2, _3, …). Downstream (spec planner, /api/query, deck) needs no changes —
 *  a combined source is just another source. `components` records lineage so
 *  the UI can avoid re-adding a source that's already inside. */
export async function combineSources(tenantId: string, projectIds: string[], label?: string): Promise<{ source: WorkbenchSource; renames: string[] }> {
  const ids = [...new Set(projectIds.map(String).filter(Boolean))];
  if (ids.length < 2) throw new Error("need at least two sources to combine");
  const srcs = ids.map((id) => {
    const src = getWorkbenchSource(id);
    if (!src || src.tenantId !== tenantId) throw new Error(`unknown source: ${id}`);
    return src;
  });

  const srcLabel = label?.trim() || srcs.map((s) => s.label).join(" + ").slice(0, 80);
  const projectId = wbSlug(srcLabel);
  const dbPath = wbDbPath(projectId);

  // The query cache may hold these files open — release them before ATTACH.
  for (const src of srcs) await releaseInstance(src.dbPath);
  await releaseInstance(dbPath);

  const inst = await DuckDBInstance.create(dbPath);
  const conn = await inst.connect();
  const tables: Dataset[] = [];
  const renames: string[] = [];
  const taken = new Set<string>();
  try {
    for (let i = 0; i < srcs.length; i++) {
      await conn.run(`ATTACH '${srcs[i].dbPath.replace(/'/g, "''")}' AS s${i} (READ_ONLY)`);
      for (const t of srcs[i].tables) {
        let local = t.tableName;
        for (let n = 2; taken.has(local); n++) local = `${t.tableName}_${n}`;
        taken.add(local);
        if (local !== t.tableName) renames.push(`${srcs[i].label}: ${t.tableName} → ${local} (name collision)`);
        await conn.run(`CREATE TABLE main."${local}" AS SELECT * FROM s${i}.main."${t.tableName}"`);
        tables.push({ ...t, tableName: local });
      }
      await conn.run(`DETACH s${i}`);
    }
  } finally {
    conn.disconnectSync();
    inst.closeSync(); // release the new file for the lazy query cache (Windows)
  }

  const source = registerWorkbenchSource({
    projectId, label: srcLabel, tenantId, dbPath, tables, createdAt: Date.now(),
    components: srcs.flatMap((s) => s.components?.length ? s.components : [s.projectId]),
  });
  return { source, renames };
}

/** Discard an UNPUBLISHED stage: remove the entry and delete its staging file.
 *  A published source is untouched — finalize already removed the stage entry,
 *  and the file now belongs to the source. Returns whether anything was removed. */
export function discardStaged(conversationId: string, tenantId: string): boolean {
  loadStages();
  const st = staged.get(conversationId);
  if (!st || st.tenantId !== tenantId) return false;
  staged.delete(conversationId);
  saveStages();
  try { rmSync(st.dbPath, { force: true }); } catch { /* file may be locked; sweep later */ }
  return true;
}

/** "Extract DB": publish the accumulated stage as ONE workbench source. The
 *  staging file simply becomes the source's dbPath — no copy, no rename. */
export function finalizeStaged(conversationId: string, label?: string): WorkbenchSource {
  loadStages();
  const st = staged.get(conversationId);
  if (!st || !st.tables.length) {
    // Idempotency (blueprint: "duplicate publish attempts"): if this stage was
    // already published (double-click, retried request), return that source.
    const prior = loadManifest().find((s) => s.dbPath.includes(`stage_`) && s.dbPath === stagingDbPath(conversationId));
    if (prior) return prior;
    throw new Error("nothing staged yet — extract some tables in the chat first");
  }
  const srcLabel = label?.trim()
    || `extracted DB (${st.tables.slice(0, 3).map((t) => t.tableName).join(", ")}${st.tables.length > 3 ? ", …" : ""})`;
  const projectId = wbSlug(srcLabel);
  const source = registerWorkbenchSource({
    projectId, label: srcLabel, tenantId: st.tenantId, dbPath: st.dbPath,
    tables: st.tables, createdAt: Date.now(),
  });
  staged.delete(conversationId); // published — a fresh stage starts a new DB
  saveStages();
  return source;
}
