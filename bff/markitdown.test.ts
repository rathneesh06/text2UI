import assert from "node:assert";
import {
  extnameLower,
  isDocumentFile,
  docContextBlock,
  convertToMarkdown,
} from "./markitdown";
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
  } as any;
}

// ---- pure helpers ---------------------------------------------------------
{
  assert.equal(extnameLower("Report.PDF"), ".pdf");
  assert.equal(extnameLower("a.b.DOCX"), ".docx");
  assert.equal(extnameLower("noext"), "");

  assert.ok(isDocumentFile("brief.pdf"), "pdf is a document");
  assert.ok(isDocumentFile("deck.PPTX"), "pptx is a document (case-insensitive)");
  assert.ok(!isDocumentFile("data.csv"), "csv is NOT a document (stays on ingest path)");
  assert.ok(!isDocumentFile("data.xlsx"), "xlsx is NOT a document");
  assert.ok(!isDocumentFile("data.json"), "json is NOT a document");
}

// ---- docContextBlock framing ---------------------------------------------
{
  assert.equal(docContextBlock([]), "", "empty docs -> empty block");
  assert.equal(docContextBlock([{ filename: "a.pdf", markdown: "   " }]), "", "blank markdown -> empty block");

  const block = docContextBlock([
    { filename: "brief.pdf", markdown: "# Goal\nimprove activation" },
    { filename: "deck.pptx", markdown: "Slide 1" },
  ]);
  assert.ok(block.includes("CONTEXT"), "block flags content as context");
  assert.ok(block.includes("NOT queryable"), "block warns docs are not queryable data");
  assert.ok(block.includes("brief.pdf") && block.includes("deck.pptx"), "block names each document");
  assert.ok(block.includes("improve activation") && block.includes("Slide 1"), "block carries the converted text");
}

// ---- convertToMarkdown: graceful degradation (stubbed fetch) --------------
{
  const realFetch = globalThis.fetch;
  try {
    // non-document filename -> null without any network call
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as any;
    assert.equal(await convertToMarkdown(new Uint8Array([1, 2, 3]), "data.csv"), null, "csv -> null");
    assert.ok(!called, "non-document short-circuits before fetch");

    // sidecar throws (down / DNS / timeout) -> null
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
    assert.equal(await convertToMarkdown(new Uint8Array([1]), "x.pdf"), null, "fetch throw -> null");

    // sidecar returns non-OK -> null
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as any;
    assert.equal(await convertToMarkdown(new Uint8Array([1]), "x.pdf"), null, "503 -> null");

    // empty/blank markdown -> null
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ markdown: "   " }), { status: 200, headers: { "content-type": "application/json" } })) as any;
    assert.equal(await convertToMarkdown(new Uint8Array([1]), "x.pdf"), null, "blank markdown -> null");

    // success -> normalized result
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ markdown: "# Hi\nbody", chars: 9, truncated: true, filename: "x.pdf" }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as any;
    const ok = await convertToMarkdown(new Uint8Array([1]), "x.pdf");
    assert.ok(ok && ok.markdown === "# Hi\nbody" && ok.truncated === true && ok.filename === "x.pdf", "success path normalizes");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- assembler wiring: docContext is BUILD-turn-only ----------------------
{
  const datasets = [ds("sales", ["region", "amount", "closed_at"])];
  const docContext = "ZZZ_UNIQUE_DOC_MARKER content about activation goals";

  // BUILD turn (no currentCode) -> docContext present in the user prompt
  const build = assemble({ datasets, userPrompt: "show sales", docContext });
  assert.ok(build.user_prompt.includes("ZZZ_UNIQUE_DOC_MARKER"), "BUILD turn injects docContext");

  // EDIT turn (currentCode present) -> docContext NOT re-injected
  const edit = assemble({ datasets, userPrompt: "add a filter", currentCode: "export default function App(){return null}", docContext });
  assert.ok(!edit.user_prompt.includes("ZZZ_UNIQUE_DOC_MARKER"), "EDIT turn does NOT inject docContext");

  // HEAL turn (lastError present) -> docContext NOT re-injected
  const heal = assemble({ datasets, userPrompt: "x", currentCode: "export default function App(){return null}", lastError: "boom", docContext });
  assert.ok(!heal.user_prompt.includes("ZZZ_UNIQUE_DOC_MARKER"), "HEAL turn does NOT inject docContext");

  // No docContext -> build still works, no marker
  const plain = assemble({ datasets, userPrompt: "show sales" });
  assert.ok(!plain.user_prompt.includes("ZZZ_UNIQUE_DOC_MARKER"), "absent docContext is a no-op");
}

console.log("markitdown.test.ts: all assertions passed");
