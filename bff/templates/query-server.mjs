// Standalone read-only query server for a text2UI "connected" bundle.
// Serves POST /api/query against YOUR Postgres database, behind a read-only SQL
// guard (mirrors text2UI's bff/storage/guard.ts). The exported app's remote data
// layer posts { projectId, sql } here and expects { rows, truncated }.
//
// Usage:
//   npm install
//   $env:DATABASE_URL="postgres://user:pass@host:5432/dbname"   (PowerShell)
//   export DATABASE_URL="postgres://user:pass@host:5432/dbname" (bash)
//   npm start
import { createServer } from "node:http";
import pg from "pg";

const PORT = Number(process.env.PORT ?? 8787);
const DATABASE_URL = process.env.DATABASE_URL ?? process.env.PG_URL;
const ROW_CAP = Number(process.env.QUERY_ROW_CAP ?? 10000);

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL (or PG_URL). Set it to your Postgres connection string.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// ---- read-only SQL guard (mirrors text2UI bff/storage/guard.ts) ----
const READ_FIRST = new Set(["SELECT", "WITH", "FROM", "DESCRIBE", "SUMMARIZE", "SHOW"]);
const BANNED = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "CREATE", "DROP", "ALTER",
  "ATTACH", "DETACH", "USE", "COPY", "EXPORT", "IMPORT", "INSTALL", "LOAD",
  "SET", "RESET", "PRAGMA", "CALL", "BEGIN", "COMMIT", "ROLLBACK", "VACUUM",
  "CHECKPOINT", "GRANT", "REVOKE",
];
const BANNED_RE = new RegExp("\\b(" + BANNED.join("|") + ")\\b", "i");

function stripSqlNoise(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < n) { if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } if (sql[i] === "'") { i++; break; } i++; }
      out += " ";
    } else if (c === '"') {
      i++;
      while (i < n) { if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; } if (sql[i] === '"') { i++; break; } i++; }
      out += " ";
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function assertReadOnly(sql) {
  let stripped = stripSqlNoise(sql).trim();
  while (stripped.endsWith(";")) stripped = stripped.slice(0, -1).trim();
  if (!stripped) throw new Error("empty SQL");
  if (stripped.includes(";")) throw new Error("only a single SQL statement is allowed");
  const first = (stripped.match(/^[A-Za-z_]+/) || [""])[0].toUpperCase();
  if (!READ_FIRST.has(first)) throw new Error('only read statements are allowed (got "' + (first || "?") + '")');
  const banned = stripped.match(BANNED_RE);
  if (banned) throw new Error("statement contains a non-read-only keyword: " + banned[0].toUpperCase());
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && req.url === "/health") { send(res, 200, { ok: true }); return; }
  if (req.method !== "POST" || !req.url.startsWith("/api/query")) { send(res, 404, { error: "not found" }); return; }

  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", async () => {
    let sql;
    try {
      const parsed = JSON.parse(body || "{}");
      sql = parsed.sql;
      if (typeof sql !== "string" || !sql.trim()) throw new Error("sql is required");
      assertReadOnly(sql);
    } catch (e) {
      send(res, 400, { error: e.message });
      return;
    }

    let q = sql.trim();
    while (q.endsWith(";")) q = q.slice(0, -1).trim();
    const capped = "SELECT * FROM (" + q + ") AS _t LIMIT " + (ROW_CAP + 1);
    try {
      const r = await pool.query(capped);
      const truncated = r.rows.length > ROW_CAP;
      send(res, 200, { rows: r.rows.slice(0, ROW_CAP), truncated });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });
});

server.listen(PORT, () => console.log("query server on http://localhost:" + PORT + " (read-only)"));
