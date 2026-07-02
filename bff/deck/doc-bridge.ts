// bff/deck/doc-bridge.ts — connects the Document Parser to the deck pipeline. Tables found
// in a document become loadable datasets (numeric-coerced so they profile + chart like any
// upload), and the title + section prose become narrative context for the planners. This is
// what lets "build a deck from this report" chart the report's actual numbers.
import type { ParsedDoc } from "../../shared/ingest";

const slugTable = (s: string, i: number) => (s || `doc_table_${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `doc_table_${i + 1}`;

/** Coerce a display cell ("$1,234", "45%", "1.2k") into a number when it clearly is one. */
function coerce(v: string): string | number {
  const s = v.trim();
  if (!s) return s;
  const cleaned = s.replace(/[$£€,\s]/g, "").replace(/%$/, "").replace(/([\d.]+)k$/i, (_, n) => String(Number(n) * 1e3)).replace(/([\d.]+)m$/i, (_, n) => String(Number(n) * 1e6));
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned);
  return s;
}

const uniqueCols = (cols: string[]) => {
  const seen = new Map<string, number>();
  return cols.map((c, i) => {
    let base = (c || `col_${i + 1}`).trim() || `col_${i + 1}`;
    const n = seen.get(base) ?? 0; seen.set(base, n + 1);
    return n ? `${base}_${n + 1}` : base;
  });
};

export interface DocInputs {
  title?: string;
  tables: { tableName: string; rows: Record<string, unknown>[] }[];
  narrative: string;
}

/** Turn a parsed document into loadable tables + a narrative context string. */
export function docToInputs(parsed: ParsedDoc, index = 0): DocInputs {
  const tables = parsed.tables.map((t, i) => {
    const cols = uniqueCols(t.columns);
    const rows = t.rows.map((r) => {
      const o: Record<string, unknown> = {};
      cols.forEach((c, ci) => { o[c] = coerce(r[ci] ?? ""); });
      return o;
    });
    return { tableName: `${slugTable(parsed.source.replace(/\.[^.]+$/, ""), index)}_${i + 1}`, rows };
  }).filter((t) => t.rows.length > 0);

  const narrativeParts: string[] = [];
  if (parsed.title) narrativeParts.push(`# ${parsed.title}`);
  for (const s of parsed.sections.slice(0, 30)) {
    if (s.heading) narrativeParts.push(`## ${s.heading}`);
    if (s.text) narrativeParts.push(s.text.slice(0, 600));
  }
  return { title: parsed.title, tables, narrative: narrativeParts.join("\n").slice(0, 4000) };
}