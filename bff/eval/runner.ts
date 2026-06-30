// bff/eval/runner.ts — Wave 2 / P7, Step 2: the orchestrator.
// For each golden case: generate an app (injected), run the deterministic scorers,
// optionally run the LLM judge (injected), then aggregate into a report. Generation
// and judging are INJECTED so this module is pure and testable offline; the live
// wiring (HTTP generate + Gemini judge) lives in run.ts.

import type { GeneratedApp } from "../../shared/types";
import { scoreApp, mainFileContent, type DimensionResult } from "./scorers";
import type { GoldenCase } from "./golden";
import type { JudgeResult } from "./judge";

export type GenerateForEval = (c: GoldenCase) => Promise<GeneratedApp>;
export type JudgeForEval = (prompt: string, code: string) => Promise<JudgeResult | null>;

export interface CaseReport {
  id: string;
  domain: string;
  pass: boolean;          // all HARD dimensions passed
  score: number;          // fraction of all dimensions passed
  dimensions: DimensionResult[];
  judge?: JudgeResult | null;
}

export interface EvalReport {
  cases: CaseReport[];
  total: number;
  passed: number;
  meanScore: number;
  meanPolish: number | null;
  meanPromptResponsive: number | null;
}

export async function runEval(
  cases: GoldenCase[],
  generate: GenerateForEval,
  judge?: JudgeForEval,
): Promise<EvalReport> {
  const reports: CaseReport[] = [];

  for (const c of cases) {
    let app: GeneratedApp;
    try {
      app = await generate(c);
    } catch (err: any) {
      reports.push({
        id: c.id, domain: c.domain, pass: false, score: 0,
        dimensions: [{ dimension: "generate", hard: true, pass: false, detail: String(err?.message ?? err) }],
        judge: null,
      });
      continue;
    }

    const ctx = {
      datasets: c.datasets.map((d) => ({ tableName: d.tableName, columns: d.columns.map((x) => x.name) })),
      exemplarCode: c.exemplarCode,
    };
    const s = scoreApp(app, ctx);
    const j = judge ? await judge(c.prompt, mainFileContent(app)) : undefined;

    reports.push({ id: c.id, domain: c.domain, pass: s.pass, score: s.score, dimensions: s.results, judge: j });
  }

  const passed = reports.filter((r) => r.pass).length;
  const meanScore = reports.length ? reports.reduce((a, r) => a + r.score, 0) / reports.length : 0;
  const judged = reports.filter((r) => r.judge);
  const meanPolish = judged.length ? judged.reduce((a, r) => a + (r.judge!.polish), 0) / judged.length : null;
  const meanPromptResponsive = judged.length ? judged.reduce((a, r) => a + (r.judge!.promptResponsive), 0) / judged.length : null;

  return { cases: reports, total: reports.length, passed, meanScore, meanPolish, meanPromptResponsive };
}

/** Render a compact, human-readable report for the CLI. */
export function formatReport(r: EvalReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("text2UI eval report");
  lines.push("===================");
  for (const c of r.cases) {
    const mark = c.pass ? "PASS" : "FAIL";
    const judge = c.judge ? ` polish=${c.judge.polish}/5 prompt=${c.judge.promptResponsive}/5` : "";
    lines.push(`[${mark}] ${c.id.padEnd(26)} score=${(c.score * 100).toFixed(0)}%${judge}`);
    const failed = c.dimensions.filter((d) => !d.pass);
    for (const d of failed) {
      lines.push(`        ${d.hard ? "x" : "-"} ${d.dimension}: ${d.detail}`);
    }
  }
  lines.push("-------------------");
  lines.push(`cases: ${r.passed}/${r.total} passed (hard)   mean score: ${(r.meanScore * 100).toFixed(0)}%`);
  if (r.meanPolish !== null) {
    lines.push(`judge: polish ${r.meanPolish.toFixed(2)}/5   prompt-responsive ${r.meanPromptResponsive!.toFixed(2)}/5`);
  }
  lines.push("");
  return lines.join("\n");
}
