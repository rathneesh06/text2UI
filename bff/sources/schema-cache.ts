// bff/sources/schema-cache.ts — the schema-graph cache (Phase C1, pulled forward).
//
// WHY: cold builds against live sources re-pay full introspection every time —
// per-table sampling, full-table exact stats, FK constraint fetch, and measured
// relationship proofs. That work is (a) expensive and (b) almost always
// identical to last time. This cache persists the finished Dataset profiles
// (columns + enrichment + verified foreignKeys) per connection so a repeat
// build — or a BFF restart, which tsx watch does constantly in dev — costs one
// cheap DESCRIBE per table instead of the whole sweep.
//
// CORRECTNESS RULES (the bar is honesty, not speed):
//   1. STRUCTURE IS NEVER STALE. A cached table is served only if its live
//      schema signature (DESCRIBE → sorted name:type list) matches the one
//      captured at store time. A changed/renamed/retyped column invalidates
//      exactly that table.
//   2. STATS MAY AGE WITHIN TTL — topValues/min/max/rowCount can drift with
//      data. TTL (default 6h) bounds that drift, `refresh` bypasses the cache
//      entirely, and every cache hit is SAID OUT LOUD in rec.warnings so the
//      user knows the profile's age and how to refresh.
//   3. NO SECRETS. The fingerprint hashes dialect|host|port|database|user —
//      never the password — and cache files contain only profile data that the
//      UI already displays.
//   4. TOTAL. Every filesystem or query failure degrades to a cache miss;
//      this layer can slow nothing down and break nothing.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Dataset } from "../../shared/types";
import type { DbConn, DbTableInfo } from "./db-conn";

export type SigReadAll = (sql: string) => Promise<Record<string, unknown>[]>;

interface CacheEntry { dataset: Dataset; sig: string; savedAt: number }
interface CacheFile { v: 1; label: string; tables: Record<string, CacheEntry> }

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export function cacheTtlMs(): number {
  const n = Number(process.env.T2UI_SCHEMA_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TTL_MS;
}

export function cacheEnabled(): boolean {
  return process.env.T2UI_SCHEMA_CACHE !== "0";
}

function cacheDir(): string {
  return path.join(process.env.T2UI_AUDIT_DIR || "./.t2ui", "schema-cache");
}

/** Stable per-connection identity. NEVER includes the password. */
export function connFingerprint(conn: Pick<DbConn, "dialect" | "host" | "port" | "database" | "user">): string {
  const raw = [conn.dialect, conn.host, String(conn.port ?? ""), conn.database, conn.user].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** Order-insensitive structural signature of one table's columns. */
export function tableSignature(cols: Array<{ name: string; type: string }>): string {
  return cols.map((c) => `${c.name}:${c.type}`).sort().join(",");
}

/** Live structural signatures via one cheap DESCRIBE per table (DuckDB syntax
 *  over the attach — dialect-agnostic). A failing DESCRIBE yields no signature,
 *  which downstream treats as a miss for that table. */
export async function catalogSignatures(readAll: SigReadAll, tables: DbTableInfo[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const t of tables) {
    try {
      const rows = await readAll(`DESCRIBE ${t.ref}`);
      const cols = rows.map((r) => ({ name: String(r.column_name ?? ""), type: String(r.column_type ?? "") }))
        .filter((c) => c.name);
      if (cols.length) out.set(t.name, tableSignature(cols));
    } catch { /* no signature → miss */ }
  }
  return out;
}

function fileFor(fp: string): string {
  return path.join(cacheDir(), `${fp}.json`);
}

function readCacheFile(fp: string): CacheFile | null {
  try {
    const parsed = JSON.parse(readFileSync(fileFor(fp), "utf8"));
    if (parsed?.v === 1 && parsed.tables && typeof parsed.tables === "object") return parsed as CacheFile;
  } catch { /* absent or corrupt → null */ }
  return null;
}

export interface CacheLookup { hits: Dataset[]; misses: string[]; note: string | null }

/** Serve cached datasets for `wanted` tables whose live signature matches and
 *  whose age is within TTL. Anything else is a miss. */
export function cacheLookup(fp: string, wanted: string[], liveSigs: Map<string, string>, ttlMs = cacheTtlMs(), now = Date.now()): CacheLookup {
  const file = readCacheFile(fp);
  const hits: Dataset[] = [];
  const misses: string[] = [];
  let oldest = 0;
  for (const name of wanted) {
    const e = file?.tables?.[name];
    const live = liveSigs.get(name);
    if (e && live && e.sig === live && now - e.savedAt <= ttlMs && e.dataset?.tableName === name) {
      hits.push(e.dataset);
      oldest = Math.max(oldest, now - e.savedAt);
    } else {
      misses.push(name);
    }
  }
  const note = hits.length
    ? `schema cache: ${hits.length} table profile(s) served from cache (age ≤ ${Math.ceil(oldest / 60000)} min; structure verified live). Stats may lag the data — use refresh to re-profile.`
    : null;
  return { hits, misses, note };
}

/** Write-through: merge freshly-introspected datasets (with their live
 *  signatures) into the connection's cache file. Best-effort by contract. */
export function cacheStore(fp: string, label: string, datasets: Dataset[], liveSigs: Map<string, string>, now = Date.now()): void {
  try {
    const file: CacheFile = readCacheFile(fp) ?? { v: 1, label, tables: {} };
    file.label = label;
    for (const d of datasets) {
      const sig = liveSigs.get(d.tableName);
      if (sig) file.tables[d.tableName] = { dataset: d, sig, savedAt: now };
    }
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(fileFor(fp), JSON.stringify(file));
  } catch { /* best-effort */ }
}
