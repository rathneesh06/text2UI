// bff/eval/golden.ts — Wave 2 / P7, Step 2: the golden set.
// A small, curated set of (dataset, prompt) cases spanning the supported domains
// plus edge cases (terse prompt, multi-table, date-heavy). The runner generates
// an app per case and grades it with the Step-1 scorers (+ optional LLM judge).
// Keep this tight and high-signal — every case should test something distinct.

export interface GoldenColumn { name: string; type?: string }
export interface GoldenDataset {
  tableName: string;
  columns: GoldenColumn[];
  rows: Record<string, unknown>[];
}
export interface GoldenCase {
  id: string;
  domain: string;
  prompt: string;
  datasets: GoldenDataset[];
  /** Attached at runtime (live runner) so leakage can be scored. */
  exemplarCode?: string;
}

export const GOLDEN: GoldenCase[] = [
  {
    id: "sales-revenue-region",
    domain: "sales",
    prompt: "Show revenue by region and the top products, with KPIs for total revenue and order count.",
    datasets: [{
      tableName: "sales",
      columns: [
        { name: "order_id", type: "string" }, { name: "region", type: "string" },
        { name: "product", type: "string" }, { name: "amount", type: "number" },
        { name: "closed_at", type: "date" },
      ],
      rows: [
        { order_id: "o1", region: "NA", product: "Widget", amount: 120, closed_at: "2024-01-05" },
        { order_id: "o2", region: "EU", product: "Gadget", amount: 90, closed_at: "2024-02-11" },
        { order_id: "o3", region: "APAC", product: "Widget", amount: 140, closed_at: "2024-03-02" },
      ],
    }],
  },
  {
    id: "finance-budget-actual",
    domain: "finance",
    prompt: "Budget vs actual by account over the year, highlighting the biggest variances.",
    datasets: [{
      tableName: "ledger",
      columns: [
        { name: "account", type: "string" }, { name: "month", type: "date" },
        { name: "budget", type: "number" }, { name: "actual", type: "number" },
      ],
      rows: [
        { account: "Marketing", month: "2024-01", budget: 1000, actual: 1200 },
        { account: "R&D", month: "2024-01", budget: 5000, actual: 4300 },
      ],
    }],
  },
  {
    id: "web-traffic-overview",
    domain: "web_analytics",
    prompt: "Traffic overview: sessions and pageviews over time with a device breakdown and bounce rate.",
    datasets: [{
      tableName: "traffic",
      columns: [
        { name: "date", type: "date" }, { name: "sessions", type: "number" },
        { name: "pageviews", type: "number" }, { name: "bounce_rate", type: "number" },
        { name: "device", type: "string" },
      ],
      rows: [
        { date: "2024-01-01", sessions: 500, pageviews: 1400, bounce_rate: 0.42, device: "mobile" },
        { date: "2024-01-02", sessions: 620, pageviews: 1700, bounce_rate: 0.39, device: "desktop" },
      ],
    }],
  },
  {
    id: "marketing-campaign-roas",
    domain: "marketing",
    prompt: "Campaign performance: spend, conversions, and ROAS by channel.",
    datasets: [{
      tableName: "campaigns",
      columns: [
        { name: "campaign", type: "string" }, { name: "channel", type: "string" },
        { name: "spend", type: "number" }, { name: "conversions", type: "number" },
        { name: "revenue", type: "number" },
      ],
      rows: [
        { campaign: "Spring", channel: "Search", spend: 2000, conversions: 50, revenue: 8000 },
        { campaign: "Spring", channel: "Social", spend: 1500, conversions: 30, revenue: 4000 },
      ],
    }],
  },
  {
    id: "crm-subscription-health",
    domain: "users_crm",
    prompt: "Subscription health: MRR trend, plan mix, and churn.",
    datasets: [{
      tableName: "subscribers",
      columns: [
        { name: "user_id", type: "string" }, { name: "signup_date", type: "date" },
        { name: "plan", type: "string" }, { name: "mrr", type: "number" },
        { name: "churned", type: "boolean" },
      ],
      rows: [
        { user_id: "u1", signup_date: "2023-11-01", plan: "Pro", mrr: 49, churned: false },
        { user_id: "u2", signup_date: "2023-12-15", plan: "Starter", mrr: 19, churned: true },
      ],
    }],
  },
  {
    id: "terse-generic",
    domain: "generic",
    prompt: "make a dashboard",
    datasets: [{
      tableName: "data",
      columns: [
        { name: "category", type: "string" }, { name: "value", type: "number" },
        { name: "recorded_at", type: "date" },
      ],
      rows: [
        { category: "A", value: 10, recorded_at: "2024-01-01" },
        { category: "B", value: 22, recorded_at: "2024-01-02" },
      ],
    }],
  },
];
