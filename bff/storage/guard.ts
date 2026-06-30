// storage/guard.ts — read-only SQL guard for /api/query.
//
// Why a classifier and not a read-only connection: DuckDB forbids opening the
// same database file twice in one process, so we can't hold a separate
// READ_ONLY connection next to the read-write one. A strict classifier is the
// alternative — and unlike a connection mode, it ports to Postgres unchanged.
//
// Strategy: strip everything that can hide keywords (string literals, quoted
// identifiers, comments), then (1) require a single statement, (2) require the
// first keyword to be a read verb, (3) reject any write/DDL/session keyword
// anywhere. Valid SQL can't trip false positives on (3): reserved words used
// as identifiers must be quoted, and quoted regions are stripped before the scan.

const READ_FIRST_KEYWORDS = new Set(["SELECT", "WITH", "FROM", "DESCRIBE", "SUMMARIZE", "SHOW"]);

const BANNED_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE",          // DML writes
  "CREATE", "DROP", "ALTER",                                   // DDL
  "ATTACH", "DETACH", "USE",                                   // catalog/scope escape
  "COPY", "EXPORT", "IMPORT", "INSTALL", "LOAD",               // filesystem / extensions
  "SET", "RESET", "PRAGMA", "CALL",                            // session / procedures
  "BEGIN", "COMMIT", "ROLLBACK", "VACUUM", "CHECKPOINT",       // txn / maintenance
  "GRANT", "REVOKE",                                           // (Postgres-era) ACL
];
const BANNED_RE = new RegExp(`\\b(${BANNED_KEYWORDS.join("|")})\\b`, "i");

/** Remove string literals, quoted identifiers, and comments (keeps everything else). */
export function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      // string literal; '' is an escaped quote inside it
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += " ";
    } else if (c === '"') {
      // quoted identifier; "" is an escaped quote inside it
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
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

/** Throws with a clear reason unless `sql` is a single read-only statement. */
export function assertReadOnly(sql: string): void {
  const stripped = stripSqlNoise(sql).trim().replace(/;\s*$/, "");
  if (!stripped) throw new Error("empty SQL");
  if (stripped.includes(";")) {
    throw new Error("only a single SQL statement is allowed");
  }
  const first = (stripped.match(/^[A-Za-z_]+/) || [""])[0].toUpperCase();
  if (!READ_FIRST_KEYWORDS.has(first)) {
    throw new Error(`only read statements are allowed (got "${first || "?"}"); start with SELECT/WITH/FROM`);
  }
  const banned = stripped.match(BANNED_RE);
  if (banned) {
    throw new Error(`statement contains a non-read-only keyword: ${banned[0].toUpperCase()}`);
  }
}
