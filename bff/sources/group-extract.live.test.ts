// bff/sources/group-extract.live.test.ts — run with: npm run test:multidb:live
//
// The Stage 1 proof, made repeatable. Extraction from a connection GROUP was
// silently broken for a long time: rec.conn is only parts[0] ("placeholder for
// shape"), and a group attaches as src0/src1/… not "src", so the resolver matched
// nothing and every requested table landed in `skipped`. A multi-database commit
// quietly produced the first database's tables, or none.
//
// DELIBERATELY NOT IN `npm test`: it needs two reachable databases and takes
// minutes. The pure property it depends on (member identity and display-name
// stability across removals) is covered by member-removal.test.ts, which does run
// in the suite. This one covers what only a real engine can: that the multi-catalog
// resolve, the merged-name translation and the origin stamping actually work.
//
// Skips cleanly — never fails — when PG_URL is unset or the host is unreachable,
// so it is safe to run off-VPN.
import "dotenv/config"; // read PG_URL from .env, the same source the BFF uses
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HERMETIC: never touch the real WB_DIR. Must be set before workbench-store loads.
process.env.WB_DIR = mkdtempSync(join(tmpdir(), "t2ui-grouplive-"));

const skip = (why: string) => { console.log(`group-extract.live.test.ts: SKIPPED — ${why}`); process.exit(0); };

const base = process.env.PG_URL ?? "";
if (!base) skip("PG_URL is unset");
if (!/^postgres(ql)?:\/\//.test(base)) skip("PG_URL is not a postgres URL");

// Two databases on the same server is enough: they attach as src0 and src1, which
// is the whole point. Overlapping table names are a feature here — they exercise
// the collision suffixing that broke the resolver.
const urlFor = (db: string) => base.replace(/\/[^/]*$/, `/${db}`);
const DB_A = process.env.T2SQL_LIVE_DB_A ?? "flowops";
const DB_B = process.env.T2SQL_LIVE_DB_B ?? "flowops_uat";

const { openConnection, openGroup, newMemberId } = await import("./connection-registry");
const { stageSnapshot } = await import("../text2sql/handler");
const { stagingDbPath } = await import("./workbench-store");

const T = "public";

let a: any, b: any;
try {
  a = await openConnection(T, urlFor(DB_A));
  b = await openConnection(T, urlFor(DB_B));
} catch (err: any) {
  // Unreachable host / VPN off / bad credentials are not test failures here.
  skip(`could not reach both databases (${err?.code ?? ""} ${String(err?.message ?? err).slice(0, 120)})`);
}

const asPart = (r: any) => (r.groupParts?.length ? r.groupParts : [{
  id: newMemberId(), conn: r.conn, label: r.label, allTables: r.allTables, datasets: r.datasets,
}]);
const group = openGroup(T, [...asPart(a), ...asPart(b)]);
assert.equal(group.groupParts?.length, 2, "two members");

const from0 = group.allTables.filter((t) => t.ref.startsWith("src0."));
const from1 = group.allTables.filter((t) => t.ref.startsWith("src1."));
assert.ok(from0.length && from1.length, "both members contributed tables to the merged catalog");

// One table from each member. Where a name collides, the second is suffixed
// (`x` / `x_2`) — those merged names exist in no real catalog, so they must be
// translated back to db:schema.table before resolution. That translation is the
// second bug this test exists to pin.
const pick = [from0[0], from1[0]].map((t) => t.name);
const conversationId = `conv_grouplive_${Date.now()}`;
const out = await stageSnapshot(group, pick, T, conversationId);

assert.deepEqual(out.skipped, [], `nothing may be skipped — got ${JSON.stringify(out.skipped)}`);
assert.equal(out.staged.tables.length, 2, "both tables staged");

const catalogs = new Set(out.staged.tables.map((t: any) => t.origin?.catalog).filter(Boolean));
assert.ok(catalogs.size >= 2, `tables must come from BOTH databases — got ${JSON.stringify([...catalogs])}`);
for (const t of out.staged.tables as any[]) {
  assert.ok(t.origin?.memberId, `${t.tableName} carries a STABLE member id, not just a positional catalog`);
  assert.ok(
    group.groupParts!.some((p) => p.id === t.origin.memberId),
    `${t.tableName}'s memberId resolves to a current member`,
  );
}

// And prove it on disk, independently of the in-memory result.
const { DuckDBInstance } = await import("@duckdb/node-api");
const inst = await DuckDBInstance.create(stagingDbPath(conversationId));
const c = await inst.connect();
try {
  const reader = await c.runAndReadUntil(`SELECT table_name FROM duckdb_tables() WHERE schema_name = 'main'`, 1000);
  const onDisk = (reader.getRowObjectsJS() as any[]).map((r) => String(r.table_name)).sort();
  assert.deepEqual(onDisk, out.staged.tables.map((t: any) => t.tableName).sort(), "the stage FILE holds what we staged");
} finally {
  c.disconnectSync();
  inst.closeSync();
}

console.log(`group-extract.live.test.ts: all assertions passed ✅ (${DB_A} + ${DB_B}, origins ${JSON.stringify([...catalogs])})`);
