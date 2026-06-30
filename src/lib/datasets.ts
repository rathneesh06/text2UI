// datasets.ts — pure browser-side helpers for turning uploaded files into named,
// queryable tables. Extracted verbatim from the old App.tsx during the UI port.
import { ingest } from "./ingest";
import type { IngestResult } from "../../shared/types";

export type Source = { id: string; filename: string; ingest: IngestResult };
export type Table = Source & { tableName: string };

export const newId = () => Math.random().toString(36).slice(2);

// ---- table-name derivation ----------------------------------------------
export function sanitizeName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").toLowerCase();
  let s = base.replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!s || /^[0-9]/.test(s)) s = "t_" + s;
  return s;
}

/** One file => table "data" (back-compat); several => sanitized, de-duplicated names. */
export function assignTableNames(sources: Source[]): Table[] {
  if (sources.length === 1) return [{ ...sources[0], tableName: "data" }];
  const used = new Set<string>();
  return sources.map((s) => {
    const base = sanitizeName(s.filename);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    return { ...s, tableName: name };
  });
}

// ---- file reading + ingestion --------------------------------------------
export function readFile(file: File): Promise<string | ArrayBuffer> {
  const binary = /\.(xlsx|xls)$/i.test(file.name);
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => (r.result == null ? reject(new Error("Empty file")) : resolve(r.result));
    r.onerror = () => reject(r.error ?? new Error("Could not read file"));
    binary ? r.readAsArrayBuffer(file) : r.readAsText(file);
  });
}

/** Read + profile one uploaded file into a Source. Throws with a readable message. */
export async function ingestFile(file: File): Promise<Source> {
  const content = await readFile(file);
  const result = ingest(file.name, content);
  return { id: newId(), filename: file.name, ingest: result };
}
