// bff/markitdown.ts — client for the Python markitdown sidecar (Wave 0 / N2a).
// Converts document uploads (PDF/Word/PPT/...) to Markdown for use as LLM
// CONTEXT only. Best-effort by design: every failure path returns null so the
// core build never breaks (matches the project's graceful-degradation rule).
//
// Data files (csv/xlsx/json) are deliberately NOT routed here — they keep
// flowing through ingest.ts so they stay queryable in DuckDB. This module only
// handles documents that become prompt context.

const MARKITDOWN_URL = process.env.MARKITDOWN_URL ?? "http://127.0.0.1:8001";
const CONVERT_TIMEOUT_MS = Number(process.env.MARKITDOWN_TIMEOUT_MS ?? 20_000);

// Extensions treated as "documents" (context). Mirrors the sidecar whitelist.
const DOC_EXTS = new Set([
  ".pdf", ".docx", ".doc", ".pptx", ".ppt",
  ".html", ".htm", ".rtf", ".epub", ".txt", ".md",
]);

export function extnameLower(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i).toLowerCase() : "";
}

/** True for document files that should become CONTEXT via markitdown. */
export function isDocumentFile(filename: string): boolean {
  return DOC_EXTS.has(extnameLower(filename));
}

export interface ConvertResult {
  markdown: string;
  chars: number;
  truncated: boolean;
  filename: string;
}

/** Convert a document to Markdown via the sidecar. Returns null on ANY failure
 *  (sidecar down, timeout, unsupported type, conversion error). Callers treat
 *  null as "no document context" and proceed with the normal build. */
export async function convertToMarkdown(
  bytes: Uint8Array,
  filename: string,
): Promise<ConvertResult | null> {
  if (!isDocumentFile(filename)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONVERT_TIMEOUT_MS);
  try {
    const form = new FormData();
    // Copy into a fresh ArrayBuffer so the Blob part is strictly typed (a bare
    // Uint8Array is rejected by strict DOM typing as a possibly-SharedArrayBuffer view).
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    form.append("file", new Blob([ab]), filename);
    const res = await fetch(MARKITDOWN_URL + "/convert", {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<ConvertResult>;
    if (typeof json.markdown !== "string" || !json.markdown.trim()) return null;
    return {
      markdown: json.markdown,
      chars: json.chars ?? json.markdown.length,
      truncated: !!json.truncated,
      filename: json.filename ?? filename,
    };
  } catch {
    return null; // graceful degradation: sidecar down / timeout / bad response
  } finally {
    clearTimeout(timer);
  }
}

/** Wrap converted document(s) as a single prompt-context block for the model.
 *  Returns "" when there is nothing to add, so it can be .filter(Boolean)'d into
 *  the assembled prompt exactly like the other enrichment blocks. */
export function docContextBlock(docs: { filename: string; markdown: string }[]): string {
  const usable = docs.filter((d) => d.markdown && d.markdown.trim());
  if (!usable.length) return "";
  const parts = usable.map(
    (d) => `--- Document: ${d.filename} ---\n${d.markdown.trim()}`,
  );
  return [
    "Reference documents the user provided for CONTEXT (use them to inform the design, copy, KPIs, and emphasis — they are NOT queryable data; only the SQL tables described above are queryable):",
    ...parts,
  ].join("\n\n");
}
