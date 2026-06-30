import assert from "node:assert";
import { assembleReport, parseReportDoc, renderReportPdf, generateReport, REPORT_SYSTEM } from "./report";
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
const datasets = [ds("sales", ["region", "amount", "closed_at"])];

const GOOD = `{
  "title": "Sales Report",
  "subtitle": "Q1",
  "kpis": [{"label":"Revenue","value":"$1.2M"}],
  "sections": [
    {"heading":"Summary","body":"Up 14%.","bullets":["APAC up 22%"]},
    {"heading":"By Region","table":{"columns":["Region","Revenue"],"rows":[["APAC","$520K"],["NA","$430K"]]}}
  ]
}`;

// ---- parseReportDoc --------------------------------------------------------
{
  const doc = parseReportDoc(GOOD);
  assert.equal(doc.title, "Sales Report");
  assert.equal(doc.subtitle, "Q1");
  assert.equal(doc.kpis?.[0].value, "$1.2M");
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[1].table?.rows.length, 2);

  // tolerant of code fences
  assert.equal(parseReportDoc("```json\n" + GOOD + "\n```").title, "Sales Report");

  // garbage / missing structure -> throws
  assert.throws(() => parseReportDoc("not json"), /no JSON object/);
  assert.throws(() => parseReportDoc(`{"title":"x"}`), /missing title\/sections|no valid sections/);
  assert.throws(() => parseReportDoc(`{"sections":[{"heading":"h"}]}`), /missing title/);

  // sanitizes bad sections (drops headingless), coerces table cells
  const messy = parseReportDoc(`{"title":"T","sections":[{"heading":"ok","body":"b"},{"nope":1},{"heading":"t","table":{"columns":["a","b"],"rows":[[1,2],"bad"]}}]}`);
  assert.equal(messy.sections.length, 2, "headingless section dropped");
  assert.deepEqual(messy.sections[1].table?.rows, [["1", "2"], []], "cells coerced to strings; bad row -> []");
}

// ---- renderReportPdf -------------------------------------------------------
{
  const pdf = await renderReportPdf(parseReportDoc(GOOD));
  assert.ok(Buffer.isBuffer(pdf), "returns a Buffer");
  assert.equal(pdf.slice(0, 5).toString(), "%PDF-", "valid PDF header");
  assert.ok(pdf.length > 800, "non-trivial PDF size");
}

// ---- assembleReport --------------------------------------------------------
{
  const { system_prompt, user_prompt } = assembleReport(datasets, "summarize sales", { docContext: "Board notes: focus on APAC." });
  assert.ok(system_prompt.includes("JSON"), "system asks for JSON");
  assert.ok(system_prompt === REPORT_SYSTEM);
  assert.ok(user_prompt.includes("sales(region:string"), "user includes the schema");
  assert.ok(user_prompt.includes("summarize sales"), "user includes the request");
  assert.ok(user_prompt.includes("APAC"), "user includes doc context");
  assert.ok(/Domain guidance/i.test(user_prompt), "user includes domain enrichment block");
}

// ---- generateReport (injected model) ---------------------------------------
{
  const { doc, pdf } = await generateReport({ datasets, userPrompt: "report" }, async () => GOOD);
  assert.equal(doc.title, "Sales Report");
  assert.equal(pdf.slice(0, 5).toString(), "%PDF-");
}

console.log("report.test.ts: all assertions passed");
