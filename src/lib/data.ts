// data.ts — pipeline stage 4a (BROWSER, host-side factory).
// Produces the files that get injected into the Sandpack sandbox so the
// generated app can `import { rows, query } from "./data"`.
//
// Two files are emitted:
//   /data.js  — fixed engine: re-exports rows + a DuckDB-WASM `query(sql)`.
//   /rows.js  — the user's data as a JS literal (the only dynamic part).
// Keeping data dynamic-only-in-rows.js means the engine never needs templating.

// npm deps the sandbox must install for the data layer to work.
export const DATA_RUNTIME_DEPS: Record<string, string> = {
  "@duckdb/duckdb-wasm": "1.32.0", // pinned: npm's `latest` tag points to unstable -dev builds
};

// The engine module. Constant — no interpolation, no backticks, no ${}.
// Verified against DuckDB-WASM's jsDelivr instantiation pattern.
const DATA_ENGINE_SRC = `import * as duckdb from "@duckdb/duckdb-wasm";
import { tables } from "./rows.js";

// Named datasets, keyed by table name. \`rows\` is the first table, so
// single-dataset apps can keep using a plain rows array.
export { tables };
const _names = Object.keys(tables);
export const rows = _names.length ? tables[_names[0]] : [];

let _conn = null;
let _initPromise = null;

async function init() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob(['importScripts("' + bundle.mainWorker + '");'], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  const conn = await db.connect();
  for (const name of _names) {
    await db.registerFileText(name + ".json", JSON.stringify(tables[name]));
    await conn.query('CREATE TABLE "' + name + '" AS SELECT * FROM read_json_auto(\\'' + name + '.json\\')');
  }
  return conn;
}

function normalizeRow(row) {
  const obj = typeof row.toJSON === "function" ? row.toJSON() : Object.assign({}, row);
  for (const k in obj) {
    if (typeof obj[k] === "bigint") obj[k] = Number(obj[k]); // BigInt -> Number for charts/JSON
  }
  return obj;
}

// Run SQL over any registered table. Lazily boots DuckDB on first call.
export async function query(sql) {
  if (!_initPromise) {
    _initPromise = init().then((c) => { _conn = c; });
  }
  await _initPromise;
  const result = await _conn.query(sql);
  return result.toArray().map(normalizeRow);
}
`;

/** One uploaded file's data, destined for one SQL table. */
export interface TableData {
  tableName: string;
  rows: Record<string, unknown>[];
}

/** Build the sandbox file map for the data layer from one or more tables. */
export function dataModuleFiles(tables: TableData[]): Record<string, string> {
  const byName: Record<string, Record<string, unknown>[]> = {};
  for (const t of tables) byName[t.tableName] = t.rows;
  return {
    "/data.js": DATA_ENGINE_SRC,
    "/rows.js": `export const tables = ${JSON.stringify(byName)};\n`,
  };
}
/* ==== Remote data layer (M1 backend) =======================================
   When the BFF stores the data (DuckDB server-side), the sandbox gets a thin
   /data.js whose query() POSTs to /api/query. No rows are inlined, no DuckDB-
   WASM boots in the browser, and the data layer needs zero npm deps. */

export interface RemoteDataConfig {
  bffUrl: string;
  projectId: string;
}

export function remoteDataModuleFiles(cfg: RemoteDataConfig): Record<string, string> {
  const src = `// data.js (remote) — all data access goes through the BFF's /api/query.
//
// TRANSPORT: the sandbox preview runs on a foreign (https) iframe origin, and
// browsers can block its direct fetches to http://localhost (CORS aside — mixed
// content and private-network rules apply too). So queries ride the SAME
// postMessage bridge the widget-click events already use: the sandbox asks the
// HOST page, the host (same-site with the BFF) performs the fetch, and posts the
// rows back. Direct fetch remains as the fallback so downloaded/standalone apps
// (no host page) and older hosts keep working unchanged.
const BFF = ${JSON.stringify(cfg.bffUrl)};
const PROJECT = ${JSON.stringify(cfg.projectId)};
const BRIDGE_TIMEOUT_MS = 6000;

// Remote mode serves data via query(). \`rows\`/\`tables\` are empty stubs so apps
// that import them still build; use query() for data access in remote mode.
export const tables = {};
export const rows = [];

const pending = new Map();
let listening = false;
let seq = 0;

function ensureListener() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("message", function (e) {
    const d = e && e.data;
    if (!d || d.type !== "t2ui.queryResult" || !pending.has(d.id)) return;
    const p = pending.get(d.id);
    pending.delete(d.id);
    clearTimeout(p.timer);
    if (d.ok) p.resolve(d.rows);
    else p.reject(new Error(d.error || "query failed"));
  });
}

function bridgeAvailable() {
  try { return typeof window !== "undefined" && window.parent && window.parent !== window; }
  catch (_e) { return false; }
}

function queryViaBridge(sql) {
  ensureListener();
  return new Promise(function (resolve, reject) {
    const id = "q" + (++seq) + "_" + Math.random().toString(36).slice(2, 8);
    const timer = setTimeout(function () {
      pending.delete(id);
      reject(new Error("bridge timeout"));
    }, BRIDGE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ type: "t2ui.query", id: id, projectId: PROJECT, sql: sql }, "*");
  });
}

async function queryViaFetch(sql) {
  const res = await fetch(BFF + "/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: PROJECT, sql }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || ("query failed: HTTP " + res.status));
  if (json.truncated) console.warn("[data] result truncated by the server row cap");
  return json.rows;
}

export async function query(sql) {
  if (bridgeAvailable()) {
    try { return await queryViaBridge(sql); }
    catch (e) {
      // Host not listening (old host, or opened standalone in a frame) — fall through.
      if (!(e && e.message === "bridge timeout")) throw e;
      console.warn("[data] query bridge unavailable, falling back to direct fetch");
    }
  }
  return queryViaFetch(sql);
}
`;
  return { "/data.js": src };
}