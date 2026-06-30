// bff/design-rag/gallery-echarts.ts — ECharts option specs (Increment 3).
// Chart types Recharts doesn't cover well (gauge, funnel, radar, treemap),
// rendered via esm.sh echarts. Apache-2.0 (ECharts).

import type { GallerySpec } from "./gallery";

const LICENSE = "Apache-2.0";
const ATTRIBUTION = "Apache ECharts (Apache-2.0) — example options";
const SOURCE = "https://echarts.apache.org/examples";

const gauge = `{
  series: [{ type: "gauge", progress: { show: true, width: 18 }, axisLine: { lineStyle: { width: 18 } },
    detail: { valueAnimation: true, formatter: "{value}%", fontSize: 28 },
    data: [{ value: 75.5, name: "Target" }] }]
}`;

const funnel = `{
  title: { text: "Conversion funnel", left: "center", textStyle: { fontSize: 14 } },
  tooltip: { trigger: "item" },
  series: [{ type: "funnel", left: "10%", width: "80%", label: { show: true },
    data: [
      { value: 100, name: "Visits" }, { value: 72, name: "Signups" },
      { value: 45, name: "Trials" }, { value: 28, name: "Paid" }, { value: 17, name: "Renewed" }
    ] }]
}`;

const radar = `{
  title: { text: "Team capacity", left: "center", textStyle: { fontSize: 14 } },
  radar: { indicator: [
    { name: "Eng", max: 100 }, { name: "Design", max: 100 }, { name: "Sales", max: 100 },
    { name: "Support", max: 100 }, { name: "Ops", max: 100 }, { name: "Marketing", max: 100 }
  ] },
  series: [{ type: "radar", data: [
    { value: [88, 72, 65, 80, 70, 60], name: "Current" },
    { value: [70, 60, 55, 65, 60, 50], name: "Target" }
  ] }]
}`;

const treemap = `{
  title: { text: "Spend by category", left: "center", textStyle: { fontSize: 14 } },
  series: [{ type: "treemap", roam: false, data: [
    { name: "Infra", value: 42 }, { name: "Payroll", value: 88 }, { name: "Marketing", value: 35 },
    { name: "Sales", value: 28 }, { name: "R&D", value: 51 }, { name: "G&A", value: 19 }
  ] }]
}`;

export const ECHARTS_SPECS: GallerySpec[] = [
  { id: "echarts-gauge", renderer: "echarts", code: gauge, domainHint: "sales", license: LICENSE, attribution: ATTRIBUTION, sourceUrl: SOURCE },
  { id: "echarts-funnel", renderer: "echarts", code: funnel, domainHint: "marketing", license: LICENSE, attribution: ATTRIBUTION, sourceUrl: SOURCE },
  { id: "echarts-radar", renderer: "echarts", code: radar, domainHint: "users_crm", license: LICENSE, attribution: ATTRIBUTION, sourceUrl: SOURCE },
  { id: "echarts-treemap", renderer: "echarts", code: treemap, domainHint: "finance", license: LICENSE, attribution: ATTRIBUTION, sourceUrl: SOURCE },
];
