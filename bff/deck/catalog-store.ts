// bff/deck/catalog-store.ts — the Metric/Entity Catalog persistence box. Caches derived
// catalogs by a signature of the dataset shape (table names + columns), so the Semantic
// Modeling Service runs once per distinct schema rather than every build/edit. In-memory
// behind a tiny interface; swap for a DB later without touching callers.
import type { Dataset } from "../../shared/types";
import type { MetricCatalog } from "../../shared/catalog";
import { buildCatalog } from "./catalog";

const cache = new Map<string, MetricCatalog>();
const MAX = 100;

function signature(datasets: Dataset[]): string {
  return datasets.map((d) => `${d.tableName}:${d.profile.columns.map((c) => `${c.name}.${c.type}`).join(",")}`).join("|");
}

/** Return a catalog for these datasets, building + caching on first sight. */
export function getCatalog(datasets: Dataset[]): MetricCatalog {
  const key = signature(datasets);
  let cat = cache.get(key);
  if (!cat) {
    cat = buildCatalog(datasets);
    if (cache.size >= MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, cat);
  }
  return cat;
}