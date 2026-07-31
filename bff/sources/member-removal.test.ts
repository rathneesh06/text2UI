// bff/sources/member-removal.test.ts — run with: npm run test:member-removal
//
// THE PROPERTY: removing one database from a group must not disturb any other
// member's identity. Not its stable id, and not the display names its tables
// already answer to.
//
// Why names matter as much as ids: the merged catalog suffixes collisions, so
// `users_2` only carries a `_2` because an earlier member also had a `users`.
// Re-merging from scratch after a removal renames it back to `users` — which
// silently invalidates every selection tick and column projection stored against
// the old name. That bug shipped and was caught only by a live two-database run.
//
// Fixtures only: no database, no network. This is deliberately in `npm test`,
// because the live proof takes ~10 minutes and needs a VPN, while the property it
// checks can be falsified in milliseconds. (The live extraction path has its own
// opt-in suite: group-extract.live.test.ts.)
import assert from "node:assert";
import {
  openGroup, removeGroupMember, publicView, getConnection, soloMemberId,
  type GroupPart,
} from "./connection-registry";

const T = "public";

const conn = (database: string) =>
  ({ dialect: "postgres", host: "h", port: 5432, user: "u", password: "p", database }) as any;

/** A member whose tables are `names`, in a schema of its own. */
const part = (id: string, label: string, names: string[]): GroupPart => ({
  id,
  conn: conn(label),
  label,
  allTables: names.map((n) => ({ name: n, schema: "public", table: n, ref: `src."public"."${n}"`, approxRows: 1 })),
  datasets: names.map((n) => ({
    tableName: n,
    profile: { source: { filename: `pg:public.${n}`, format: "json" }, rowCount: 1, columns: [], sampleRows: [] },
  })) as any,
});

// Every member has `users`, so the merged catalog must suffix two of them. `a`
// also has `orders`, which nothing collides with.
const mk = () => [
  part("mem_a", "db_a", ["users", "orders"]),
  part("mem_b", "db_b", ["users"]),
  part("mem_c", "db_c", ["users"]),
];

const nameOf = (rec: any, memberId: string) =>
  publicView(rec).allTables.filter((t: any) => t.memberId === memberId).map((t: any) => t.name).sort();

// ---- baseline: the merge assigns the suffixes we expect --------------------------
{
  const g = openGroup(T, mk());
  const pv = publicView(g);
  assert.deepEqual(pv.members.map((m) => m.id), ["mem_a", "mem_b", "mem_c"]);
  assert.deepEqual(nameOf(g, "mem_a"), ["orders", "users"]);
  assert.deepEqual(nameOf(g, "mem_b"), ["users_2"], "second `users` is suffixed");
  assert.deepEqual(nameOf(g, "mem_c"), ["users_3"], "third `users` is suffixed again");
  assert.equal(pv.allTables.length, 4);
  assert.ok(pv.allTables.every((t: any) => t.memberId), "every table is attributed to a member");
}

// ---- 3 -> 2: the still-multi rebuild. Positions shift under the survivors -------
// mem_c moves from src2 to src1 here, which is exactly the case the stable ids
// exist for and the one a 2->1 test never reaches.
{
  const g = openGroup(T, mk());
  const recId = g.id;
  const { rec, removed, removedTables } = removeGroupMember(g, "mem_b");

  assert.ok(rec, "two members remain, so the record survives");
  assert.equal(removed?.id, "mem_b");
  assert.deepEqual(removedTables, ["users_2"], "reports the MERGED name, which is what a selection stores");
  assert.equal(rec!.id, recId, "the record keeps its id, so the client's connectionId stays valid");

  const pv = publicView(rec!);
  assert.deepEqual(pv.members.map((m) => m.id), ["mem_a", "mem_c"], "survivors keep their ids, in order");
  assert.equal(rec!.groupParts?.length, 2, "still a group");

  // The point of the test.
  assert.deepEqual(nameOf(rec!, "mem_a"), ["orders", "users"], "A's names untouched");
  assert.deepEqual(nameOf(rec!, "mem_c"), ["users_3"],
    "C keeps `users_3` even though `users_2` is now free — renaming it would break stored ticks");

  // Positions DID shift, which is fine: only refs are positional.
  const cRef = rec!.allTables.find((t) => t.name === "users_3")?.ref;
  assert.equal(cRef, `src1."public"."users"`, "C moved from src2 to src1 at attach level");
}

// ---- 2 -> 1: degrade to a plain connection --------------------------------------
{
  const g = openGroup(T, mk());
  removeGroupMember(g, "mem_b");
  const { rec } = removeGroupMember(g, "mem_a");

  assert.ok(rec);
  assert.equal(rec!.groupParts, undefined, "degrades to a plain connection");
  assert.equal(soloMemberId(rec!), "mem_c", "the survivor keeps the id it already had — not a fresh solo id");

  const pv = publicView(rec!);
  assert.deepEqual(pv.members, [{ id: "mem_c", label: "db_c" }], "one member, uniform shape");
  assert.deepEqual(nameOf(rec!, "mem_c"), ["users_3"], "still `users_3` after degrading to solo");
  // Refs revert to the single-connection form.
  assert.equal(rec!.allTables[0].ref, `src."public"."users"`);
}

// ---- 1 -> 0: the connection closes ----------------------------------------------
{
  const g = openGroup(T, mk());
  removeGroupMember(g, "mem_a");
  removeGroupMember(g, "mem_b");
  const { rec } = removeGroupMember(g, "mem_c");
  assert.equal(rec, null, "last member removed closes the connection");
  assert.equal(getConnection(T, g.id), null, "and it leaves the registry");
}

// ---- removing a lone connection behaves like removing the last group member -----
{
  const g = openGroup(T, mk());
  removeGroupMember(g, "mem_a");
  removeGroupMember(g, "mem_b");           // now a plain connection holding mem_c
  const { rec, removed } = removeGroupMember(g, soloMemberId(g));
  assert.equal(rec, null, "no divergence between the two shapes");
  assert.equal(removed?.id, "mem_c");
}

// ---- an unknown member is a no-op, not a crash ----------------------------------
{
  const g = openGroup(T, mk());
  const { rec, removed, removedTables } = removeGroupMember(g, "mem_nope");
  assert.equal(removed, null);
  assert.deepEqual(removedTables, []);
  assert.equal(rec!.groupParts?.length, 3, "nothing was disturbed");
}

console.log("member-removal.test.ts: all assertions passed ✅");
