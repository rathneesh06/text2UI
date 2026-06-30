// bff/eval/run.ts — Wave 2 / P7, Step 2: the LIVE eval CLI.
// Generates each golden case through the real /api/generate pipeline (so it
// exercises plan + assemble + model + continuation exactly as production does),
// scores it deterministically, and runs the LLM judge. Costs API calls — this is
// NOT part of the gated `test`; run it before big changes (e.g. before N4/N1).
//
// Prereqs: the BFF must be running (npm run dev:bff) and GEMINI_API_KEY set.
// Usage:  npm run test:eval:live            (with judge)
//         npm run test:eval:live -- --no-judge   (deterministic only)
import "dotenv/config"; // MUST be first so aiflow's module-level API_KEY is populated
import { GOLDEN, type GoldenCase } from "./golden";
import { runEval, formatReport } from "./runner";
import { makeJudge } from "./judge";
import { callGemini } from "../aiflow";
import { selectExemplar } from "../exemplars";
import type { Dataset, GeneratedApp } from "../../shared/types";
import type { Domain } from "../domain";

const BFF = process.env.BFF_URL ?? process.env.VITE_BFF_URL ?? "http://localhost:8787";

function toDatasets(c: GoldenCase): Dataset[] {
  return c.datasets.map((d) => ({
    tableName: d.tableName,
    profile: {
      source: { filename: `${d.tableName}.csv`, format: "csv" },
      rowCount: d.rows.length,
      columns: d.columns.map((col) => ({
        name: col.name, type: col.type ?? "string", nullable: false, uniqueCount: 0, sampleValues: [],
      })),
      sampleRows: d.rows.slice(0, 5),
    },
  })) as unknown as Dataset[];
}

const generate = async (c: GoldenCase): Promise<GeneratedApp> => {
  const res = await fetch(`${BFF}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datasets: toDatasets(c), userPrompt: c.prompt, dataAccess: "inline" }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? `generate failed (HTTP ${res.status})`);
  return json as GeneratedApp;
};

const judge = makeJudge(async (system, user) => {
  const { text } = await callGemini(system, user, { temperature: 0.2, thinkingBudget: 0 });
  return text;
});

(async () => {
  const noJudge = process.argv.includes("--no-judge");
  // attach the exemplar injected for each domain so leakage can be scored (best-effort)
  const cases = GOLDEN.map((c) => ({ ...c, exemplarCode: selectExemplar(c.domain as Domain)?.code }));
  console.log(`Running ${cases.length} golden cases against ${BFF}${noJudge ? " (no judge)" : " (with judge)"}...`);
  const report = await runEval(cases, generate, noJudge ? undefined : judge);
  process.stdout.write(formatReport(report));
  process.exit(report.passed === report.total ? 0 : 1);
})().catch((err) => {
  console.error("eval run failed:", err?.message ?? err);
  process.exit(1);
});
