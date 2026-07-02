// shared/catalog.ts — the Metric/Entity Catalog: a governed, human-labelled model of the
// data derived from the raw profile. It is the single vocabulary the planners and the
// deterministic Visual Planner draw from, so a deck can only reference measures and
// dimensions that actually exist and carry sensible defaults (aggregation, format, label).
// This is what turns raw columns into "communicable" business concepts.
import type { Agg, ValueFormat } from "./dashboard-spec";

export interface CatalogMeasure {
  id: string;            // stable handle, e.g. "sales.revenue"
  table: string;
  col: string;           // "*" for a record count
  label: string;         // "Revenue"
  defaultAgg: Agg;       // sum / avg / count …
  format?: ValueFormat;  // currency / percent / hours …
  min?: number;          // observed range + mean, for grounding the planner
  max?: number;
  avg?: number;
}

export interface CatalogDimension {
  id: string;            // "sales.region"
  table: string;
  col: string;
  label: string;         // "Region"
  kind: "category" | "time";
  cardinality?: number;
  topValues?: unknown[]; // most frequent members, e.g. ["North","South",…]
}

export interface CatalogEntity {
  table: string;
  label: string;
  rowCount: number;
  measureIds: string[];
  dimensionIds: string[];
}

export interface MetricCatalog {
  entities: CatalogEntity[];
  measures: CatalogMeasure[];
  dimensions: CatalogDimension[];
}