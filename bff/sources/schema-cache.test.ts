// bff/sources/schema-cache.test.ts — the schema-graph cache, fully offline.
// Style: plain node:assert, one ✅ per group, injectable everything.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Dataset } from "../../shared/types";
import type { DbTableInfo } from "./db-conn";

// Point the cache at a throwaway dir BEFORE importing anything that reads env.
const DIR = mkdtempSync(path.join(tmpdir(), "t2ui-schema-cache-"));
process.env.T2UI_AUDIT_DIR = DIR;
delete process.env.T2UI_SCHEMA_CACHE;
delete process.env.T2UI_SCHEMA_CACHE_TTL_MS;

const { connFingerprint, tableSignature, catalogSignatures, cacheLookup, cacheStore, cacheTtlMs } =
  await import("./schema-cache");

const ds = (tableName: string, cols: Array<[string, string]>, rowCount = 10): Dataset => ({
  tableName,
  profile: {
    source: { filename: tableName, format: "csv" }, rowCount,
    columns: cols.map(([name, type]) => ({ name, type: type as any, uniqueCount: 3, nullCount: 0, sampleValues: [] })),
    sampleRows: [],
  },
} as any);

const info = (name: string): DbTableInfo => ({ name, schema: "db", table: name, ref: `src."db"."${name}"`, approxRows: 10 });

// ---- 1. fingerprint: stable, password-free -----------------------------------------
{
  const base = { dialect: "mysql" as const, host: "h", port: 3306, database: "db", user: "u" };
  assert.equal(connFingerprint(base), connFingerprint({ ...base }), "stable across calls");
  assert.equal(connFingerprint({ ...base, password: "secret1" } as any), connFingerprint({ ...base, password: "other" } as any),
    "password NEVER affects the fingerprint");
  assert.notEqual(connFingerprint(base), connFingerprint({ ...base, user: "v" }), "user does");
  assert.notEqual(connFingerprint(base), connFingerprint({ ...base, dialect: "postgres" as const }), "dialect does");
  assert.ok(/^[0-9a-f]{16}$/.test(connFingerprint(base)), "compact hex id");
}
console.log("schema-cache: fingerprint stable + secret-free ✅");

// ---- 2. table signature: order-insensitive, type-sensitive -------------------------
{
  assert.equal(tableSignature([{ name: "a", type: "INT" }, { name: "b", type: "TEXT" }]),
    tableSignature([{ name: "b", type: "TEXT" }, { name: "a", type: "INT" }]), "column order irrelevant");
  assert.notEqual(tableSignature([{ name: "a", type: "INT" }]), tableSignature([{ name: "a", type: "TEXT" }]),
    "type change changes the signature");
}
console.log("schema-cache: structural signature ✅");

// ---- 3. catalogSignatures: one DESCRIBE per table, failures = no signature ----------
{
  const seen: string[] = [];
  const readAll = async (sql: string) => {
    seen.push(sql);
    if (sql.includes('"bad"')) throw new Error("boom");
    return [{ column_name: "id", column_type: "BIGINT" }, { column_name: "name", column_type: "VARCHAR" }];
  };
  const sigs = await catalogSignatures(readAll, [info("tickets"), info("bad")]);
  assert.equal(seen.length, 2, "one DESCRIBE per table");
  assert.ok(seen[0].startsWith("DESCRIBE src."), "DuckDB DESCRIBE over the attach ref");
  assert.equal(sigs.get("tickets"), tableSignature([{ name: "id", type: "BIGINT" }, { name: "name", type: "VARCHAR" }]));
  assert.equal(sigs.get("bad"), undefined, "failed DESCRIBE yields no signature (→ miss)");
}
console.log("schema-cache: live signatures via DESCRIBE ✅");

// ---- 4. store → lookup round-trip; sig mismatch and TTL invalidate precisely --------
{
  const fp = "aaaabbbbccccdddd";
  const sig = new Map([["tickets", "id:BIGINT,status:VARCHAR"], ["orders", "id:BIGINT"]]);
  cacheStore(fp, "u@h/db", [ds("tickets", [["id", "integer"], ["status", "string"]]), ds("orders", [["id", "integer"]])], sig);

  // straight hit for both
  let r = cacheLookup(fp, ["tickets", "orders"], sig);
  assert.equal(r.hits.length, 2, "both served from cache");
  assert.equal(r.misses.length, 0);
  assert.ok(r.note?.includes("structure verified live"), "hit is said out loud: " + r.note);

  // per-table signature mismatch: only that table misses
  const drifted = new Map([["tickets", "id:BIGINT,status:VARCHAR,priority:VARCHAR"], ["orders", "id:BIGINT"]]);
  r = cacheLookup(fp, ["tickets", "orders"], drifted);
  assert.deepEqual(r.misses, ["tickets"], "schema drift invalidates exactly the drifted table");
  assert.equal(r.hits[0].tableName, "orders", "sibling still hits");

  // absent live signature (DESCRIBE failed): miss — never trust structure blind
  r = cacheLookup(fp, ["tickets"], new Map());
  assert.deepEqual(r.misses, ["tickets"], "no live signature → no cache serve");

  // TTL expiry
  r = cacheLookup(fp, ["orders"], sig, 1000, Date.now() + 60_000);
  assert.deepEqual(r.misses, ["orders"], "stale beyond TTL → miss");
  assert.equal(cacheTtlMs(), 6 * 60 * 60 * 1000, "default TTL 6h");

  // unknown fingerprint / corrupt file: all misses, never throws
  r = cacheLookup("0000000000000000", ["tickets"], sig);
  assert.deepEqual(r.misses, ["tickets"], "unknown source → miss");
  mkdirSync(path.join(DIR, "schema-cache"), { recursive: true });
  writeFileSync(path.join(DIR, "schema-cache", "feedfeedfeedfeed.json"), "{not json");
  r = cacheLookup("feedfeedfeedfeed", ["tickets"], sig);
  assert.deepEqual(r.misses, ["tickets"], "corrupt cache file degrades to miss");

  // write-through merge: a second store keeps the sibling
  cacheStore(fp, "u@h/db", [ds("tickets", [["id", "integer"], ["status", "string"], ["priority", "string"]])], drifted);
  r = cacheLookup(fp, ["tickets", "orders"], drifted);
  assert.equal(r.hits.length, 2, "re-store merged; sibling preserved");
  const raw = JSON.parse(readFileSync(path.join(DIR, "schema-cache", `${fp}.json`), "utf8"));
  assert.equal(raw.v, 1);
  assert.ok(!JSON.stringify(raw).includes("secret"), "no secrets ever stored");
}
console.log("schema-cache: round-trip + precise invalidation ✅");

// ---- 5. registry integration: profileTables hits cache across records ---------------
{
  const { registerConnection, profileTables } = await import("./connection-registry");
  const conn: any = { dialect: "mysql", host: "h2", port: 3306, user: "u", password: "pw", database: "db" };
  const TABLES = [info("tickets")];
  const REC = () => registerConnection({
    id: `live_${Math.random().toString(36).slice(2)}`, tenantId: "t", conn, label: "u@h2/db",
    createdAt: Date.now(), lastUsed: Date.now(), allTables: TABLES, datasets: [], warnings: [],
    status: "active", consecutiveFailures: 0,
  } as any);
  const sigReadAll = async () => [{ column_name: "id", column_type: "BIGINT" }];
  let introspections = 0;
  const introspect = (async () => {
    introspections++;
    return { datasets: [ds("tickets", [["id", "integer"]], 42)], allTables: TABLES, warnings: [] };
  }) as any;

  // cold: introspects once and writes through
  const a = await profileTables(REC(), ["tickets"], { deps: { introspect, sigReadAll } });
  assert.equal(introspections, 1, "cold profile introspects");
  assert.equal(a[0].profile.rowCount, 42);

  // fresh record, same connection: served from cache — NO introspection
  const rec2 = REC();
  const b = await profileTables(rec2, ["tickets"], { deps: { introspect, sigReadAll } });
  assert.equal(introspections, 1, "warm profile does NOT introspect");
  assert.equal(b[0].profile.rowCount, 42, "cached dataset served");
  assert.ok(rec2.warnings.some((w) => w.includes("schema cache")), "cache hit disclosed in warnings");

  // refresh bypasses the read and re-populates
  await profileTables(REC(), ["tickets"], { refresh: true, deps: { introspect, sigReadAll } });
  assert.equal(introspections, 2, "refresh re-introspects");

  // schema drift: live DESCRIBE disagrees → re-introspects
  const driftedRead = async () => [{ column_name: "id", column_type: "BIGINT" }, { column_name: "extra", column_type: "VARCHAR" }];
  await profileTables(REC(), ["tickets"], { deps: { introspect, sigReadAll: driftedRead } });
  assert.equal(introspections, 3, "drifted structure is never served from cache");

  // disabled: no reads, no writes
  process.env.T2UI_SCHEMA_CACHE = "0";
  await profileTables(REC(), ["tickets"], { deps: { introspect, sigReadAll } });
  assert.equal(introspections, 4, "T2UI_SCHEMA_CACHE=0 always introspects");
  delete process.env.T2UI_SCHEMA_CACHE;

  // signature reader failing entirely: total contract — full introspection, no throw
  const boom = async () => { throw new Error("no handle"); };
  await profileTables(REC(), ["tickets"], { deps: { introspect, sigReadAll: boom } });
  assert.equal(introspections, 5, "signature failure degrades to full introspection");
}
console.log("schema-cache: registry integration (hit/refresh/drift/disable) ✅");

console.log("schema-cache.test.ts: all assertions passed ✅");
