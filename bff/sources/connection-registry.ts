// bff/sources/connection-registry.ts — runtime home for user-supplied MySQL
// connections (the SQL Workbench). Promotes the CLI-era mysql.ts to a service:
//
//   openConnection()  parse the URL, introspect (proves credentials + profiles the
//                     schema), and register the connection under an opaque id.
//   getHandle()       a LAZY, long-lived DuckDB attach for live text2SQL queries —
//                     opened on first query and reused, because the mysql-extension
//                     handshake costs seconds and a chat fires many queries.
//   publicView()      what the client may see. The password NEVER leaves this module
//                     (it lives only in the parsed MysqlConn and the DuckDB SECRET).
//
// In-memory with TTL sweep, per-tenant scoped — same posture as the other stores
// (spec/session/asset): swappable interface, durable persistence is a later step.
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type { AttachHandle } from "./mysql";
import {
  parseDbUrl, describeDbConn, introspectDb, attachDb, attachGroup,
  type DbConn, type DbTableInfo,
} from "./db-conn";
import type { Dataset } from "../../shared/types";
import { cacheEnabled, cacheLookup, cacheStore, catalogSignatures, connFingerprint, type SigReadAll } from "./schema-cache";

export interface ConnRecord {
  id: string;
  tenantId: string;
  conn: DbConn;                                      // server-side only — never serialized (dialect: mysql | postgres)
  label: string;                                     // safe: user@host:port/db (no password)
  createdAt: number;
  lastUsed: number;
  allTables: DbTableInfo[];                          // every table discovered (cheap), with exact SQL refs
  datasets: Dataset[];                               // profiled tables (schema + tiny samples)
  warnings: string[];
  /** Per-source data-plane choice (goal 3): "live" = query the database
   *  directly through the attach, store NOTHING; "snapshot" = extract-then-
   *  query (today's default path). Unset → the T2SQL_LIVE_SOURCE env default.
   *  Set at connect time or via POST /api/sql/:id/mode. */
  mode?: "live" | "snapshot";
  /** Lightweight circuit state (blueprint: "mark degraded, force reconnect"). */
  status: "active" | "degraded";
  consecutiveFailures: number;
  handle?: AttachHandle;                             // lazy live attach for queries
  handleP?: Promise<AttachHandle>;                   // in-flight open (dedupes concurrent first queries)
  /** al3: connection GROUP — several databases attached into one instance as
   *  src0, src1, … so queries can JOIN across them. Self-sufficient: the group
   *  holds member credentials + schemas and lives its own TTL. */
  groupParts?: GroupPart[];
  /** al2/al3: extra live views (materialized analyst findings) re-applied on
   *  every fresh handle; bump viewsVersion whenever these change. */
  extraViews?: { name: string; sql: string }[];
  viewsVersion?: number;
}

export interface GroupPart {
  conn: DbConn;
  label: string;
  allTables: DbTableInfo[];
  datasets: Dataset[];
}

const TTL_MS = Number(process.env.WB_CONN_TTL_MS ?? 4 * 3_600_000); // 4h idle default
const records = new Map<string, ConnRecord>();

function sweep(now = Date.now()): void {
  for (const [id, r] of records) {
    if (now - r.lastUsed > TTL_MS) {
      try { r.handle?.close(); } catch { /* already gone */ }
      records.delete(id);
    }
  }
}

/** Parse + introspect + register. Throws with a user-presentable message on bad
 *  URLs or failed handshakes (the route maps that to a 400). */
export async function openConnection(
  tenantId: string,
  connectionString: string,
  onPhase?: (msg: string) => void,
): Promise<ConnRecord> {
  return openConnectionWith(tenantId, parseDbUrl(connectionString), onPhase);
}

/** Fail-fast reachability probe BEFORE the (slow) extension/attach machinery.
 *  A silent drop (firewall / no route / VPN off) surfaces in ~4s with a
 *  network-specific message instead of a 20s+ generic attach timeout. */
export function preflightTcp(host: string, port: number, timeoutMs = Number(process.env.WB_PREFLIGHT_TIMEOUT_MS ?? 4000)): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const s = new Socket();
    const fail = (msg: string) => { s.destroy(); reject(new Error(msg)); };
    s.setTimeout(timeoutMs, () => fail(
      `cannot reach ${host}:${port} — TCP connect timed out after ${timeoutMs}ms. ` +
      `The host is not answering on that port (packets are being dropped): check that this server has a network route/VPN to ${host}, ` +
      `and that firewalls (on this machine, in between, and on the DB host) allow TCP ${port}.`,
    ));
    s.once("error", (e: any) => fail(
      e?.code === "ECONNREFUSED"
        ? `${host}:${port} answered but REFUSED the connection — the host is reachable, but nothing is listening on port ${port}. ` +
          `Check the database is running, listening on that port, and (Postgres) that listen_addresses covers this interface.`
        : `cannot reach ${host}:${port} — ${e?.message ?? e}`,
    ));
    s.connect(port, host, () => { s.end(); resolve(); });
  });
}

/** Same as openConnection but from an already-built DbConn (the structured
 *  Postgres form) — no string parsing, no encoding pitfalls. */
export async function openConnectionWith(
  tenantId: string,
  conn: DbConn,
  onPhase?: (msg: string) => void,
): Promise<ConnRecord> {
  sweep();
  onPhase?.(`checking ${conn.host}:${conn.port} is reachable…`);
  await preflightTcp(conn.host, conn.port);
  const result = await introspectDb(conn, { sampleRows: 5, maxTables: 40, onPhase });
  const rec: ConnRecord = {
    id: "conn_" + randomUUID().replace(/-/g, "").slice(0, 12),
    tenantId,
    conn,
    label: describeDbConn(conn),
    createdAt: Date.now(),
    lastUsed: Date.now(),
    allTables: result.allTables,
    datasets: result.datasets,
    warnings: result.warnings,
    status: "active",
    consecutiveFailures: 0,
  };
  records.set(rec.id, rec);
  return rec;
}

/** Register a prebuilt record (used by openConnectionWith; exported as the test
 *  seam for live-source tests, which register a record with a fake handle). */
export function registerConnection(rec: ConnRecord): ConnRecord {
  records.set(rec.id, rec);
  return rec;
}

/** al3: merge member schemas into one namespace. Aliases follow member order
 *  (src0, src1, …); table-name collisions get _2/_3 suffixes, and datasets are
 *  renamed in lockstep so views, planner, and widgets all agree on the names. */
export function mergeGroupParts(parts: GroupPart[]): { allTables: DbTableInfo[]; datasets: Dataset[] } {
  const taken = new Set<string>();
  const allTables: DbTableInfo[] = [];
  const datasets: Dataset[] = [];
  parts.forEach((p, i) => {
    const rename = new Map<string, string>();
    for (const t of p.allTables) {
      let name = t.name;
      for (let n = 2; taken.has(name); n++) name = `${t.name}_${n}`;
      taken.add(name);
      rename.set(t.name, name);
      allTables.push({ ...t, name, ref: `src${i}."${t.schema}"."${t.table}"` });
    }
    for (const d of p.datasets) {
      const name = rename.get(d.tableName) ?? d.tableName;
      datasets.push(name === d.tableName ? d : { ...d, tableName: name });
    }
  });
  return { allTables, datasets };
}

/** al3: bind several already-introspected databases into ONE group record that
 *  walks and talks like a connection — every downstream consumer (grounding,
 *  analyst, live views, liveQuery, source-chat) works over the union unchanged. */
export function openGroup(tenantId: string, parts: GroupPart[]): ConnRecord {
  if (parts.length < 2) throw new Error("a connection group needs at least two databases");
  const merged = mergeGroupParts(parts);
  const rec: ConnRecord = {
    id: "grp_" + randomUUID().replace(/-/g, "").slice(0, 12),
    tenantId,
    conn: parts[0].conn, // placeholder for shape; groups attach via groupParts
    label: parts.map((p) => p.label).join(" + "),
    createdAt: Date.now(),
    lastUsed: Date.now(),
    allTables: merged.allTables,
    datasets: merged.datasets,
    warnings: [],
    status: "active",
    consecutiveFailures: 0,
    groupParts: parts,
  };
  records.set(rec.id, rec);
  return rec;
}

/** Tenant-scoped lookup. Returns null (never throws) for missing/foreign ids. */
export function getConnection(tenantId: string, id: string): ConnRecord | null {
  sweep();
  const rec = records.get(id);
  if (!rec || rec.tenantId !== tenantId) return null;
  rec.lastUsed = Date.now();
  return rec;
}

/** The live attach for text2SQL queries. Lazy + cached; concurrent first callers
 *  share one open. On a dead handle the caller should closeConnectionHandle() and retry. */
export async function getHandle(rec: ConnRecord): Promise<AttachHandle> {
  if (rec.handle) return rec.handle;
  if (!rec.handleP) {
    const open = rec.groupParts?.length
      ? attachGroup(rec.groupParts.map((p) => p.conn), {})
      : attachDb(rec.conn, {});
    rec.handleP = open
      .then((h) => { rec.handle = h; return h; })
      .catch((e) => { rec.handleP = undefined; throw e; }); // don't cache failures
  }
  return rec.handleP;
}

/** Drop a (possibly dead) live attach so the next query reopens it. */
export function closeConnectionHandle(rec: ConnRecord): void {
  try { rec.handle?.close(); } catch { /* ignore */ }
  rec.handle = undefined;
  rec.handleP = undefined;
}

/** Two failed executions in a row (each already retried through a fresh attach)
 *  mark the connection degraded; the next success clears it. */
export function markExecution(rec: ConnRecord, ok: boolean): "active" | "degraded" {
  if (ok) { rec.consecutiveFailures = 0; rec.status = "active"; return rec.status; }
  rec.consecutiveFailures += 1;
  if (rec.consecutiveFailures >= 2) { rec.status = "degraded"; closeConnectionHandle(rec); }
  return rec.status;
}

/** The shape the client is allowed to see. No conn, no password, no handle. */
export function publicView(rec: ConnRecord) {
  return {
    connectionId: rec.id,
    status: rec.status,
    mode: rec.mode ?? null,
    label: rec.label,
    allTables: rec.allTables,
    datasets: rec.datasets,
    warnings: rec.warnings,
    ...(rec.groupParts ? { members: rec.groupParts.map((g) => g.label) } : {}),
  };
}

/** Profile additional tables on demand (e.g. the user expands one we skipped at
 *  connect time). Merges into rec.datasets, deduped by tableName. */
/** Profile the requested tables, serving from the schema cache where the live
 *  structure signature matches (see schema-cache.ts for the correctness rules).
 *  `opts.refresh` bypasses the cache read (a fresh introspection re-populates
 *  it); `opts.deps` injects the introspector and signature reader for offline
 *  tests. Total: any cache/signature failure degrades to a full introspection. */
export async function profileTables(
  rec: ConnRecord, tables: string[],
  opts: { refresh?: boolean; deps?: { introspect?: typeof introspectDb; sigReadAll?: SigReadAll } } = {},
): Promise<Dataset[]> {
  const need0 = tables.filter((t) => !rec.datasets.some((d) => d.tableName === t));
  if (need0.length) {
    const introspect = opts.deps?.introspect ?? introspectDb;
    const fp = connFingerprint(rec.conn);
    let need = need0;
    let sigs: Map<string, string> | null = null;

    const sigsFor = async (names: string[]): Promise<Map<string, string>> => {
      const infos = rec.allTables.filter((t) => names.includes(t.name));
      const readAll: SigReadAll = opts.deps?.sigReadAll
        ?? (async (sql) => { const h = await getHandle(rec); return h.readAll(sql, "schema-cache signature"); });
      return catalogSignatures(readAll, infos);
    };

    if (cacheEnabled() && !opts.refresh) {
      try {
        sigs = await sigsFor(need0);
        const { hits, misses, note } = cacheLookup(fp, need0, sigs);
        if (hits.length) {
          rec.datasets = [...rec.datasets, ...hits];
          if (note) { rec.warnings.push(note); console.log(`[schema-cache] ${rec.id}: ${note}`); }
        }
        need = misses;
      } catch { need = need0; }
    }

    if (need.length) {
      const r = await introspect(rec.conn, { tables: need, sampleRows: 5 });
      rec.datasets = [...rec.datasets, ...r.datasets];
      rec.warnings.push(...r.warnings);
      if (cacheEnabled()) {
        try {
          if (!sigs) sigs = await sigsFor(need);
          cacheStore(fp, rec.label, r.datasets, sigs);
        } catch { /* best-effort write-through */ }
      }
    }
  }
  return rec.datasets.filter((d) => tables.includes(d.tableName));
}
