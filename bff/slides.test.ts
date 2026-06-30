import assert from "node:assert";
import { assembleDeck, parseDeckDoc, renderDeckPptx, generateDeck, DECK_SYSTEM } from "./slides";
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
  "title": "Business Review",
  "subtitle": "Q1",
  "slides": [
    {"title":"Agenda","bullets":["Results","Pipeline"],"notes":"10 min"},
    {"title":"By Region","table":{"columns":["Region","Revenue"],"rows":[["APAC","$520K"],["NA","$430K"]]}}
  ]
}`;

// ---- parseDeckDoc ----------------------------------------------------------
{
  const doc = parseDeckDoc(GOOD);
  assert.equal(doc.title, "Business Review");
  assert.equal(doc.subtitle, "Q1");
  assert.equal(doc.slides.length, 2);
  assert.deepEqual(doc.slides[0].bullets, ["Results", "Pipeline"]);
  assert.equal(doc.slides[0].notes, "10 min");
  assert.equal(doc.slides[1].table?.rows.length, 2);

  assert.equal(parseDeckDoc("```json\n" + GOOD + "\n```").title, "Business Review"); // fences tolerated

  assert.throws(() => parseDeckDoc("nope"), /no JSON object/);
  assert.throws(() => parseDeckDoc(`{"title":"x"}`), /missing title\/slides|no valid slides/);
  assert.throws(() => parseDeckDoc(`{"slides":[{"title":"t"}]}`), /missing title/);

  // sanitizes: titleless slide dropped, table cells coerced, bad row -> []
  const messy = parseDeckDoc(`{"title":"T","slides":[{"title":"ok"},{"nope":1},{"title":"t2","table":{"columns":["a","b"],"rows":[[1,2],"bad"]}}]}`);
  assert.equal(messy.slides.length, 2, "titleless slide dropped");
  assert.deepEqual(messy.slides[1].table?.rows, [["1", "2"], []]);
}

// ---- renderDeckPptx --------------------------------------------------------
{
  const buf = await renderDeckPptx(parseDeckDoc(GOOD));
  assert.ok(Buffer.isBuffer(buf), "returns a Buffer");
  assert.equal(buf.slice(0, 2).toString(), "PK", "valid .pptx (zip) header");
  assert.ok(buf.length > 2000, "non-trivial pptx size");
}

// ---- assembleDeck ----------------------------------------------------------
{
  const { system_prompt, user_prompt } = assembleDeck(datasets, "build a QBR deck", { docContext: "Focus on APAC." });
  assert.ok(system_prompt === DECK_SYSTEM);
  assert.ok(system_prompt.includes("JSON"), "system asks for JSON");
  assert.ok(system_prompt.includes("slides"), "system specifies slides shape");
  assert.ok(user_prompt.includes("sales(region:string"), "user includes schema");
  assert.ok(user_prompt.includes("build a QBR deck"), "user includes request");
  assert.ok(user_prompt.includes("APAC"), "user includes doc context");
  assert.ok(/Domain guidance/i.test(user_prompt), "user includes enrichment block");
}

// ---- generateDeck (injected model) -----------------------------------------
{
  const { doc, pptx } = await generateDeck({ datasets, userPrompt: "deck" }, async () => GOOD);
  assert.equal(doc.title, "Business Review");
  assert.equal(pptx.slice(0, 2).toString(), "PK");
}

console.log("slides.test.ts: all assertions passed");
