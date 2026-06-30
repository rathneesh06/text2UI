import assert from "node:assert";
import { THEMES, THEME_LIST, AFFINITY, selectDesign, designBlock, CRAFT_FLOOR, LAYOUT_FLOOR } from "./design";
import { assemble } from "./assembler";
import type { Domain } from "./domain";
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

const DOMAINS: Domain[] = ["sales", "finance", "web_analytics", "marketing", "users_crm", "generic"];

// ---- every domain maps to a real, well-formed VIBRANT theme ----
{
  for (const d of DOMAINS) {
    const t = selectDesign(d);
    assert.ok(t && THEME_LIST.includes(t.id), `${d} resolves to a real theme (${t?.id})`);
    assert.ok(t.canvas.includes("bg-") && t.canvas.includes("text-"), `${t.id} canvas has bg+text`);
    assert.ok(t.surface.includes("bg-"), `${t.id} surface has a background`);
    assert.match(t.accentHex, /^#[0-9a-f]{6}$/i, `${t.id} accentHex is hex`);
    assert.ok(t.accentGradient.includes("bg-gradient"), `${t.id} has a gradient accent`);
    // vibrant: 6-8 color ramp, all hex
    assert.ok(t.categorical.length >= 6 && t.categorical.length <= 8, `${t.id} ramp is 6-8 colors (got ${t.categorical.length})`);
    for (const c of t.categorical) assert.match(c, /^#[0-9a-f]{6}$/i, `${t.id} ramp color ${c} is hex`);
    // per-KPI chip rotation present
    assert.ok(t.kpiChips.length >= 3, `${t.id} has >=3 KPI chips`);
    for (const chip of t.kpiChips) assert.ok(chip.includes("bg-") && chip.includes("text-"), `${t.id} chip "${chip}" is bg+text`);
    // distinct chips (not all the same color)
    assert.equal(new Set(t.kpiChips).size, t.kpiChips.length, `${t.id} KPI chips are distinct`);
    assert.match(t.gridHex, /^#[0-9a-f]{6}$/i, `${t.id} gridHex is hex`);
    assert.ok(["font-sans", "font-serif", "font-mono"].includes(t.headingFamily), `${t.id} uses a built-in font family`);
    assert.match(t.barRadius, /^\[\d+, \d+, 0, 0\]$/, `${t.id} barRadius is a recharts array literal`);
  }
}

// ---- affinity is the intended vibrant mapping ----
{
  assert.equal(AFFINITY.finance, "prism", "finance -> Prism");
  assert.equal(AFFINITY.sales, "aurora", "sales -> Aurora");
  assert.equal(AFFINITY.marketing, "pop", "marketing -> Pop");
  assert.equal(AFFINITY.web_analytics, "spectrum", "web analytics -> Spectrum");
  assert.equal(AFFINITY.users_crm, "sunset", "crm -> Sunset");
  assert.equal(AFFINITY.generic, "aurora", "generic -> Aurora default");
  const used = new Set(DOMAINS.map((d) => selectDesign(d).id));
  assert.ok(used.size >= 5, `domains span >=5 distinct themes (got ${used.size})`);
}

// ---- designBlock renders vibrant specifics ----
{
  const fin = designBlock("finance");
  assert.ok(fin.includes("Prism"), "finance block names its theme");
  assert.ok(fin.includes("#2563eb"), "finance block carries its accent hex");
  assert.ok(fin.includes("gradient"), "finance block mentions a gradient");
  assert.ok(fin.includes("different vibrant icon chip"), "block instructs per-KPI chip variety");

  const mkt = designBlock("marketing");
  assert.ok(mkt.includes("Pop") && mkt.includes("#c026d3"), "marketing is the Pop theme");
  assert.ok(mkt.includes("rounded-2xl"), "marketing carries its radius");

  // 8-color ramp surfaces in the block
  assert.ok(mkt.split(",").length >= 8, "marketing block lists a rich ramp");

  assert.notEqual(designBlock("finance"), designBlock("marketing"), "different domains => different design blocks");
}

// ---- craft floor embraces vibrance but keeps legibility guardrails ----
{
  assert.ok(CRAFT_FLOOR.toLowerCase().includes("vibrant"), "craft floor embraces vibrance");
  assert.ok(CRAFT_FLOOR.toLowerCase().includes("same color across every chart"), "keeps entity-color consistency");
  assert.ok(CRAFT_FLOOR.toLowerCase().includes("readable"), "keeps body text readable");
  for (const kw of ["Spacing", "hierarchy", "states", "gridlines"]) {
    assert.ok(CRAFT_FLOOR.toLowerCase().includes(kw.toLowerCase()), `craft floor covers ${kw}`);
  }
}

// ---- injection is build-turn-only and includes both floor + theme ----
{
  const data = [ds("ad_spend", ["campaign", "channel", "spend", "conversions", "revenue"])]; // -> marketing
  const build = assemble({ datasets: data, userPrompt: "build it" });
  assert.ok(build.user_prompt.includes("Craft floor"), "build turn injects the craft floor");
  assert.ok(build.user_prompt.includes("Design system to apply"), "build turn injects the design block");
  assert.ok(build.user_prompt.includes("Pop"), "build turn uses the domain-affinity theme");

  const edit = assemble({ datasets: data, userPrompt: "tweak", currentCode: "export default function App(){return null}" });
  assert.ok(!edit.user_prompt.includes("Design system to apply"), "edit turn does NOT re-inject design");
  assert.ok(!edit.user_prompt.includes("Craft floor"), "edit turn does NOT re-inject craft floor");

  const heal = assemble({ datasets: data, userPrompt: "x", currentCode: "code", lastError: "boom" });
  assert.ok(!heal.user_prompt.includes("Design system to apply"), "heal turn does NOT re-inject design");
}

console.log("design enrichment (vibrant): all assertions passed");

// ---- layout floor: compact, grid-based, build-turn only --------------------
{
  // content: the floor mandates a grid, constrained chart height, and density
  assert.match(LAYOUT_FLOOR, /grid-cols/, "layout floor mandates a multi-column grid");
  assert.match(LAYOUT_FLOOR, /ResponsiveContainer|h-64|h-72|height/i, "layout floor constrains chart height");
  assert.match(LAYOUT_FLOOR, /compact|information-dense/i, "layout floor calls for density");
  assert.match(LAYOUT_FLOOR, /COLUMN COUNT|overflow-x-auto/i, "tables are sized to columns, not full-width by default");

  const data = [ds("ad_spend", ["campaign", "channel", "spend"])];
  const build = assemble({ datasets: data, userPrompt: "build it" });
  assert.ok(build.user_prompt.includes("grid-cols"), "build turn injects the layout floor");
  const heal = assemble({ datasets: data, userPrompt: "x", currentCode: "code", lastError: "boom" });
  assert.ok(!heal.user_prompt.includes("grid-cols"), "heal turn does NOT re-inject the layout floor");
  console.log("layout floor: all assertions passed");
}