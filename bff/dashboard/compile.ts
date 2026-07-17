// bff/dashboard/compile.ts — validate a spec, then attach the deterministic SQL to
// every widget, producing a RenderPlan the renderer can execute verbatim.
import type { Dataset } from "../../shared/types";
import type { DashboardSpec, RenderPlan, CompiledSection, CompiledWidget } from "../../shared/dashboard-spec";
import { validateSpec } from "./validate";
import { balanceLayout } from "./layout";
import { buildKpiSql, buildChartSql, buildTableSql } from "./sql";

export function compileSpec(spec: DashboardSpec, profiles: Dataset[]): RenderPlan {
  const { spec: valid, warnings } = validateSpec(spec, profiles);
  // Layout pass AFTER validation: dropped widgets can orphan a row, so widths are
  // finalized against what actually survived. The balanced spec is also what gets
  // returned/persisted, so edit turns keep reasoning about the real layout.
  const clean = balanceLayout(valid);

  const sections: CompiledSection[] = clean.sections.map((s) => {
    const widgets: CompiledWidget[] = s.widgets.map((w) => {
      if (w.kind === "kpi") {
        return { widget: w, sql: buildKpiSql(w) };
      }
      if (w.kind === "table") {
        const { sql } = buildTableSql(w);
        return { widget: w, sql };
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

  return { meta: clean.meta, sections, warnings, spec: clean };
}