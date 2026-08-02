// bff/storage/verify-storage.ts — answer "are we actually on flowops?" with evidence.
//
//   npm run verify:storage
//
// Reads the same env the BFF reads, connects the same way, and reports what it
// finds: which engine, which host and database, whether the six tables this app
// owns exist, how many rows are in them, and whether a write actually succeeds.
// A successful connection proves nothing on its own — a read-only grant connects
// fine and then fails on the first INSERT — so this does the write too, inside a
// transaction it rolls back.
//
// Prints no password, ever.
import "dotenv/config";

// The names the app ACTUALLY creates in Postgres. Commit d08c6bd prefixed every
// table with text2ui_ precisely because flowops is shared; the bare _conversations
// / _messages / _project_state names belong to DuckDbChatStore (local file), so
// checking those against a Postgres server reports "all missing" on a perfectly
// healthy install — and, worse, makes a collision pre-flight come back falsely clean.
const SIX = [
  "text2ui_conversations", "text2ui_messages", "text2ui_project_state", // PgChatStore
  "text2ui_datasets", "text2ui_projects", "text2ui_versions",           // PostgresStorage
];
// Created only when design-rag is on (DESIGN_RAG_ENABLED). Not one of the six, but
// it is ours — so it must not be counted as "belongs to something else" below.
const ALSO_OURS = ["text2ui_design_refs"];

/** postgres://user:secret@host:5432/db -> postgres://user:***@host:5432/db */
function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:***@");
  }
}

const ok = (s: string) => console.log(`  \u2713 ${s}`);
const no = (s: string) => console.log(`  \u2717 ${s}`);
const info = (s: string) => console.log(`    ${s}`);

async function main(): Promise<void> {
  const kind = (process.env.STORAGE ?? "duckdb").toLowerCase();
  console.log("\nStorage configuration");
  console.log(`  STORAGE      = ${kind}`);
  console.log(`  STORAGE_PATH = ${process.env.STORAGE_PATH ?? "(unset)"}`);
  console.log(`  PG_URL       = ${process.env.PG_URL ? redact(process.env.PG_URL) : "(unset)"}`);

  if (kind !== "postgres") {
    console.log("");
    no(`STORAGE is "${kind}", not "postgres" — this app is using LOCAL storage, not flowops.`);
    info("Set STORAGE=postgres and PG_URL in .env, then run this again.");
    process.exitCode = 1;
    return;
  }
  if (!process.env.PG_URL) {
    console.log("");
    no("STORAGE=postgres but PG_URL is unset — the BFF will throw on first use.");
    process.exitCode = 1;
    return;
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.PG_URL, connectionTimeoutMillis: 8000 });

  console.log("\nConnection");
  try {
    await client.connect();
  } catch (err: any) {
    no(`could not connect: ${err?.code ?? ""} ${err?.message ?? err}`.trim());
    info("Check the host is reachable (VPN?), the port is right, and the credentials are valid.");
    process.exitCode = 1;
    return;
  }

  try {
    const who = await client.query(
      "SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS host, inet_server_port() AS port, version() AS ver",
    );
    const w = who.rows[0];
    ok(`connected to ${w.db} as ${w.usr}`);
    info(`server: ${w.host ?? "(local socket)"}:${w.port}`);
    info(`${String(w.ver).split(",")[0]}`);

    // The point of the whole exercise: is this the shared box, or localhost?
    console.log("\nIs this flowops?");
    if (String(w.db) === "flowops") ok('current_database() is "flowops"');
    else no(`current_database() is "${w.db}", NOT "flowops" — storage is pointed somewhere else`);

    // ---- the six tables this app creates in public ----
    console.log("\nApplication tables in public");
    const present = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [SIX],
    );
    const have = new Set(present.rows.map((r: any) => String(r.table_name)));
    for (const t of SIX) {
      if (!have.has(t)) { no(`${t} — missing (created on first BFF start)`); continue; }
      try {
        const c = await client.query(`SELECT count(*)::bigint AS n FROM public.${t}`);
        ok(`${t} — ${c.rows[0].n} row(s)`);
      } catch (e: any) {
        no(`${t} — exists but unreadable: ${e?.message ?? e}`);
      }
    }

    // design-rag's table: ours, but only created when DESIGN_RAG_ENABLED is set,
    // so absence is informative rather than a failure.
    for (const t of ALSO_OURS) {
      const there = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
        [t],
      );
      if (there.rowCount === 0) { info(`${t} — absent (only created when design-rag runs)`); continue; }
      try {
        const c = await client.query(`SELECT count(*)::bigint AS n FROM public.${t}`);
        ok(`${t} — ${c.rows[0].n} row(s)`);
      } catch (e: any) {
        no(`${t} — exists but unreadable: ${e?.message ?? e}`);
      }
    }

    // ---- other tables in public: is this database shared? ----
    const others = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND NOT (table_name = ANY($1))`,
      [[...SIX, ...ALSO_OURS]],
    );
    const n = others.rows[0].n as number;
    console.log("\nSharing");
    if (n > 0) info(`${n} other table(s) in public belong to something else — expected, flowops is shared.`);
    else info("public contains only this app's tables.");

    // ---- can we actually write? ----
    console.log("\nWrite permission");
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS public._t2ui_write_probe (id int)`);
      await client.query(`INSERT INTO public._t2ui_write_probe (id) VALUES (1)`);
      await client.query("ROLLBACK"); // leaves nothing behind
      ok("CREATE and INSERT succeed (rolled back — nothing was left behind)");
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      no(`write failed: ${err?.code ?? ""} ${err?.message ?? err}`.trim());
      info("The app needs CREATE on schema public to bootstrap its tables.");
      process.exitCode = 1;
    }

    console.log("\nchat store");
    info("PgChatStore and PostgresStorage both use PG_URL, so the above covers both.");
    console.log("");
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error("verify-storage crashed:", err?.stack ?? err);
  process.exitCode = 1;
});
