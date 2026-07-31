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
  parseDbUrl, describeDbConn, introspectDb, attachDb, attachGroup, refFor,
  type DbConn, type DbTableInfo,
} from "./db-conn";
import { nativeListTables } from "./native-catalog";
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
  /** STABLE member id, generated once when this database is opened and never
   *  reused. Everything persisted — dependency members, staged-dataset origins —
   *  keys on this, NOT on the member's position.
   *
   *  `src{i}` is assigned positionally at attach time, so removing a member
   *  renumbers every member after it. Keying durable state on a position means a
   *  stored dependency silently starts describing a different database the first
   *  time someone closes a tab. Positions are derived from ids at attach
   *  (memberIndexById); nothing durable holds one. */
  id: string;
  conn: DbConn;
  label: string;
  allTables: DbTableInfo[];
  datasets: Dataset[];
}

/** Fresh stable member id. Separate from ConnRecord ids so a member keeps its
 *  identity even if the record it came from is gone. */
export const newMemberId = (): string => "mem_" + randomUUID().replace(/-/g, "").slice(0, 12);

/** id -> current positional index (`src{i}`), built at attach time. The ONLY
 *  place positions are allowed to come from. */
export function memberIndexById(parts: GroupPart[]): Map<string, number> {
  return new Map(parts.map((p, i) => [p.id, i]));
}

/** The attach-time catalog name for a member id, or null if it isn't in this
 *  group any more (a removed member — callers must handle that, not assume). */
export function catalogForMember(parts: GroupPart[], id: string): string | null {
  const i = memberIndexById(parts).get(id);
  return i === undefined ? null : `src${i}`;
}

/** Inverse: which member id currently sits at `src{i}`. Used to translate an
 *  attach-time catalog back to something durable at snapshot time. */
export function memberIdForCatalog(parts: GroupPart[], catalog: string): string | null {
  const m = /^src(\d+)$/.exec(catalog);
  if (!m) return null;
  return parts[Number(m[1])]?.id ?? null;
}

const TTL_MS = Number(process.env.WB_CONN_TTL_MS ?? 4 * 3_600_000); // 4h idle default
const records = new Map<string, ConnRecord>();

function sweep(now = Date.now()): void {
  for (const [id, r] of records) {
    if (now - r.lastUsed > TTL_MS) {
      try { r.handle?.close(); } catch { /* already gone */ }
      records.delete(id);
      // The override outlives nothing: once the record is gone its surviving-member
      // id is unreachable, and leaving it behind grows the map for the life of the
      // process (one entry per group that ever degraded to a single member).
      soloIdOverride.delete(id);
    }
  }
}

/** Parse + introspect + register. Throws with a user-presentable message on bad
 *  URLs or failed handshakes (the route maps that to a 400). */
export async function openConnection(
  tenantId: string,
  connectionString: string,
  onPhase?: (msg: string) => void,
  opts: OpenOptions = {},
): Promise<ConnRecord> {
  return openConnectionWith(tenantId, parseDbUrl(connectionString), onPhase, opts);
}

/** `fast`: list table NAMES only — no per-table sampling, no whole-catalog column
 *  metadata, no information_schema row counts. On a big MySQL server those three
 *  steps are the entire connect latency, and the selection page needs none of
 *  them up front: it profiles a table the moment you click it. */
export interface OpenOptions { fast?: boolean }

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
  opts: OpenOptions = {},
): Promise<ConnRecord> {
  sweep();
  onPhase?.(`checking ${conn.host}:${conn.port} is reachable…`);
  await preflightTcp(conn.host, conn.port);
  // FAST: browse natively (one protocol connection, one catalog query) instead
  // of going through DuckDB's ATTACH, which materialises the whole remote
  // catalog before it returns — minutes on a 12k-table server. See
  // native-catalog.ts for the full reasoning.
  const result = opts.fast
    ? await (async () => {
        onPhase?.("listing tables…");
        const tables = await nativeListTables(conn);
        onPhase?.(`discovered ${tables.length} table(s).`);
        return {
          datasets: [],
          warnings: [],
          allTables: tables.map((t) => ({
            name: t.name,
            schema: conn.dialect === "mysql" ? conn.database : (t.name.includes(".") ? t.name.slice(0, t.name.indexOf(".")) : "public"),
            table: t.name.includes(".") ? t.name.slice(t.name.indexOf(".") + 1) : t.name,
            ref: refFor(
              conn.dialect === "mysql" ? conn.database : (t.name.includes(".") ? t.name.slice(0, t.name.indexOf(".")) : "public"),
              t.name.includes(".") ? t.name.slice(t.name.indexOf(".") + 1) : t.name,
            ),
            approxRows: t.approxRows ?? 0,
          })),
        };
      })()
    : await introspectDb(conn, { sampleRows: 5, maxTables: 40, onPhase });
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

/**
 * Remove one database from a group, keyed on its STABLE id.
 *
 * Every surviving member keeps its `id` byte-identical — that is the whole point
 * of the ids. Only the attach-time positions shift (the member that was src1
 * becomes src0), and nothing durable stores those. The record id is preserved
 * too, so the client's connectionId stays valid.
 *
 * Degrades in two steps, deliberately matching what a lone connection already
 * looks like so callers need no special case:
 *   1 member left  -> a plain connection record (groupParts dropped)
 *   0 members left -> the record is closed and removed entirely
 *
 * Returns the surviving record, or null when the connection is gone.
 */
export function removeGroupMember(rec: ConnRecord, memberId: string): {
  rec: ConnRecord | null;
  removed: GroupPart | null;
  removedTables: string[];
} {
  const parts = rec.groupParts?.length
    ? rec.groupParts
    // A lone connection is conceptually a one-member group; removing "its" member
    // must behave exactly like removing the last member of a real group.
    : [{ id: soloMemberId(rec), conn: rec.conn, label: rec.label, allTables: rec.allTables, datasets: rec.datasets }];

  const idx = parts.findIndex((p) => p.id === memberId);
  if (idx === -1) return { rec, removed: null, removedTables: [] };

  const removed = parts[idx];
  // Merged display names, which is what a selection stores.
  const removedTables = rec.groupParts?.length
    ? rec.allTables.filter((t) => memberIdForCatalog(parts, t.ref.split(".")[0]) === memberId).map((t) => t.name)
    : rec.allTables.map((t) => t.name);
  const rest = parts.filter((_, i) => i !== idx);

  // The names the SURVIVORS currently answer to. Re-merging from scratch would
  // reassign them: `users_2` only carries a suffix because the removed member
  // also had a `users`, so dropping that member renames the survivor's table
  // back to `users` — silently invalidating every tick and column projection
  // stored against the old name. Removing A must not rename B's tables.
  // Read the names ACTUALLY in use, rather than re-deriving them by replaying the
  // merge: after an earlier removal the live names no longer match what a fresh
  // merge would produce (drop B from A/B/C and C stays `users_3`, though a replay
  // would now call it `users_2`). Re-deriving reintroduces the rename one removal
  // later — which is precisely what member-removal.test.ts caught.
  const preferred = new Map<string, string>();
  {
    const solo = !rec.groupParts?.length;
    for (const t of rec.allTables) {
      const mid = solo ? parts[0].id : memberIdForCatalog(parts, t.ref.split(".")[0]);
      if (mid) preferred.set(`${mid} ${t.schema}.${t.table}`, t.name);
    }
  }

  if (!rest.length) {
    closeConnectionHandle(rec);
    records.delete(rec.id);
    soloIdOverride.delete(rec.id); // nothing left to be addressable as
    return { rec: null, removed, removedTables };
  }

  // The attach changes shape, so any open handle is stale.
  closeConnectionHandle(rec);
  rec.viewsVersion = (rec.viewsVersion ?? 0) + 1;

  if (rest.length === 1) {
    const only = rest[0];
    // Plain connection again, so refs revert to `src.` — but the DISPLAY NAMES
    // stay as they were, or the survivor's selection breaks.
    const rename = new Map<string, string>();
    rec.allTables = only.allTables.map((t) => {
      const name = preferred.get(`${only.id} ${t.schema}.${t.table}`) ?? t.name;
      rename.set(t.name, name);
      return { ...t, name };
    });
    rec.datasets = only.datasets.map((d) => {
      const name = rename.get(d.tableName) ?? d.tableName;
      return name === d.tableName ? d : { ...d, tableName: name };
    });
    rec.conn = only.conn;
    rec.label = only.label;
    rec.groupParts = undefined; // now a plain connection — but `only.id` lives on
    // Keep the surviving member addressable under the id it already had.
    soloIdOverride.set(rec.id, only.id);
    return { rec, removed, removedTables };
  }

  // Same rule for a still-multi group: positions shift (src1 becomes src0), names
  // must not.
  const taken = new Set<string>();
  const allTables: DbTableInfo[] = [];
  const datasets: Dataset[] = [];
  rest.forEach((p, i) => {
    const rename = new Map<string, string>();
    for (const t of p.allTables) {
      let name = preferred.get(`${p.id} ${t.schema}.${t.table}`) ?? t.name;
      if (taken.has(name)) { const b = name; for (let n = 2; taken.has(name); n++) name = `${b}_${n}`; }
      taken.add(name);
      rename.set(t.name, name);
      allTables.push({ ...t, name, ref: `src${i}."${t.schema}"."${t.table}"` });
    }
    for (const d of p.datasets) {
      const name = rename.get(d.tableName) ?? d.tableName;
      datasets.push(name === d.tableName ? d : { ...d, tableName: name });
    }
  });
  rec.conn = rest[0].conn;
  rec.label = rest.map((p) => p.label).join(" + ");
  rec.allTables = allTables;
  rec.datasets = datasets;
  rec.groupParts = rest;
  return { rec, removed, removedTables };
}

/** When a group degrades to one member, that member keeps the id it already had
 *  rather than being handed a fresh solo id — otherwise removing a sibling would
 *  silently change the survivor's identity, which is the exact bug the stable
 *  ids prevent. */
const soloIdOverride = new Map<string, string>();

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

/** A single (non-group) connection still gets ONE member, so the client has one
 *  uniform shape instead of a special case. Derived from the record id, so it is
 *  stable for the life of the connection. */
export const soloMemberId = (rec: ConnRecord): string =>
  soloIdOverride.get(rec.id) ?? `solo_${rec.id}`;

/** The shape the client is allowed to see. No conn, no password, no handle.
 *
 *  `memberId` is stamped onto every table HERE, server-side, from the table's
 *  `ref` (src{i}.…). The client must never parse `src{i}` itself: that index is
 *  attach-scoped and shifts the moment a member is removed, which is exactly
 *  what the stable ids exist to prevent. Position stays on this side of the wire. */
export function publicView(rec: ConnRecord) {
  const parts = rec.groupParts;
  const members = parts?.length
    ? parts.map((g) => ({ id: g.id, label: g.label }))
    : [{ id: soloMemberId(rec), label: rec.label }];

  const solo = !parts?.length;
  const allTables = rec.allTables.map((t) => ({
    ...t,
    // A solo connection's refs carry no src{i} prefix — every table is its one member.
    memberId: solo ? soloMemberId(rec) : (memberIdForCatalog(parts!, t.ref.split(".")[0]) ?? null),
  }));

  return {
    connectionId: rec.id,
    status: rec.status,
    mode: rec.mode ?? null,
    label: rec.label,
    allTables,
    datasets: rec.datasets,
    warnings: rec.warnings,
    members,
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
