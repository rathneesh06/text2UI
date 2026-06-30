// bff/design-rag/verify.ts — one-command sanity check for the Design Retrieval
// pgvector migration. Run it AFTER bringing up a pgvector-capable Postgres:
//
//   npm run verify:designrag
//
// It constructs the real PostgresStorage (which runs init() -> initDesignRefs()),
// reports whether the _design_refs corpus migrated, and prints the extension,
// the vector column widths, and the indexes so you can see it with your own eyes.
import "dotenv/config";
import pg from "pg";
import { PostgresStorage } from "../storage/postgres";
import { DESIGN_EMBED_DIM } from "./config";

const PASS = "PASS ✓";
const FAIL = "FAIL ✗";

function die(msg: string): never {
  console.error(`\n${FAIL} ${msg}\n`);
  process.exit(1);
}

const url = process.env.PG_URL;
const kind = (process.env.STORAGE ?? "duckdb").toLowerCase();
if (kind !== "postgres" || !url) {
  die(
    `Design Retrieval needs Postgres. In your .env set:\n` +
    `    STORAGE=postgres\n` +
    `    PG_URL=postgres://text2ui:text2ui@localhost:5432/text2ui\n` +
    `  (current STORAGE=${process.env.STORAGE ?? "(unset)"}, PG_URL=${url ? "set" : "(unset)"})`,
  );
}

console.log(`\nDesign Retrieval — pgvector verification`);
console.log(`  PG_URL            : ${url.replace(/:[^:@/]+@/, ":****@")}`);
console.log(`  expected vector() : ${DESIGN_EMBED_DIM}\n`);

// 1) Construct the engine and force init() by calling a method that awaits it.
const storage = new PostgresStorage(url);
try {
  await storage.listProjects();           // triggers init() -> initDesignRefs()
} catch (err) {
  die(`could not connect / initialize: ${(err as Error).message}\n` +
      `  Is the database up? Try: docker compose up -d db`);
}
console.log(`  designRefsReady   : ${storage.designRefsReady}` +
  (storage.designRefsReady ? "  (migration succeeded)" : "  (pgvector missing — see below)"));

// 2) Inspect the catalog directly so the result is visible, not just a boolean.
const client = new pg.Client({ connectionString: url });
await client.connect();

const ext = await client.query(
  `SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'`);
const cols = await client.query(
  `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = '_design_refs'
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`);
const idx = await client.query(
  `SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = '_design_refs' ORDER BY indexname`);
await client.end();

// 3) Report.
const hasExt = ext.rows.length > 0;
const hasTable = cols.rows.length > 0;
const embedCols = cols.rows.filter((r: any) => r.name === "img_embed" || r.name === "cap_embed");
const dimOk = embedCols.length === 2 && embedCols.every((r: any) => r.type === `vector(${DESIGN_EMBED_DIM})`);
const idxNames = idx.rows.map((r: any) => r.indexname);
const idxOk = ["idx_design_refs_img_hnsw", "idx_design_refs_domain", "idx_design_refs_phash"]
  .every((n) => idxNames.includes(n));

console.log(`\n  extension 'vector': ${hasExt ? `${PASS}  (v${ext.rows[0].extversion})` : FAIL}`);
console.log(`  table _design_refs: ${hasTable ? PASS : FAIL}`);
if (hasTable) {
  console.log(`  vector columns    : ${dimOk ? PASS : FAIL}`);
  for (const r of embedCols) console.log(`      - ${r.name} ${r.type}`);
  console.log(`  indexes           : ${idxOk ? PASS : FAIL}`);
  for (const n of idxNames) console.log(`      - ${n}`);
}

const allOk = hasExt && hasTable && dimOk && idxOk && storage.designRefsReady;
console.log(`\n${allOk ? PASS : FAIL} Design Retrieval storage is ${allOk ? "ready." : "NOT ready."}`);
if (!allOk && !hasExt) {
  console.log(`  -> The Postgres image lacks pgvector. Use 'pgvector/pgvector:pg16'`);
  console.log(`     (already set in docker-compose.yml): docker compose up -d db`);
}
process.exit(allOk ? 0 : 1);
