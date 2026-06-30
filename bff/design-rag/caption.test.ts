// bff/design-rag/caption.test.ts — offline. Injected vision run; no network.
import assert from "node:assert";
import { buildUserParts, type ImagePart } from "../aiflow";
import { parseDesignNote, captionDesign, formatDesignNote, type DesignNote, type VisionRun } from "./caption";
import { phash, contentHash } from "./hash";

// ---- aiflow plumbing: buildUserParts (the §5.6 multimodal change) ----------
{
  const textOnly = buildUserParts("hi");
  assert.deepEqual(textOnly, [{ text: "hi" }], "no images -> exactly the text part (unchanged behavior)");

  const withImg = buildUserParts("look", [
    { mimeType: "image/png", dataB64: "AAAA" },
    { mimeType: "image/png", dataB64: "BBBB" },
  ]);
  assert.equal(withImg[0].text, "look", "text part first");
  assert.deepEqual(withImg[1].inlineData, { mimeType: "image/png", data: "AAAA" }, "image -> inlineData");
  assert.equal(withImg.length, 3, "text + 2 images");
}

// ---- parseDesignNote: clean JSON -------------------------------------------
{
  const n = parseDesignNote(JSON.stringify({
    domain: "sales", chartTypes: ["bar", "line"], layout: "kpi-row + 2x2 grid",
    density: "dense", whatsGood: "Clear KPI hierarchy.",
  }));
  assert.equal(n.domain, "sales");
  assert.deepEqual(n.chartTypes, ["bar", "line"]);
  assert.equal(n.layout, "kpi-row + 2x2 grid");
  assert.equal(n.density, "dense");
  assert.equal(n.whatsGood, "Clear KPI hierarchy.");
}

// ---- parseDesignNote: fenced + surrounded by prose -------------------------
{
  const raw = 'Sure!\n```json\n{"domain":"finance","chartTypes":["donut"],"layout":"sidebar","density":"spacious","whatsGood":"Calm."}\n```\nHope that helps.';
  const n = parseDesignNote(raw);
  assert.equal(n.domain, "finance", "extracted from fences + prose");
  assert.deepEqual(n.chartTypes, ["donut"]);
}

// ---- parseDesignNote: lenient defaults + domain hint fallback ---------------
{
  const n = parseDesignNote('{"layout":"grid"}', "logistics");
  assert.equal(n.domain, "logistics", "missing domain -> hint");
  assert.deepEqual(n.chartTypes, [], "missing chartTypes -> []");
  assert.equal(n.density, "spacious", "missing/odd density -> spacious");
  assert.equal(n.whatsGood, "", "missing whatsGood -> empty");
  const n2 = parseDesignNote("{}");
  assert.equal(n2.domain, "generic", "no domain + no hint -> generic");
}

// ---- parseDesignNote: density coercion + chartTypes stringified ------------
{
  const n = parseDesignNote('{"domain":"hr","density":"comfortable","chartTypes":["bar", 7, "", "map"]}');
  assert.equal(n.density, "spacious", "unknown density -> spacious");
  assert.deepEqual(n.chartTypes, ["bar", "7", "map"], "coerced to strings, empties dropped");
}

// ---- parseDesignNote: unusable input throws --------------------------------
{
  assert.throws(() => parseDesignNote("no json here"), /no JSON object/);
  assert.throws(() => parseDesignNote("{not valid json}"), /not valid JSON/);
}

// ---- captionDesign: injected run, image part shaping, domain hint ----------
{
  const calls: { system: string; user: string; image: ImagePart }[] = [];
  const fakeRun: VisionRun = (system, user, image) => {
    calls.push({ system, user, image });
    return Promise.resolve('{"domain":"sales","chartTypes":["kpi-card"],"layout":"kpi-row","density":"dense","whatsGood":"Tight."}');
  };
  const note = await captionDesign(Buffer.from("PNGBYTES"), { domainHint: "sales" }, fakeRun);
  assert.equal(note.domain, "sales");
  assert.equal(note.layout, "kpi-row");
  assert.equal(calls.length, 1, "run was called once");
  const seen = calls[0];
  assert.equal(seen.image.mimeType, "image/png", "PNG image part");
  assert.equal(seen.image.dataB64, Buffer.from("PNGBYTES").toString("base64"), "base64 of the png");
  assert.ok(seen.user.includes("sales"), "domain hint threaded into the prompt");
  assert.ok(seen.system.includes("NEVER transcribe"), "system forbids copying content");
}

// ---- formatDesignNote ------------------------------------------------------
{
  const n: DesignNote = { domain: "finance", chartTypes: ["bar", "line"], layout: "grid", density: "dense", whatsGood: "Crisp." };
  const s = formatDesignNote(n);
  assert.ok(s.includes("domain: finance") && s.includes("charts: bar, line") && s.includes("density: dense"));
  const empty = formatDesignNote({ domain: "generic", chartTypes: [], layout: "", density: "spacious", whatsGood: "" });
  assert.ok(empty.includes("charts: —") && empty.includes("layout: —"), "empties rendered as —");
}

// ---- hash: deterministic, distinct, content-hash fallback for non-PNG ------
{
  const a = Buffer.from("design-A");
  const h1 = phash(a);
  const h2 = phash(Buffer.from("design-A"));
  const h3 = phash(Buffer.from("design-B"));
  assert.equal(h1, h2, "same bytes -> same hash (dedup works)");
  assert.notEqual(h1, h3, "different bytes -> different hash");
  assert.ok(h1.startsWith("c:"), "non-PNG input falls back to a content hash");
  assert.equal(h1, "c:" + contentHash(a), "fallback = c:+sha256");
}

console.log("ok design-rag/caption");
