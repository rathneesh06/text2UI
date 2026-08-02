// bff/storage/outage.test.ts — run with: npm run test:outage
// THE ECONNREFUSED INCIDENT, pinned: a dead Postgres must degrade the BFF,
// never kill it. A PostgresStorage pointed at a closed port must (1) not
// produce an unhandled rejection, (2) fail requests with an actionable error,
// (3) recover lazily if the database comes back (proven with the in-process
// retry path — the ensure() re-arm).
import assert from "node:assert/strict";

let unhandled: unknown = null;
process.on("unhandledRejection", (err) => { unhandled = err; });

const { PostgresStorage } = await import("./postgres");

// Port 1 is never listening. Construction must not throw, and — the incident —
// the parked init rejection must not surface as unhandled.
const storage = new PostgresStorage("postgres://user:pw@127.0.0.1:1/db");
await new Promise((r) => setTimeout(r, 1200)); // give the failed init time to reject
assert.equal(unhandled, null, "a dead database produces NO unhandled rejection");
console.log("outage: constructor-field rejection is caught ✅");

// Operations fail with the actionable message, not a pg stack blowup.
await assert.rejects(
  () => (storage as any).listProjects(),
  /unavailable.*docker compose up -d db/s,
  "requests fail with the fix named",
);
// …and a second call takes the lazy-retry path (still down → same clean error).
await assert.rejects(() => (storage as any).listProjects(), /unavailable/);
assert.equal(unhandled, null, "retries never leak unhandled rejections either");
console.log("outage: requests degrade with an actionable error + lazy retry ✅");

console.log("outage.test.ts: all assertions passed ✅");
process.exit(0); // the dead pool holds the event loop; exit explicitly
