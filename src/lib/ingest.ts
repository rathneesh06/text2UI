// ingest.ts — pipeline stage 1 (BROWSER). Turns an uploaded file into a small
// model-facing profile + the full row set for the data layer. Types live in shared/.
//
// Deps: papaparse, xlsx. (npm i -D @types/papaparse for types; xlsx ships its own.)

import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { ColumnType, ColumnProfile, DataProfile, IngestResult } from "../../shared/types";

const MAX_SAMPLE_ROWS = 5;
const TYPE_SCAN_LIMIT = 200;
const UNIQUE_SCAN_LIMIT = 50_000;

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}
function isBoolish(v: unknown): boolean {
  if (typeof v === "boolean") return true;
  if (typeof v === "string") return /^(true|false)$/i.test(v.trim());
  return false;
}
function isIntish(v: unknown): boolean {
  if (typeof v === "number") return Number.isInteger(v);
  if (typeof v === "string") return /^-?\d+$/.test(v.trim());
  return false;
}
function isNumberish(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") { const s = v.trim(); return s !== "" && Number.isFinite(Number(s)); }
  return false;
}
const DATE_RE = /^(\d{4}-\d{1,2}-\d{1,2}([ T].*)?|\d{1,2}\/\d{1,2}\/\d{2,4})$/;
function isDateish(v: unknown): boolean {
  if (v instanceof Date) return !isNaN(v.getTime());
  if (typeof v === "string" && DATE_RE.test(v.trim())) return !isNaN(Date.parse(v.trim()));
  return false;
}
function inferType(values: unknown[]): ColumnType {
  const sample = values.filter((v) => !isBlank(v)).slice(0, TYPE_SCAN_LIMIT);
  if (sample.length === 0) return "string";
  if (sample.every(isBoolish)) return "boolean";
  if (sample.every(isIntish)) return "integer";
  if (sample.every(isNumberish)) return "number";
  if (sample.every(isDateish)) return "date";
  return "string";
}
function toNumber(v: unknown): number { return typeof v === "number" ? v : Number(String(v).trim()); }

function profileColumn(name: string, column: unknown[]): ColumnProfile {
  const type = inferType(column);
  let nullable = false;
  const distinct = new Map<string, unknown>();
  let scanned = 0;
  for (const v of column) {
    if (isBlank(v)) { nullable = true; continue; }
    if (scanned < UNIQUE_SCAN_LIMIT) {
      const key = v instanceof Date ? v.toISOString() : String(v);
      if (!distinct.has(key)) distinct.set(key, v);
      scanned++;
    }
  }
  const profile: ColumnProfile = {
    name, type, nullable,
    uniqueCount: distinct.size,
    sampleValues: Array.from(distinct.values()).slice(0, 5),
  };
  if (type === "string" && distinct.size >= 1 && distinct.size <= 50) {
    // topValues: the observed category values + counts (full pass — uploads
    // are fully in memory, so this is EXACT). Feeds select filters, the
    // observed-value guard, and the model's literal choices.
    const counts = new Map<string, number>();
    for (const v of column) {
      if (isBlank(v)) continue;
      const key = String(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    profile.topValues = [...counts.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, 25)
      .map(([value, count]) => ({ value, count }));
    // Uploads profile the FULL parsed file — these stats are exact, so the
    // exhaustiveness guard may trust uniqueCount here.
    if (counts.size <= 25) profile.statsExact = true;
  }
  if (type === "integer" || type === "number") {
    const nums = Array.from(distinct.values()).map(toNumber).filter(Number.isFinite);
    if (nums.length) { profile.min = Math.min(...nums); profile.max = Math.max(...nums); }
  } else if (type === "date") {
    const ts = Array.from(distinct.values())
      .map((v) => (v instanceof Date ? v.getTime() : Date.parse(String(v))))
      .filter((n) => !isNaN(n));
    if (ts.length) {
      profile.min = new Date(Math.min(...ts)).toISOString();
      profile.max = new Date(Math.max(...ts)).toISOString();
    }
  }
  return profile;
}
function profileRows(rows: Record<string, unknown>[]): { columns: ColumnProfile[] } {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) {
    if (!seen.has(k)) { seen.add(k); names.push(k); }
  }
  return { columns: names.map((name) => profileColumn(name, rows.map((r) => r[name]))) };
}

// Coerce each value to its inferred column type so the data layer (DuckDB) and
// generated apps get real numbers/booleans instead of CSV strings.
function coerceValue(v: unknown, type: ColumnType): unknown {
  if (isBlank(v)) return null;
  switch (type) {
    case "integer":
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      return typeof v === "boolean" ? v : /^true$/i.test(String(v).trim());
    case "date":
      return v instanceof Date ? v.toISOString() : String(v); // ISO string: JS + DuckDB can parse
    default:
      return typeof v === "string" ? v : String(v);
  }
}
function coerceRows(rows: Record<string, unknown>[], columns: ColumnProfile[]): Record<string, unknown>[] {
  const types = new Map(columns.map((c) => [c.name, c.type] as const));
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(row)) out[k] = coerceValue(row[k], types.get(k) ?? "string");
    return out;
  });
}

function parseCsv(text: string): Record<string, unknown>[] {
  return Papa.parse<Record<string, unknown>>(text, {
    header: true, skipEmptyLines: "greedy", dynamicTyping: false,
  }).data;
}
function parseXlsx(buf: ArrayBuffer): { rows: Record<string, unknown>[]; sheetName: string } {
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], {
    defval: null, raw: true,
  });
  return { rows, sheetName };
}
function parseJson(text: string): Record<string, unknown>[] {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const arr = Object.values(data).find(
      (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object",
    );
    if (arr) return arr as Record<string, unknown>[];
    return [data as Record<string, unknown>];
  }
  throw new Error("JSON must be an array of objects or contain one.");
}

export function ingest(filename: string, content: string | ArrayBuffer): IngestResult {
  const ext = filename.split(".").pop()?.toLowerCase();
  let rows: Record<string, unknown>[];
  let format: DataProfile["source"]["format"];
  let sheetName: string | undefined;

  if (ext === "csv" || ext === "tsv") { rows = parseCsv(content as string); format = "csv"; }
  else if (ext === "xlsx" || ext === "xls") {
    const out = parseXlsx(content as ArrayBuffer); rows = out.rows; sheetName = out.sheetName; format = "xlsx";
  } else if (ext === "json") { rows = parseJson(content as string); format = "json"; }
  else throw new Error(`Unsupported file type: .${ext}`);

  const { columns } = profileRows(rows);
  const typedRows = coerceRows(rows, columns);
  const profile: DataProfile = {
    source: { filename, format, sheetName },
    rowCount: typedRows.length,
    columns,
    sampleRows: typedRows.slice(0, MAX_SAMPLE_ROWS),
  };
  return { profile, rows: typedRows };
}