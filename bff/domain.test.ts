import assert from "node:assert";
import { scoreDomain, buildEnrichment, classifyDomain, DOMAIN_LIST, type Domain } from "./domain";
import type { Dataset } from "../shared/types";

function ds(tableName: string, cols: string[]): Dataset {
  return {
    tableName,
    profile: {
      source: { filename: `${tableName}.csv`, format: "csv" },
      rowCount: 100,
      columns: cols.map((name) => ({ name, type: "string", nullable: false, uniqueCount: 5, sampleValues: [] })),
      sampleRows: [],
    },
  } as any;
}

// ---- DOMAIN_LIST is the canonical set (10 real + generic) -----------------
{
  assert.deepEqual(DOMAIN_LIST, ["sales", "finance", "web_analytics", "marketing", "users_crm", "healthcare", "logistics", "hr_people", "education", "real_estate", "generic"]);
}

// ---- rule-based detection: each domain's signals win confidently ----------
const CASES: { cols: string[]; expect: Domain }[] = [
  { cols: ["order_id", "revenue", "product", "quantity"], expect: "sales" },
  { cols: ["budget", "actual", "expense", "account"], expect: "finance" },
  { cols: ["session_id", "pageview", "bounce_rate", "visitor"], expect: "web_analytics" },
  { cols: ["campaign", "spend", "roas", "cpa"], expect: "marketing" },
  { cols: ["customer_id", "churn", "subscription", "mrr"], expect: "users_crm" },
  { cols: ["patient_id", "admission_date", "diagnosis", "provider", "readmission"], expect: "healthcare" },
  { cols: ["shipment_id", "warehouse", "carrier", "lead_time", "on_time"], expect: "logistics" },
  { cols: ["employee_id", "headcount", "attrition", "salary", "department"], expect: "hr_people" },
  { cols: ["student_id", "course", "enrollment", "grade", "attendance"], expect: "education" },
  { cols: ["property_id", "listing", "occupancy", "rent", "sqft"], expect: "real_estate" },
];
{
  for (const c of CASES) {
    const r = scoreDomain([ds("t", c.cols)]);
    assert.equal(r.domain, c.expect, `${c.cols.join(",")} -> ${c.expect} (got ${r.domain})`);
    assert.ok(r.confident, `${c.expect} detection is confident`);
    // scores object covers all signal domains
    for (const d of ["sales", "finance", "web_analytics", "marketing", "users_crm", "healthcare", "logistics", "hr_people", "education", "real_estate"]) {
      assert.ok(typeof r.scores[d] === "number", `scores has ${d}`);
    }
    assert.ok(r.scores[c.expect] >= 2, `${c.expect} scored >= 2`);
  }
}

// ---- low signal / ambiguity falls back to generic (not confident) ---------
{
  const none = scoreDomain([ds("t", ["foo", "bar", "baz", "value"])]);
  assert.equal(none.domain, "generic", "no signals -> generic");
  assert.ok(!none.confident, "no signals -> not confident");

  // one-hit tie across two domains: below the >=2 threshold -> generic
  const tie = scoreDomain([ds("t", ["revenue", "budget"])]); // sales:1, finance:1
  assert.equal(tie.domain, "generic", "single-hit tie -> generic");
  assert.ok(!tie.confident, "single-hit tie -> not confident");
}

// ---- buildEnrichment: model fallback only applies when unconfident --------
{
  // confident rule beats the model's guess
  const salesData = [ds("t", ["order_id", "revenue", "product", "quantity"])];
  const a = buildEnrichment(salesData, "finance");
  assert.equal(a.domain, "sales", "confident rule overrides modelDomain");

  // unconfident -> use modelDomain
  const vague = [ds("t", ["foo", "bar", "baz"])];
  const b = buildEnrichment(vague, "finance");
  assert.equal(b.domain, "finance", "unconfident -> falls back to modelDomain");

  // unconfident + no model -> generic
  const c = buildEnrichment(vague);
  assert.equal(c.domain, "generic", "unconfident + no model -> generic");

  // block carries the prior + the shared reasoning/composition rules
  assert.ok(a.block.includes("Domain guidance:"), "block has the guidance header");
  assert.ok(a.block.includes("Composition:"), "block includes composition rules");
  assert.notEqual(buildEnrichment(salesData).block, buildEnrichment([ds("t", ["budget", "actual", "expense", "account"])]).block, "different domains -> different blocks");
}

// ---- N4: model-based detection fallback (classifyDomain) -------------------
{
  const ambiguous = [ds("t", ["id", "name", "value", "ts"])]; // no strong rule signal
  // injected model returns a clean domain
  assert.equal(await classifyDomain(ambiguous, async () => "healthcare"), "healthcare", "parses a clean answer");
  // model answers in a sentence -> still parsed
  assert.equal(await classifyDomain(ambiguous, async () => "This looks like real_estate data."), "real_estate", "parses domain from a sentence");
  // unrecognized answer -> null
  assert.equal(await classifyDomain(ambiguous, async () => "no idea"), null, "unrecognized -> null");
  // model throws -> null (best-effort)
  assert.equal(await classifyDomain(ambiguous, async () => { throw new Error("api down"); }), null, "model failure -> null");
}

// ---- buildEnrichment honors modelDomain only when rules are unconfident -----
{
  const ambiguous = [ds("t", ["id", "name", "value"])];
  assert.equal(scoreDomain(ambiguous).confident, false, "ambiguous schema is unconfident");
  assert.equal(buildEnrichment(ambiguous, "healthcare").domain, "healthcare", "model fallback used when unconfident");
  assert.equal(buildEnrichment(ambiguous, "banana").domain, "generic", "invalid modelDomain -> generic");
  // confident rule detection wins over a (wrong) model suggestion
  const sales = [ds("orders", ["order_id", "revenue", "product", "units", "discount"])];
  assert.equal(scoreDomain(sales).confident, true, "sales schema is confident");
  assert.equal(buildEnrichment(sales, "healthcare").domain, "sales", "confident rules override modelDomain");
}

console.log("domain.test.ts: all assertions passed");
