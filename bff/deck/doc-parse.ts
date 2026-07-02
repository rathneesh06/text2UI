// bff/deck/doc-parse.ts — the upgraded Document Parser. In-process, structured, no sidecar
// for the common formats: docx (via jszip → document.xml), html, markdown, and plain text.
// Extracts a title, ordered sections (heading + prose), and TABLES. Best-effort: returns
// null on an unsupported/unreadable file so the caller can fall back to the text sidecar.
import JSZip from "jszip";
import type { ParsedDoc, DocTable, DocSection } from "../../shared/ingest";

const extOf = (f: string) => { const i = f.lastIndexOf("."); return i >= 0 ? f.slice(i).toLowerCase() : ""; };
const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

// ---- DOCX (OOXML) ----------------------------------------------------------
function docxText(node: string): string {
  const parts = [...node.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
  return clean(parts.join(""));
}
function docxHeadingLevel(p: string): number {
  const m = p.match(/<w:pStyle[^>]*w:val="([^"]*)"/i);
  if (!m) return 0;
  const v = m[1].toLowerCase();
  if (v === "title") return 1;
  const h = v.match(/heading(\d)/);
  return h ? Math.min(6, parseInt(h[1], 10)) : 0;
}
function parseDocxTable(tbl: string): DocTable | null {
  const rows = [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) =>
    [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => docxText(c[0])));
  if (rows.length < 2) return null;
  return { name: "table", columns: rows[0], rows: rows.slice(1) };
}
async function parseDocx(bytes: Uint8Array): Promise<ParsedDoc | null> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) return null;
    const body = xml.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? xml;
    const sections: DocSection[] = [];
    const tables: DocTable[] = [];
    let title: string | undefined;
    let cur: DocSection | null = null;
    // Walk top-level tables and paragraphs in document order.
    for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
      const block = m[0];
      if (block.startsWith("<w:tbl")) {
        const t = parseDocxTable(block);
        if (t) { t.name = `table${tables.length + 1}`; tables.push(t); }
        continue;
      }
      const text = docxText(block);
      const level = docxHeadingLevel(block);
      if (level === 1 && !title) { title = text; continue; }
      if (level > 0 && text) { cur = { heading: text, level, text: "" }; sections.push(cur); }
      else if (text) { if (!cur) { cur = { heading: "", level: 0, text: "" }; sections.push(cur); } cur.text += (cur.text ? " " : "") + text; }
    }
    return { title, sections, tables, source: "", kind: "docx" };
  } catch { return null; }
}

// ---- HTML ------------------------------------------------------------------
function parseHtmlTable(tbl: string): DocTable | null {
  const rows = [...tbl.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) =>
    [...r[0].matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)].map((c) => clean(c[0].replace(/<[^>]+>/g, ""))));
  if (rows.length < 2) return null;
  return { name: "table", columns: rows[0], rows: rows.slice(1) };
}
function parseHtml(text: string): ParsedDoc {
  const tables: DocTable[] = [];
  for (const m of text.matchAll(/<table[\s\S]*?<\/table>/gi)) { const t = parseHtmlTable(m[0]); if (t) { t.name = `table${tables.length + 1}`; tables.push(t); } }
  const stripped = text.replace(/<table[\s\S]*?<\/table>/gi, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  const sections: DocSection[] = [];
  let title: string | undefined = clean((text.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").replace(/<[^>]+>/g, "")) || undefined;
  for (const m of stripped.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>|<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    if (m[1]) sections.push({ heading: clean(m[2].replace(/<[^>]+>/g, "")), level: parseInt(m[1], 10), text: "" });
    else { const t = clean(m[3].replace(/<[^>]+>/g, "")); if (t) { if (!sections.length) sections.push({ heading: "", level: 0, text: "" }); sections[sections.length - 1].text += (sections[sections.length - 1].text ? " " : "") + t; } }
  }
  return { title, sections, tables, source: "", kind: "html" };
}

// ---- Markdown / text -------------------------------------------------------
function parseMarkdownTables(lines: string[]): { tables: DocTable[]; consumed: Set<number> } {
  const tables: DocTable[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < lines.length - 1; i++) {
    if (/\|/.test(lines[i]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const columns = cells(lines[i]); consumed.add(i); consumed.add(i + 1);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length && /\|/.test(lines[j]) && lines[j].trim(); j++) { rows.push(cells(lines[j])); consumed.add(j); }
      if (rows.length) tables.push({ name: `table${tables.length + 1}`, columns, rows });
      i = j - 1;
    }
  }
  return { tables, consumed };
}
function parseMarkdown(text: string, kind: "markdown" | "text"): ParsedDoc {
  const lines = text.split(/\r?\n/);
  const { tables, consumed } = kind === "markdown" ? parseMarkdownTables(lines) : { tables: [], consumed: new Set<number>() };
  const sections: DocSection[] = [];
  let title: string | undefined;
  lines.forEach((line, idx) => {
    if (consumed.has(idx)) return;
    const h = kind === "markdown" && line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const level = h[1].length; const t = h[2].trim(); if (level === 1 && !title) title = t; else sections.push({ heading: t, level, text: "" }); return; }
    const t = line.trim();
    if (t) { if (!sections.length) sections.push({ heading: "", level: 0, text: "" }); sections[sections.length - 1].text += (sections[sections.length - 1].text ? " " : "") + t; }
  });
  return { title, sections, tables, source: "", kind };
}

/** Parse a document into structured sections + tables. Null if unsupported/unreadable. */
export async function parseDocument(bytes: Uint8Array, filename: string): Promise<ParsedDoc | null> {
  const ext = extOf(filename);
  let doc: ParsedDoc | null = null;
  if (ext === ".docx") doc = await parseDocx(bytes);
  else {
    const text = new TextDecoder().decode(bytes);
    if (ext === ".html" || ext === ".htm") doc = parseHtml(text);
    else if (ext === ".md" || ext === ".markdown") doc = parseMarkdown(text, "markdown");
    else if (ext === ".txt") doc = parseMarkdown(text, "text");
  }
  if (doc) doc.source = filename;
  return doc;
}