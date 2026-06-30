// exemplars.test.ts — Phase 4 exemplar library. Run: npx tsx bff/exemplars.test.ts
import assert from "node:assert/strict";
import { REGISTRY, selectExemplar, exemplarBlock, type Exemplar } from "./exemplars";
import { assemble } from "./assembler";
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
  };
}

// ---- registry is seeded; selection returns live entries ----
{
  assert.ok(REGISTRY.length >= 1, "registry is seeded with exemplars");
  // every seeded entry that has code loaded should be selectable by its domain
  const sales = selectExemplar("sales");
  assert.ok(sales === null || sales.domain === "sales" || sales.domain === "generic", "sales selection returns sales or generic fallback");
}

console.log("exemplar registry: assertions passed");

// ---- selection logic (seed the registry temporarily) ----
{
  const before = REGISTRY.length;
  const salesEx: Exemplar = { id: "sales_t", domain: "sales", dataShape: "x", whatsGood: "y", code: "// SALES_EXEMPLAR_CODE" };
  const genericEx: Exemplar = { id: "gen_t", domain: "generic", dataShape: "x", whatsGood: "y", code: "// GENERIC_EXEMPLAR_CODE" };
  // splice to front so these win over any seeded same-domain entries
  REGISTRY.unshift(salesEx, genericEx);

  assert.equal(selectExemplar("sales")?.id, "sales_t", "exact domain match wins");
  const fin = selectExemplar("finance");
  assert.ok(fin?.domain === "finance" || fin?.id === "gen_t", "falls back to generic or a seeded finance entry");

  const block = exemplarBlock("sales");
  assert.ok(block.includes("STRUCTURE and QUALITY, not its content or its skin"), "block carries reframed structure/quality framing");
  assert.ok(block.includes("Do NOT copy its columns"), "block warns against copying columns");
  assert.ok(block.includes("the Design system wins"), "block defers skin to the design system");

  const data = [ds("sales_orders", ["order_id", "revenue", "profit"])];
  const build = assemble({ datasets: data, userPrompt: "build it" });
  assert.ok(build.user_prompt.includes("Reference implementation"), "build turn injects exemplar when available");

  const edit = assemble({ datasets: data, userPrompt: "add a filter", currentCode: "export default function App(){return null}" });
  assert.ok(!edit.user_prompt.includes("Reference implementation"), "edit turn does NOT inject exemplar");

  const heal = assemble({ datasets: data, userPrompt: "x", currentCode: "code", lastError: "boom" });
  assert.ok(!heal.user_prompt.includes("Reference implementation"), "heal turn does NOT inject exemplar");

  // restore: remove only the two we added
  REGISTRY.splice(0, 2);
  assert.equal(REGISTRY.length, before, "registry restored to seeded state");
}

console.log("exemplar selection + injection: all assertions passed");

// ---- A/B kill switch ----
{
  const prev = process.env.T2UI_NO_EXEMPLARS;
  process.env.T2UI_NO_EXEMPLARS = "1";
  assert.equal(selectExemplar("sales"), null, "kill switch disables exemplar selection");
  assert.equal(exemplarBlock("sales"), "", "kill switch yields empty block");
  if (prev === undefined) delete process.env.T2UI_NO_EXEMPLARS; else process.env.T2UI_NO_EXEMPLARS = prev;
  assert.ok((selectExemplar("sales")?.code.length ?? 0) > 0, "re-enabled after unsetting switch");
}
console.log("exemplar kill switch: all assertions passed");