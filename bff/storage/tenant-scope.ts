// bff/storage/tenant-scope.ts — Wave 5 / P8 Step 3: multi-tenant data isolation.
//
// A thin adapter that turns an ordinary StorageEngine into a TenantStorageEngine by
// namespacing every projectId with the tenant: the storage key becomes
// `<tenant>__<projectId>`. The concrete engines (DuckDB/Postgres) are UNCHANGED —
// they already give each projectId its own schema ("p_<key>") and scope queries to
// it (USE / SET search_path), so a tenant-prefixed key yields a per-tenant schema
// and a tenant's queries resolve only within their own tables.
//
// Isolation level: app-level. Hard isolation against a hostile tenant crafting
// explicit cross-schema references requires per-tenant DB roles/databases — a later
// hardening once we deploy. This layer prevents accidental cross-tenant access and
// scopes all metadata + data per tenant.

import { PROJECT_ID_RE } from "./types";
import type { StorageEngine, TenantStorageEngine, DatasetUpload, DatasetMeta, QueryOptions, QueryResult, ProjectRecord } from "./types";

const DELIM = "__";

/** tenant/project ids must match PROJECT_ID_RE and contain no "__" (the delimiter). */
export function assertScopeId(kind: string, v: string): void {
  if (typeof v !== "string" || !PROJECT_ID_RE.test(v) || v.includes(DELIM)) {
    throw new Error(`invalid ${kind} "${v}" (must match ${PROJECT_ID_RE.source} and contain no "${DELIM}")`);
  }
}

/** Compose the per-tenant storage key for a project. */
export function composeKey(tenantId: string, projectId: string): string {
  assertScopeId("tenantId", tenantId);
  assertScopeId("projectId", projectId);
  return `${tenantId}${DELIM}${projectId}`;
}

/** Recover the bare projectId from a composed key, or null if it isn't this tenant's. */
export function bareProjectId(tenantId: string, composedKey: string): string | null {
  assertScopeId("tenantId", tenantId);
  const prefix = `${tenantId}${DELIM}`;
  return composedKey.startsWith(prefix) ? composedKey.slice(prefix.length) : null;
}

export class TenantScopedStorage implements TenantStorageEngine {
  constructor(private readonly inner: StorageEngine) {}

  get dialect() {
    return this.inner.dialect;
  }

  replaceDatasets(tenantId: string, projectId: string, datasets: DatasetUpload[]): Promise<DatasetMeta[]> {
    return this.inner.replaceDatasets(composeKey(tenantId, projectId), datasets);
  }

  listDatasets(tenantId: string, projectId: string): Promise<DatasetMeta[]> {
    return this.inner.listDatasets(composeKey(tenantId, projectId));
  }

  query(tenantId: string, projectId: string, sql: string, opts?: QueryOptions): Promise<QueryResult> {
    return this.inner.query(composeKey(tenantId, projectId), sql, opts);
  }

  upsertProject(tenantId: string, projectId: string, name: string): Promise<void> {
    return this.inner.upsertProject(composeKey(tenantId, projectId), name);
  }

  async listProjects(tenantId: string): Promise<ProjectRecord[]> {
    const all = await this.inner.listProjects();
    const out: ProjectRecord[] = [];
    for (const proj of all) {
      const bare = bareProjectId(tenantId, proj.projectId);
      if (bare !== null) out.push({ ...proj, projectId: bare }); // strip the tenant prefix for the client
    }
    return out;
  }

  async getProject(tenantId: string, projectId: string) {
    const r = await this.inner.getProject(composeKey(tenantId, projectId));
    if (!r) return null;
    return { ...r, project: { ...r.project, projectId } }; // report the bare id back
  }

  saveVersion(tenantId: string, projectId: string, v: { num: number; label: string; app: unknown }): Promise<void> {
    return this.inner.saveVersion(composeKey(tenantId, projectId), v);
  }

  deleteProject(tenantId: string, projectId: string): Promise<void> {
    return this.inner.deleteProject(composeKey(tenantId, projectId));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
