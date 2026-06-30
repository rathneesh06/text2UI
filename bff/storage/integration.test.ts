// bff/storage/integration.test.ts — Wave 5 / P8: REAL end-to-end tenant isolation.
//
// Non-gated (needs native @duckdb/node-api; also runs against Postgres when PG_URL
// is set). Proves the tenant-scoping adapter isolates two tenants that use the SAME
// projectId, across data, datasets, projects, and versions — against real engines.
//
//   npm run test:storage:live            # DuckDB
//   PG_URL=postgres://... npm run test:storage:live   # DuckDB + Postgres

import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DuckDBStorage } from "./duckdb";
import { PostgresStorage } from "./postgres";
import { TenantScopedStorage } from "./tenant-scope";
import type { StorageEngine, DatasetUpload } from "./types";

function upload(tableName: string, rows: Record<string, unknown>[]): DatasetUpload {
  return {
    tableName,
    filename: `${tableName}.csv`,
    rows,
    profile: {
      source: { filename: `${tableName}.csv`, format: "csv" },
      rowCount: rows.length,
      columns: [{ name: "r", type: "string", nullable: false, uniqueCount: rows.length, sampleValues: [] }],
      sampleRows: rows.slice(0, 3),
    },
  };
}
const count = (rows: Record<string, unknown>[]) => Number((rows[0] as any).n);

async function runScenario(label: string, raw: StorageEngine): Promise<void> {
  const s = new TenantScopedStorage(raw);
  const A = "acme", B = "globex", P = "proj1"; // SAME projectId, two tenants

  // Best-effort clean slate (rerunnable against a persistent Postgres).
  await s.deleteProject(A, P).catch(() => {});
  await s.deleteProject(B, P).catch(() => {});

  // Same projectId, different data per tenant.
  await s.replaceDatasets(A, P, [upload("sales", [{ r: "x" }, { r: "y" }, { r: "z" }])]); // 3 rows
  await s.replaceDatasets(B, P, [upload("sales", [{ r: "only" }])]);                       // 1 row

  // Isolation of DATA: each tenant's query sees only its own rows.
  const aCount = count((await s.query(A, P, "SELECT count(*)::INT AS n FROM sales")).rows);
  const bCount = count((await s.query(B, P, "SELECT count(*)::INT AS n FROM sales")).rows);
  assert.equal(aCount, 3, `[${label}] tenant A sees its 3 rows`);
  assert.equal(bCount, 1, `[${label}] tenant B sees its 1 row (same projectId, isolated)`);

  // Isolation of PROJECTS + names.
  await s.upsertProject(A, P, "Acme Project");
  await s.upsertProject(B, P, "Globex Project");
  await s.saveVersion(A, P, { num: 1, label: "v1", app: { files: [] } });

  const aProjects = await s.listProjects(A);
  const bProjects = await s.listProjects(B);
  assert.equal(aProjects.length, 1, `[${label}] A lists exactly its project`);
  assert.equal(aProjects[0].projectId, P, `[${label}] bare projectId returned`);
  assert.equal(aProjects[0].name, "Acme Project");
  assert.equal(bProjects[0].name, "Globex Project", `[${label}] B sees its own name, not A's`);

  // Isolation of VERSIONS + cross-tenant read returns nothing.
  const aGot = await s.getProject(A, P);
  const bGot = await s.getProject(B, P);
  assert.equal(aGot?.project.name, "Acme Project");
  assert.equal(aGot?.versions.length, 1, `[${label}] A has its version`);
  assert.equal(bGot?.versions.length, 0, `[${label}] B has no versions (didn't save one)`);
  assert.equal(await s.getProject(A, "nope"), null, `[${label}] missing project -> null`);

  // Delete is tenant-scoped: removing B leaves A intact.
  await s.deleteProject(B, P);
  assert.equal(await s.getProject(B, P), null, `[${label}] B deleted`);
  const aStill = count((await s.query(A, P, "SELECT count(*)::INT AS n FROM sales")).rows);
  assert.equal(aStill, 3, `[${label}] A unaffected by B's deletion`);

  await s.deleteProject(A, P); // cleanup
  console.log(`  [${label}] tenant isolation verified end-to-end`);
}

// ---- DuckDB (always) -------------------------------------------------------
{
  const path = join(tmpdir(), `t2ui_tenancy_${Date.now()}.duckdb`);
  const raw = new DuckDBStorage(path);
  try {
    await runScenario("duckdb", raw);
  } finally {
    await raw.close().catch(() => {});
    rmSync(path, { force: true });
  }
}

// ---- Postgres (when PG_URL is set) -----------------------------------------
if (process.env.PG_URL) {
  const raw = new PostgresStorage(process.env.PG_URL);
  try {
    await runScenario("postgres", raw);
  } finally {
    await raw.close().catch(() => {});
  }
} else {
  console.log("  [postgres] skipped (set PG_URL to run)");
}

console.log("integration.test.ts: all assertions passed");
