// bff/dashboard/compile.ts — validate a spec, then attach the deterministic SQL to
// every widget, producing a RenderPlan the renderer can execute verbatim.
import type { Dataset } from "../../shared/types";
import type { DashboardSpec, RenderPlan, CompiledSection, CompiledWidget } from "../../shared/dashboard-spec";
import { validateSpec } from "./validate";
import { balanceLayout } from "./layout";
import { buildKpiSql, buildChartSql, buildTableSql } from "./sql";
import { resolveGlobalFilters } from "./filters";

export function compileSpec(spec: DashboardSpec, profiles: Dataset[]): RenderPlan {
  const { spec: valid, warnings } = validateSpec(spec, profiles);
  // Layout pass AFTER validation: dropped widgets can orphan a row, so widths are
  // finalized against what actually survived. The balanced spec is also what gets
  // returned/persisted, so edit turns keep reasoning about the real layout.
  const clean = balanceLayout(valid);

  // A1: resolve the global filter bar against the SURVIVING widgets (a filter
  // that applies to no rendered table is pruned). The lean form is persisted on
  // the spec so edit turns see the bar; options/bounds ride only on the plan.
  const filters = resolveGlobalFilters(clean, profiles);
  clean.filters = filters.map(({ id, col, kind, label, table }) => ({ id, col, kind, label, ...(table ? { table } : {}) }));

  const sections: CompiledSection[] = clean.sections.map((s) => {
    const widgets: CompiledWidget[] = s.widgets.map((w) => {
      if (w.kind === "kpi") {
        return { widget: w, sql: buildKpiSql(w) };
      }
      if (w.kind === "table") {
        const { sql, cols } = buildTableSql(w);
        // Column metadata (labels + per-column format) must reach the
        // renderer — deriving headers from row keys loses formats (C2).
        return { widget: w, sql, columns: cols };
      }
      const { sql, seriesKeys } = buildChartSql(w);
      return {
        widget: w,
        sql,
        seriesKeys: seriesKeys.map((k, i) => ({ key: k.key, label: k.label, format: w.series[i]?.format })),
      };
    });
    return { id: s.id, title: s.title, widgets };
  });

  return { meta: clean.meta, sections, warnings, spec: clean, filters };
}