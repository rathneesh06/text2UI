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
  parseDbUrl, describeDbConn, introspectDb, attachDb,
  type DbConn, type DbTableInfo,
} from "./db-conn";
import type { Dataset } from "../../shared/types";

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
  /** Lightweight circuit state (blueprint: "mark degraded, force reconnect"). */
  status: "active" | "degraded";
  consecutiveFailures: number;
  handle?: AttachHandle;                             // lazy live attach for queries
  handleP?: Promise<AttachHandle>;                   // in-flight open (dedupes concurrent first queries)
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
    rec.handleP = attachDb(rec.conn, {})
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
    label: rec.label,
    allTables: rec.allTables,
    datasets: rec.datasets,
    warnings: rec.warnings,
  };
}

/** Profile additional tables on demand (e.g. the user expands one we skipped at
 *  connect time). Merges into rec.datasets, deduped by tableName. */
export async function profileTables(rec: ConnRecord, tables: string[]): Promise<Dataset[]> {
  const need = tables.filter((t) => !rec.datasets.some((d) => d.tableName === t));
  if (need.length) {
    const r = await introspectDb(rec.conn, { tables: need, sampleRows: 5 });
    rec.datasets = [...rec.datasets, ...r.datasets];
    rec.warnings.push(...r.warnings);
  }
  return rec.datasets.filter((d) => tables.includes(d.tableName));
}
