// exemplars.ts — Phase 4: few-shot exemplar library (DORMANT until seeded).
//
// WHY: enrichment fixed WHAT to build; exemplars fix HOW GOOD it looks. A single
// gold-standard App.tsx, shown to the model as a reference, conveys taste
// (spacing, composition, polish) far better than prose design rules — design is
// shown, not told. This is the standard few-shot lever the frontier tools use.
//
// HOW IT STAYS SAFE: everything here is best-effort. With an EMPTY registry
// (the current state), selectExemplar() returns null and the build proceeds
// exactly as today — shipping this changes no behavior until real exemplars are
// added. Exemplars are harvested from real great outputs (not authored), tagged
// by domain, and selected by domain match with a generic fallback.
//
// ADDING ONE LATER (trivial): drop the cleaned App.tsx string into REGISTRY with
// its metadata. No other code changes needed.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Domain } from "./domain";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "exemplars-data");

/** Read an exemplar's code from its verbatim .tsx file. Returns "" if missing,
 *  so a registry entry whose file is absent simply de-selects (no crash). */
function load(file: string): string {
  const path = join(DATA_DIR, file);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export interface Exemplar {
  /** Stable id / filename-ish label, e.g. "sales_v1". */
  id: string;
  /** Domain tag — must match the detector's Domain union for selection. */
  domain: Domain;
  /** Short data-shape note, e.g. "2 tables, time-series + low-card categoricals".
   *  Used for human reference now; can refine selection beyond domain later. */
  dataShape: string;
  /** One line on WHY this is exemplary — for maintainers and optional prompt use. */
  whatsGood: string;
  /** The full reference App.tsx, lightly cleaned. The actual few-shot payload. */
  code: string;
}

/**
 * The exemplar library. Each entry's `code` is loaded from a verbatim .tsx file
 * under bff/exemplars-data/ — to add or swap one, drop a .tsx file there and add
 * a row here. Selection (below) works with any number of entries, including zero
 * (an entry whose file is missing contributes an empty code string and is skipped).
 */
export const REGISTRY: Exemplar[] = [
  {
    id: "sales_v1",
    domain: "sales",
    dataShape: "2 tables (sales_orders + customers), time-series + low-card categoricals, currency pair (revenue/profit)",
    whatsGood: "KPI deltas vs prior period, monthly trend, regional bar, category pie, joined top customer-segment table; clean hierarchy and one-accent discipline",
    code: load("sales.tsx"),
  },
  {
    id: "finance_v1",
    domain: "finance",
    dataShape: "1 table, date + department/category + budget/actual/variance",
    whatsGood: "Budget-vs-actual composed chart, ranked category spend, department table with utilization bars and variance color-coding; all aggregation in SQL",
    code: load("finance.tsx"),
  },
  {
    id: "web_analytics_v1",
    domain: "web_analytics",
    dataShape: "1 table, date + source/device/landing_page + rate metrics (bounce, conversion)",
    whatsGood: "12-column responsive grid, MoM KPI deltas, area trend, interactive source/device bars with active-state dimming, landing-page table; rates treated as rates",
    code: load("web_analytics.tsx"),
  },
  {
    id: "marketing_v1",
    domain: "marketing",
    dataShape: "1 table, date + campaign/channel + spend/impressions/clicks/conversions/revenue",
    whatsGood: "ROAS/CPA/CVR derived correctly, spend-vs-return composed chart, conversion funnel with step rates, sortable campaign table; efficiency framed not just volume",
    code: load("marketing.tsx"),
  },
  {
    id: "users_crm_v1",
    domain: "users_crm",
    dataShape: "1 table, signup_date + plan/status/industry/country + mrr/seats",
    whatsGood: "Active-MRR/churn/ARPU KPIs, monthly signups area, status donut with center total, MRR-by-plan with top highlighted, sortable plan table with churn; growth + retention framing",
    code: load("crm.tsx"),
  },
  {
    id: "generic_v1",
    domain: "generic",
    dataShape: "1 table, date + several categoricals + numeric + nullable metrics",
    whatsGood: "Clean KPI row, daily trend, category/priority/agent breakdowns, recent-records table; solid domain-neutral structure that adapts to arbitrary data",
    code: load("support.tsx"),
  },
];

/** Pick the best exemplar for a detected domain. Exact domain match wins; else a
 *  "generic" exemplar serves as the fallback; else null (build proceeds without
 *  a reference). Never throws. */
export function selectExemplar(domain: Domain): Exemplar | null {
  // A/B kill switch: set T2UI_NO_EXEMPLARS=1 to disable exemplar injection
  // entirely (for comparing build quality with vs without few-shot).
  if (process.env.T2UI_NO_EXEMPLARS) return null;
  const live = REGISTRY.filter((e) => e.code.trim().length > 0);
  if (!live.length) return null;
  const exact = live.find((e) => e.domain === domain);
  if (exact) return exact;
  const generic = live.find((e) => e.domain === "generic");
  return generic ?? null;
}

/** Build the reference block injected into the build prompt. Returns "" when no
 *  exemplar is available (dormant/empty library → no-op). The framing is
 *  deliberately anti-copying: learn the STYLE, never the columns/domain. */
export function exemplarBlock(domain: Domain): string {
  const ex = selectExemplar(domain);
  if (!ex) return "";
  return [
    "",
    "Reference implementation — match its STRUCTURE and QUALITY, not its content or its skin:",
    "Study the spacing rhythm, component composition, visual hierarchy, KPI/card structure, chart configuration, state handling, and overall polish of the reference below. Reproduce that level of craft.",
    "CRITICAL — two things NOT to copy:",
    "  1. Content: the reference uses a DIFFERENT dataset. Do NOT copy its columns, table names, queries, labels, or domain specifics. Build for the user's actual data and plan.",
    "  2. Skin: the reference happens to be styled in one theme. Do NOT copy its specific colors, accent, fonts, or corner radius. Apply the Design system specified above instead — if it names a different accent or neutral than the reference shows, the Design system wins.",
    "Borrow the craft and structure; take the visual identity from the Design system, and the data from the user.",
    "```tsx",
    ex.code,
    "```",
  ].join("\n");
}