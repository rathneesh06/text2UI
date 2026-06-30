// domain.ts — context enrichment (Phase: enrichment).
//
// Short user prompts underspecify, so the model fills gaps with generic
// defaults ("kinda mid"). This module injects two things the schema alone
// doesn't carry:
//   1. DOMAIN PRIORS  — "what a GREAT dashboard of this kind contains", so a
//      terse prompt still aims high (the Flowstep "good by default" effect).
//   2. STAT REASONING — turns the raw profile stats already in the schema
//      (cardinality, date span, currency pairs) into explicit guidance.
//
// Detection is RULE-FIRST (fast, free, deterministic) with a MODEL FALLBACK:
// when the rules aren't confident, we ask the plan model to self-classify and
// the contract still applies the matching prior. Both paths converge on the
// same prior library below.

import type { Dataset, ColumnProfile } from "../shared/types";

export type Domain =
  | "sales"
  | "finance"
  | "web_analytics"
  | "marketing"
  | "users_crm"
  | "healthcare"
  | "logistics"
  | "hr_people"
  | "education"
  | "real_estate"
  | "generic";

/** Column-name signals per domain. Matched case-insensitively as substrings
 *  against column names. Ordered by specificity in scoreDomain(). */
const SIGNALS: Record<Exclude<Domain, "generic">, string[]> = {
  sales: ["order", "revenue", "profit", "margin", "product", "sku", "quantity", "price", "discount", "sales", "aov", "units"],
  finance: ["budget", "actual", "expense", "cost", "ledger", "account", "invoice", "balance", "cash", "debit", "credit", "variance", "gl_"],
  web_analytics: ["session", "pageview", "page_view", "bounce", "visitor", "clicks", "impression", "ctr", "event", "utm", "referrer", "device", "browser", "landing"],
  marketing: ["campaign", "spend", "roas", "cpa", "cpc", "cpm", "lead", "conversion", "channel", "ad_", "creative", "audience"],
  users_crm: ["user", "customer", "signup", "sign_up", "churn", "subscription", "plan", "segment", "lifecycle", "mrr", "tenure", "status", "email"],
  healthcare: ["patient", "admission", "diagnosis", "provider", "claim", "readmission", "icd", "procedure", "clinic", "hospital", "discharge", "encounter", "los", "bed"],
  logistics: ["shipment", "warehouse", "inventory", "delivery", "fulfillment", "carrier", "freight", "backorder", "lead_time", "on_time", "eta", "tracking", "pallet", "depot"],
  hr_people: ["employee", "headcount", "hire", "attrition", "salary", "performance", "recruit", "candidate", "manager", "department", "payroll", "onboarding"],
  education: ["student", "course", "enrollment", "grade", "attendance", "completion", "instructor", "assignment", "gpa", "semester", "lesson", "exam", "faculty"],
  real_estate: ["property", "listing", "rent", "lease", "occupancy", "sqft", "bedroom", "tenant", "vacancy", "mls", "sale_price", "square_feet", "appraisal"],
};

/** "What great looks like" per domain. Kept tight — quality over breadth.
 *  Each is injected verbatim into the plan contract when its domain is active. */
const PRIORS: Record<Domain, string> = {
  sales: `This looks like SALES / ORDERS data. A great sales dashboard typically features:
- Headline KPIs: total revenue, total profit (and margin %), order count, average order value — each shown WITH its change vs the previous period (e.g. ▲ 12% vs prior month) when a date column allows it.
- Trend over time of revenue (and profit alongside it) to show momentum; state the growth direction explicitly.
- Best AND worst performers (products, categories, regions) — ranked, not just totals.
- A breakdown by the most meaningful dimension present (region / segment / category).
- The single highest-leverage insight, favoring CHANGE over size: e.g. the fastest-growing region, or the most profitable segment×category combination.`,

  finance: `This looks like FINANCIAL / ACCOUNTING data. A great finance dashboard typically features:
- Headline KPIs: total/net amount, and a ratio (margin, burn, variance %) — each shown WITH period-over-period change (MoM/YoY) when dates allow.
- Trend over time with the month-over-month or year-over-year movement made explicit.
- Expense/category breakdown ranked by size, highlighting the largest movers.
- Actuals vs budget/target comparison when both are present.
- The key insight, favoring change/variance: the largest variance, the fastest-growing cost, or the direction of cash flow.`,

  web_analytics: `This looks like WEB / PRODUCT ANALYTICS data. A great analytics dashboard typically features:
- Headline KPIs: total sessions/users, conversion rate, engagement (or bounce) — rates not just counts, each WITH change vs the prior period.
- A trend of traffic/users over time as the primary visual, with growth direction called out.
- Traffic or conversion broken down by source / channel / device, ranked.
- A funnel or step-conversion view if the columns support it.
- The key insight, favoring change: the fastest-growing channel, the biggest conversion shift, or a notable drop.`,

  marketing: `This looks like MARKETING / CAMPAIGN data. A great marketing dashboard typically features:
- Headline KPIs: spend, return/revenue, and efficiency (ROAS / CPA / conversion rate) — each WITH period-over-period change when dates allow.
- Performance compared across campaigns or channels — ranked by efficiency (best AND worst), not just volume.
- A trend of spend vs return over time.
- A conversion funnel if the stages are present.
- The key insight, favoring change: the most improved or most declining channel/campaign by ROAS or CPA.`,

  users_crm: `This looks like USERS / CRM / CUSTOMER data. A great customer dashboard typically features:
- Headline KPIs: total users/customers, new this period, active/churned, MRR if present — each WITH growth vs the prior period.
- A growth-over-time trend (new or cumulative users) as a primary visual.
- Segmentation breakdown (plan / segment / status) and geographic distribution if present, ranked.
- Retention or churn framing when dates/status allow.
- The key insight, favoring change: the fastest-growing segment or the sharpest churn hotspot.`,

  healthcare: `This looks like HEALTHCARE / CLINICAL data. A great healthcare dashboard typically features:
- Headline KPIs: patient/encounter volume, average length of stay, readmission rate, and an outcome or utilization metric — rates as rates, each WITH change vs the prior period when dates allow.
- A trend over time of admissions/encounters as a primary visual, with direction called out.
- Breakdowns by department/provider/diagnosis, ranked — surface both the busiest and the outliers.
- A cohort or status framing (e.g. readmissions, bed occupancy) when the columns support it.
- The key insight, favoring change/risk: a rising readmission rate, an over-capacity unit, or a provider with an unusual outcome. Never present this as medical advice — it is operational reporting.`,

  logistics: `This looks like LOGISTICS / SUPPLY-CHAIN data. A great operations dashboard typically features:
- Headline KPIs: shipment/order volume, on-time delivery rate, average lead time, and inventory/backorder health — each WITH period-over-period change when dates allow.
- A trend over time of throughput or on-time rate, with direction made explicit.
- Breakdowns by warehouse/carrier/route, ranked by volume AND by performance (best and worst).
- A bottleneck view — where lead time or backorders concentrate.
- The key insight, favoring change/risk: a slipping carrier, a warehouse trending late, or a stock-out hotspot.`,

  hr_people: `This looks like HR / PEOPLE data. A great people dashboard typically features:
- Headline KPIs: headcount, hires this period, attrition rate, and average tenure — each WITH change vs the prior period when dates allow.
- A trend of headcount or hires/attrition over time, with net direction stated.
- Breakdowns by department/role/location, ranked — show where growth and attrition concentrate.
- A retention or tenure-distribution framing when the columns support it.
- The key insight, favoring change: the fastest-growing team or the sharpest attrition hotspot. Treat compensation/PII sensitively — aggregate, never single people out.`,

  education: `This looks like EDUCATION / LEARNING data. A great education dashboard typically features:
- Headline KPIs: enrollment, completion/pass rate, average grade or GPA, and attendance — rates as rates, each WITH change vs the prior period when dates allow.
- A trend over time of enrollment or completion as a primary visual.
- Breakdowns by course/instructor/cohort, ranked — surface strongest and weakest.
- An attainment or attendance distribution when the columns support it.
- The key insight, favoring change/outliers: a course with falling completion, or a cohort outperforming the rest.`,

  real_estate: `This looks like REAL-ESTATE / PROPERTY data. A great property dashboard typically features:
- Headline KPIs: active listings, occupancy/vacancy rate, average rent or sale price, and total portfolio value — each WITH change vs the prior period when dates allow.
- A trend over time of price or occupancy, with direction called out.
- Breakdowns by location/property-type/agent, ranked by value AND by performance.
- A vacancy or days-on-market framing when the columns support it.
- The key insight, favoring change: the fastest-appreciating area, or a property/segment dragging occupancy.`,

  generic: `No strong domain signal — treat this generically but be opinionated and match the quality of a domain-specific dashboard:
- Headline KPIs from the most meaningful numeric columns (sums for additive values, averages for rates), each WITH period-over-period change when a date column allows it; use a row count only if little else fits.
- A trend over time if any date column has enough range, with growth direction stated.
- Ranked breakdown(s) by the lowest-cardinality categorical column(s) — show top and bottom.
- A detail table for row-level inspection.
- The key insight, favoring change or outliers: a dominant category, a clear trend, or a striking anomaly.`,
};

/** Rule-based scoring. Returns the best domain and whether we're confident
 *  enough to skip the model fallback. */
export function scoreDomain(datasets: Dataset[]): { domain: Domain; confident: boolean; scores: Record<string, number> } {
  const names = datasets
    .flatMap((d) => d.profile.columns.map((c) => c.name.toLowerCase()))
    .join(" ");

  const scores: Record<string, number> = {};
  for (const [domain, signals] of Object.entries(SIGNALS)) {
    scores[domain] = signals.reduce((n, sig) => (names.includes(sig) ? n + 1 : n), 0);
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topDomain, topScore] = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;

  // Confident when there are real hits AND a clear leader over the runner-up.
  const confident = topScore >= 2 && topScore - secondScore >= 1;
  return {
    domain: confident ? (topDomain as Domain) : "generic",
    confident,
    scores,
  };
}

/** Generic stat-reasoning rules — domain-independent guidance that turns the
 *  profile stats already in the schema into concrete representation choices. */
export const STAT_REASONING = `Use the schema stats to choose representations (do not invent columns):
- A categorical column with 2-8 distinct values → a breakdown chart (bar or pie). With 9-25 → a ranked horizontal bar. With >25 → a top-N table, not a chart.
- A date/time column spanning 3+ distinct periods → a trend over time as a primary visual.
- Two numeric columns that are clearly related (e.g. revenue & profit, spend & return) → show them together and derive the ratio (margin, ROAS).
- A high-cardinality identifier (order_id, email, user_id) → never chart it; use it only in detail tables.
- Prefer SUM for additive money/quantity columns and AVG for rates/scores.
- Period-over-period: when a date column exists, compute each headline KPI for the latest period AND the one before it, and show the % change. The trend visual is not a substitute — the change belongs on the KPI itself.`;

/** Anti-bloat guardrail — keeps the richer priors from producing sprawl. */
export const COMPOSITION_RULES = `Composition:
- Aim for a focused single screen: roughly 4 KPIs, 2-4 charts, and at most one detail table. Do not exceed ~6 visual sections.
- Every element must earn its place. No two charts should show the same breakdown; cut anything redundant.
- Lead with the most decision-relevant content (KPIs with change, then the primary trend), then supporting breakdowns, then detail.`;

/** Build the enrichment block injected into the plan contract. `modelDomain`
 *  is the model's self-classification (fallback) when rules weren't confident. */
export function buildEnrichment(datasets: Dataset[], modelDomain?: string): { domain: Domain; block: string } {
  const ruled = scoreDomain(datasets);
  const valid = !!(modelDomain && (PRIORS as Record<string, string>)[modelDomain]);
  const domain: Domain = ruled.confident ? ruled.domain : valid ? (modelDomain as Domain) : "generic";
  const block = [
    "Domain guidance:",
    PRIORS[domain],
    "",
    STAT_REASONING,
    "",
    COMPOSITION_RULES,
  ].join("\n");
  return { domain, block };
}

/** Exposed for the contract's self-classification fallback prompt. */
export const DOMAIN_LIST: Domain[] = ["sales", "finance", "web_analytics", "marketing", "users_crm", "healthcare", "logistics", "hr_people", "education", "real_estate", "generic"];

/** Compact schema summary for the classifier prompt: `table(col:type, ...)`. */
export function schemaSummary(datasets: Dataset[]): string {
  return datasets
    .map((d) => `${d.tableName}(${d.profile.columns.map((c) => `${c.name}:${c.type}`).join(", ")})`)
    .join("; ");
}

export const CLASSIFY_SYSTEM =
  "You classify a dataset into exactly one analytics domain for dashboard design. " +
  "Choose the single best fit from this list: " + DOMAIN_LIST.join(", ") + ". " +
  'Reply with ONLY the domain string (e.g. "finance") and nothing else. If none clearly fit, reply "generic".';

/** Model-based detection fallback. Asks the (injected) model to self-classify the
 *  schema into DOMAIN_LIST. Best-effort: returns a valid Domain, or null on any
 *  failure / unrecognized answer. The model call is injected for testability. */
export async function classifyDomain(
  datasets: Dataset[],
  run: (system: string, user: string) => Promise<string>,
): Promise<Domain | null> {
  try {
    const raw = await run(CLASSIFY_SYSTEM, "Columns:\n" + schemaSummary(datasets) + "\n\nDomain:");
    const tokens = (raw || "").toLowerCase().match(/[a-z_]+/g) ?? [];
    const hit = tokens.find((t) => (DOMAIN_LIST as string[]).includes(t));
    return (hit as Domain) ?? null;
  } catch {
    return null;
  }
}
export { PRIORS };