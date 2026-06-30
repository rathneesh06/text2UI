// bff/design-rag/synth/archetypes.ts — the 5 approved domain schemas.
// Each archetype has exactly one PRIMARY metric (a per-category time series whose
// magnitude follows the `scale` knob); other metrics are either independent base
// draws (scale-independent rates/values) or derived (keep multi-series charts
// internally consistent, incl. monotonic funnels).
import { faker } from "@faker-js/faker";
import type { Rng } from "./prng";
import type { DistSpec } from "./distributions";
import { betaFromMean } from "./distributions";

export type ScaleHint = "money" | "count" | "rate" | "ratio" | "duration";

export interface MetricDef {
  name: string;
  scaleHint: ScaleHint;
  decimals?: number;
  primary?: boolean;                              // time-series driver (magnitude from `scale`)
  base?: DistSpec;                                // independent per-row draw (scale-independent)
  derive?: (row: Record<string, number>, rng: Rng) => number;
}

export interface BreakdownDef {
  name: string;
  primary?: boolean;                              // dimension the primary metric splits across
  values?: string[];                              // fixed enum vocabulary
  faker?: () => string;                           // variable vocabulary (seeded)
}

export interface Archetype {
  id: string;
  domain: string;
  timeCol: string;
  metrics: MetricDef[];
  breakdowns: BreakdownDef[];
}

const r2 = (lo: number, hi: number, rng: Rng) => rng.float(lo, hi);

export const ARCHETYPES: Record<string, Archetype> = {
  sales: {
    id: "sales", domain: "sales", timeCol: "date",
    metrics: [
      { name: "aov", scaleHint: "money", decimals: 0, base: { kind: "normal", params: [140, 35] } },
      { name: "revenue", scaleHint: "money", decimals: 0, primary: true },
      { name: "orders", scaleHint: "count", decimals: 0, derive: (r) => r.revenue / Math.max(1, r.aov) },
      { name: "refund_rate", scaleHint: "rate", decimals: 3, base: betaFromMean(0.02, 60) },
      { name: "new_customers", scaleHint: "count", decimals: 0, derive: (r, g) => r.orders * r2(0.2, 0.5, g) },
    ],
    breakdowns: [
      { name: "region", primary: true, values: ["North America", "EMEA", "APAC", "LATAM", "MEA", "Oceania"] },
      { name: "product_category", faker: () => faker.commerce.department() },
      { name: "channel", values: ["Direct", "Organic", "Social", "Email", "Affiliate"] },
    ],
  },

  finance: {
    id: "finance", domain: "finance", timeCol: "month",
    metrics: [
      { name: "revenue", scaleHint: "money", decimals: 0, primary: true },
      { name: "expenses", scaleHint: "money", decimals: 0, derive: (r, g) => r.revenue * r2(0.55, 0.9, g) },
      { name: "net_income", scaleHint: "money", decimals: 0, derive: (r) => r.revenue - r.expenses },
      { name: "margin", scaleHint: "ratio", decimals: 3, derive: (r) => r.net_income / Math.max(1, r.revenue) },
      { name: "cash_flow", scaleHint: "money", decimals: 0, derive: (r, g) => r.net_income * r2(0.6, 1.1, g) },
    ],
    breakdowns: [
      { name: "expense_category", primary: true, values: ["Payroll", "Infrastructure", "Marketing", "R&D", "G&A"] },
      { name: "department", values: ["Engineering", "Sales", "Marketing", "Operations", "Support"] },
    ],
  },

  marketing: {
    id: "marketing", domain: "marketing", timeCol: "date",
    metrics: [
      { name: "impressions", scaleHint: "count", decimals: 0, primary: true },
      { name: "ctr", scaleHint: "rate", decimals: 4, base: betaFromMean(0.02, 80) },
      { name: "clicks", scaleHint: "count", decimals: 0, derive: (r) => r.impressions * r.ctr },
      { name: "cvr", scaleHint: "rate", decimals: 4, base: betaFromMean(0.05, 60) },
      { name: "conversions", scaleHint: "count", decimals: 0, derive: (r) => r.clicks * r.cvr },
      { name: "spend", scaleHint: "money", decimals: 0, derive: (r, g) => (r.impressions / 1000) * r2(4, 12, g) },
      { name: "cpa", scaleHint: "money", decimals: 2, derive: (r) => r.spend / Math.max(1, r.conversions) },
      { name: "roas", scaleHint: "ratio", decimals: 2, derive: (r, g) => (r.conversions * r2(40, 120, g)) / Math.max(1, r.spend) },
    ],
    breakdowns: [
      { name: "channel", primary: true, values: ["Google", "Meta", "LinkedIn", "TikTok", "Email"] },
      { name: "campaign", faker: () => faker.commerce.productName() },
    ],
  },

  web_analytics: {
    id: "web_analytics", domain: "web_analytics", timeCol: "date",
    metrics: [
      { name: "sessions", scaleHint: "count", decimals: 0, primary: true },
      { name: "users", scaleHint: "count", decimals: 0, derive: (r, g) => r.sessions * r2(0.6, 0.85, g) },
      { name: "bounce_rate", scaleHint: "rate", decimals: 3, base: betaFromMean(0.4, 30) },
      { name: "avg_duration", scaleHint: "duration", decimals: 0, base: { kind: "lognormal", params: [5.1, 0.5] } },
      { name: "pageviews", scaleHint: "count", decimals: 0, derive: (r, g) => r.sessions * r2(1.5, 4, g) },
      { name: "conversion_rate", scaleHint: "rate", decimals: 4, base: betaFromMean(0.03, 80) },
    ],
    breakdowns: [
      { name: "source", primary: true, values: ["Organic", "Direct", "Social", "Referral", "Paid"] },
      { name: "device", values: ["Desktop", "Mobile", "Tablet"] },
    ],
  },

  users_crm: {
    id: "users_crm", domain: "users_crm", timeCol: "month",
    metrics: [
      { name: "leads", scaleHint: "count", decimals: 0, primary: true },
      { name: "qualified", scaleHint: "count", decimals: 0, derive: (r, g) => r.leads * r2(0.4, 0.7, g) },
      { name: "proposals", scaleHint: "count", decimals: 0, derive: (r, g) => r.qualified * r2(0.3, 0.6, g) },
      { name: "won", scaleHint: "count", decimals: 0, derive: (r, g) => r.proposals * r2(0.3, 0.6, g) },
      { name: "deal_value", scaleHint: "money", decimals: 0, base: { kind: "lognormal", params: [8.6, 0.6] } },
      { name: "mrr", scaleHint: "money", decimals: 0, derive: (r) => r.won * r.deal_value },
      { name: "churn_rate", scaleHint: "rate", decimals: 3, base: betaFromMean(0.03, 80) },
    ],
    breakdowns: [
      { name: "plan_tier", primary: true, values: ["Free", "Pro", "Enterprise"] },
      { name: "industry", values: ["Technology", "Finance", "Healthcare", "Retail", "Manufacturing", "Education"] },
      { name: "rep", faker: () => faker.person.fullName() },
    ],
  },
};

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES);
