import assert from "node:assert";
import { assertScopeId, composeKey, bareProjectId, TenantScopedStorage } from "./tenant-scope";
import type { StorageEngine, ProjectRecord } from "./types";

// ---- validation + key composition ------------------------------------------
{
  assert.equal(composeKey("acme", "alpha"), "acme__alpha");
  assert.doesNotThrow(() => assertScopeId("x", "a-b_c1"));
  assert.throws(() => composeKey("acme", "a__b"), /contain no/);   // delimiter not allowed in ids
  assert.throws(() => composeKey("ac__me", "alpha"), /contain no/);
  assert.throws(() => composeKey("acme", "bad id"), /must match/); // space invalid

  assert.equal(bareProjectId("acme", "acme__alpha"), "alpha");
  assert.equal(bareProjectId("acme", "globex__beta"), null, "other tenant's key -> null");
}

// ---- adapter delegates with composed keys ----------------------------------
class FakeInner implements StorageEngine {
  readonly dialect = "duckdb" as const;
  calls: any[][] = [];
  async replaceDatasets(p: string) { this.calls.push(["replaceDatasets", p]); return []; }
  async listDatasets(p: string) { this.calls.push(["listDatasets", p]); return []; }
  async query(p: string, sql: string) { this.calls.push(["query", p, sql]); return { rows: [], truncated: false }; }
  async upsertProject(p: string, name: string) { this.calls.push(["upsertProject", p, name]); }
  async listProjects(): Promise<ProjectRecord[]> {
    return [
      { projectId: "acme__alpha", name: "Alpha", createdAt: 0, editedAt: 0, versionCount: 1, tableNames: ["t"] },
      { projectId: "globex__beta", name: "Beta", createdAt: 0, editedAt: 0, versionCount: 0, tableNames: [] },
    ];
  }
  async getProject(p: string) {
    this.calls.push(["getProject", p]);
    return p === "acme__alpha"
      ? { project: { projectId: p, name: "Alpha", createdAt: 0, editedAt: 0 }, versions: [] }
      : null;
  }
  async saveVersion(p: string, v: { num: number }) { this.calls.push(["saveVersion", p, v.num]); }
  async deleteProject(p: string) { this.calls.push(["deleteProject", p]); }
  async close() {}
}

{
  const inner = new FakeInner();
  const s = new TenantScopedStorage(inner);

  assert.equal(s.dialect, "duckdb", "dialect passes through");

  await s.query("acme", "alpha", "SELECT 1");
  assert.deepEqual(inner.calls[inner.calls.length-1], ["query", "acme__alpha", "SELECT 1"], "query namespaced");

  await s.replaceDatasets("acme", "alpha", []);
  assert.equal(inner.calls[inner.calls.length-1]![1], "acme__alpha");

  await s.saveVersion("acme", "alpha", { num: 2, label: "v2", app: {} });
  assert.deepEqual(inner.calls[inner.calls.length-1], ["saveVersion", "acme__alpha", 2]);

  // listProjects: only this tenant's projects, with the bare id
  const acmeProjects = await s.listProjects("acme");
  assert.equal(acmeProjects.length, 1, "tenant sees only its own projects");
  assert.equal(acmeProjects[0].projectId, "alpha", "prefix stripped for the client");

  const globexProjects = await s.listProjects("globex");
  assert.equal(globexProjects.length, 1);
  assert.equal(globexProjects[0].projectId, "beta");

  // getProject: bare id returned; cross-tenant access yields null
  const found = await s.getProject("acme", "alpha");
  assert.equal(found?.project.projectId, "alpha", "bare id reported back");
  const crossTenant = await s.getProject("acme", "beta"); // inner key "acme__beta" -> null
  assert.equal(crossTenant, null, "cannot read another tenant's project");
}

console.log("tenant-scope.test.ts: all assertions passed");
