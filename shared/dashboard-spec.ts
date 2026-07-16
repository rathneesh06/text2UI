// shared/dashboard-spec.ts — the typed intermediate representation at the heart of
// the spec-driven pipeline. The planner LLM emits a DashboardSpec (never JSX); the
// server compiles it deterministically into SQL + a fixed renderer. The spec is the
// persistent source of truth that each chat turn EDITS, so the conversation and the
// dashboard are one evolving artifact rather than two independent flows.

export type Agg = "count" | "count_distinct" | "sum" | "avg" | "min" | "max" | "median";
export type TimeGrain = "day" | "week" | "month" | "quarter" | "year";
export type ValueFormat = "number" | "compact" | "percent" | "currency" | "hours" | "days";
export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "not_null" | "is_null";
export type WidgetWidth = "quarter" | "third" | "half" | "full";

export interface Filter {
  col: string;
  op: FilterOp;
  /** omitted for is_null / not_null; array for `in`. */
  value?: string | number | boolean | Array<string | number>;
}

/** An aggregated measure: agg(col). `count` ignores col. */
export interface Metric {
  col: string;
  agg: Agg;
  label?: string;
  format?: ValueFormat;
}

/** A grouping dimension; timeGrain buckets a date/timestamp column. */
export interface Dimension {
  col: string;
  timeGrain?: TimeGrain;
  label?: string;
}

export interface KpiWidget {
  id: string;
  kind: "kpi";
  title: string;
  table: string;
  metric: Metric;
  filters?: Filter[];
  width?: WidgetWidth;        // default "quarter"
}

export interface ChartWidget {
  id: string;
  kind: "line" | "bar" | "area" | "pie" | "donut";
  title: string;
  subtitle?: string;
  table: string;
  x: Dimension;
  series: Metric[];           // pie/donut use the first series only
  filters?: Filter[];
  sort?: { by: "x" | "y"; dir: "asc" | "desc" };
  limit?: number;
  width?: WidgetWidth;        // default "half"
}

export interface TableColumn {
  col: string;
  label?: string;
  agg?: Agg;                  // omitted = raw column
  format?: ValueFormat;
}

export interface TableWidget {
  id: string;
  kind: "table";
  title: string;
  subtitle?: string;
  table: string;
  columns: TableColumn[];
  groupBy?: Dimension[];
  filters?: Filter[];
  sort?: { by: string; dir: "asc" | "desc" };  // by = a column label or col
  limit?: number;
  width?: WidgetWidth;        // default "full"
}

export type Widget = KpiWidget | ChartWidget | TableWidget;

export interface Section {
  id: string;
  title?: string;
  widgets: Widget[];
}

export interface DashboardMeta {
  title: string;
  subtitle?: string;
  audience?: string;
  theme?: "light" | "dark";
  /** Primary accent color (hex) — KPI values, emphasis. Style prompts land here. */
  accent?: string;
  /** Chart series palette (hex[]) — "make the charts teal" lands here. */
  chartPalette?: string[];
}

export interface DashboardSpec {
  version: 1;
  meta: DashboardMeta;
  sections: Section[];
}

// ---- Compiled form (server output → renderer input) ------------------------
// Each widget is paired with the exact DuckDB SQL the renderer will run. The
// browser never builds SQL; it only executes these pre-validated strings.
export interface CompiledWidget {
  widget: Widget;
  sql: string;
  /** stable result-column keys for chart series (alias → label), for the renderer. */
  seriesKeys?: { key: string; label: string; format?: ValueFormat }[];
}

export interface CompiledSection {
  id: string;
  title?: string;
  widgets: CompiledWidget[];
}

export interface RenderPlan {
  meta: DashboardMeta;
  sections: CompiledSection[];
  warnings: string[];
  /** al5: the spec AFTER validation/repair — what actually renders. The handler
   *  returns THIS to the client (persisted as currentSpec), so the next edit
   *  turn reasons about widgets that exist on screen, and the change summary
   *  can't claim widgets that validation dropped. */
  spec: DashboardSpec;
}