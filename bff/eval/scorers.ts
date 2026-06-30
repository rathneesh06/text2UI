// bff/eval/scorers.ts — Wave 2 / P7, Step 1: deterministic scorers.
//
// Pure, offline grading of a generated app against its schema. No model calls,
// no network, no cost — so these run in CI as a regression gate. The model-
// calling runner + LLM-as-judge (polish/prompt-responsiveness) come in Step 2;
// they will REUSE these scorers on whatever apps they generate.
//
// Dimensions are HARD (correctness — a failure means the app is broken) or SOFT
// (quality signals — reported, not gating). Overall pass = all HARD dimensions pass.

import ts from "typescript";
import type { GeneratedApp } from "../../shared/types";

export interface ScoreContext {
  /** Real schema: every table and its actual column names (lowercased ok). */
  datasets: { tableName: string; columns: string[] }[];
  /** The few-shot exemplar injected for this build, if any (for leakage). */
  exemplarCode?: string;
}

export interface DimensionResult {
  dimension: string;
  hard: boolean;
  pass: boolean;
  detail: string;
}

export interface AppScore {
  /** True only if every HARD dimension passed. */
  pass: boolean;
  /** Fraction of ALL dimensions passed (0..1). */
  score: number;
  results: DimensionResult[];
}

/** The only modules a generated app may import (matches the runtime contract). */
const ALLOWED_IMPORTS = new Set([
  "react", "react-dom", "react-dom/client", "react/jsx-runtime",
  "recharts", "lucide-react",
  "./data", "./rows", "./rows.js", "./selection",
]);

export function mainFileContent(app: GeneratedApp): string {
  const f = app.files.find((x) => /(^|\/)App\.(tsx?|jsx?)$/i.test(x.path)) ?? app.files[0];
  return f?.content ?? "";
}

// ---- HARD: the code transpiles (syntax-valid TSX) --------------------------
export function checkCompiles(code: string): DimensionResult {
  const out = ts.transpileModule(code, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  const pass = errors.length === 0;
  const detail = pass
    ? "transpiles cleanly"
    : "syntax errors: " + errors.slice(0, 3).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ");
  return { dimension: "compiles", hard: true, pass, detail };
}

// ---- HARD: imports only from the allowed set -------------------------------
export function checkImports(code: string): DimensionResult {
  const specs: string[] = [];
  const re = /\bimport\b[^"']*?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) specs.push(m[1]);
  const bad = specs.filter((s) => !ALLOWED_IMPORTS.has(s));
  const pass = bad.length === 0;
  return {
    dimension: "imports",
    hard: true,
    pass,
    detail: pass ? "all imports allowed" : `disallowed imports: ${[...new Set(bad)].join(", ")}`,
  };
}

// ---- HARD: no leftover pipeline markers ------------------------------------
export function checkMarkers(code: string): DimensionResult {
  const leftover = /\/\/__(SUMMARY|END)__/.test(code);
  return {
    dimension: "markers",
    hard: true,
    pass: !leftover,
    detail: leftover ? "leftover //__SUMMARY__ or //__END__ marker in code" : "no stray markers",
  };
}

// ---- HARD: SQL references only real columns (heuristic) --------------------
// Extracts SQL from query("...") calls, collects candidate column identifiers,
// and flags any that are neither real columns/tables, nor aliases/CTEs, nor SQL
// keywords/functions. Heuristic by nature (no SQL parser) — tuned for low false
// positives; reports the suspects so a human can confirm.
const SQL_WORDS = new Set([
  "select","from","where","group","by","order","having","limit","offset","as","on","and","or","not","in","is",
  "null","join","left","right","inner","outer","full","cross","union","all","distinct","case","when","then","else",
  "end","asc","desc","with","over","partition","between","like","ilike","exists","using","desc","cast","interval",
  // common duckdb functions
  "sum","avg","count","min","max","round","coalesce","date_trunc","strftime","extract","abs","ceil","floor","lower",
  "upper","length","substr","concat","row_number","rank","dense_rank","lag","lead","first","last","nullif","date",
  "year","month","day","quarter","week","now","current_date","try_cast","median","stddev","percentile_cont","epoch",
  "true","false","array_agg","string_agg","regexp_matches","trim","replace",
]);

function extractSqlStrings(code: string): string[] {
  const out: string[] = [];
  // query(`...`), query("..."), query('...') — also db.query / conn.query
  const re = /\bquery\s*\(\s*(`[\s\S]*?`|"[^"]*"|'[^']*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push(m[1].slice(1, -1));
  return out;
}

// Remove the parts of a SQL string that are NOT identifiers — block/line
// comments and single-quoted string literals — so their words aren't mistaken
// for hallucinated columns. (Double-quoted text is a quoted IDENTIFIER in SQL,
// so it's deliberately left intact.)
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // /* block comments */
    .replace(/--[^\n]*/g, " ")           // -- line comments
    .replace(/'(?:[^']|'')*'/g, " ");    // 'string literals' ('' = escaped quote)
}

export function checkSqlColumns(code: string, ctx: ScoreContext): DimensionResult {
  const sqls = extractSqlStrings(code);
  if (!sqls.length) {
    return { dimension: "sql_columns", hard: true, pass: true, detail: "no inline SQL to check" };
  }
  const real = new Set<string>();
  for (const d of ctx.datasets) {
    real.add(d.tableName.toLowerCase());
    for (const c of d.columns) real.add(c.toLowerCase());
  }
  const suspects = new Set<string>();
  for (const sqlRaw of sqls) {
    const sql = stripSqlNoise(sqlRaw.replace(/\$\{[^}]*\}/g, " ")); // drop interpolations, comments, literals
    const lower = sql.toLowerCase();
    // aliases (AS x) and CTE names (WITH x AS) are legitimate identifiers
    const aliases = new Set<string>();
    let a: RegExpExecArray | null;
    const aliasRe = /\bas\s+("?)([a-z_][\w]*)\1/gi;
    while ((a = aliasRe.exec(sql))) aliases.add(a[2].toLowerCase());
    const cteRe = /\bwith\s+([a-z_][\w]*)\s+as/gi;
    while ((a = cteRe.exec(sql))) aliases.add(a[1].toLowerCase());
    // candidate identifiers: bare words and "quoted" identifiers
    const idRe = /"([a-z_][\w]*)"|\b([a-z_][\w]*)\b/gi;
    let t: RegExpExecArray | null;
    while ((t = idRe.exec(sql))) {
      const id = (t[1] ?? t[2]).toLowerCase();
      if (SQL_WORDS.has(id) || aliases.has(id) || real.has(id)) continue;
      // skip pure-table.column already covered; skip single-letter table aliases
      if (id.length <= 1) continue;
      // skip if it's immediately followed by "(" -> a function call
      const after = sql.slice(t.index + t[0].length).match(/^\s*\(/);
      if (after) continue;
      suspects.add(id);
    }
    void lower;
  }
  const pass = suspects.size === 0;
  return {
    dimension: "sql_columns",
    hard: true,
    pass,
    detail: pass
      ? "SQL references only real columns/aliases"
      : `possible hallucinated identifiers: ${[...suspects].slice(0, 8).join(", ")}`,
  };
}

// ---- SOFT: loading + empty states are handled (heuristic) ------------------
export function checkStates(code: string): DimensionResult {
  const hasLoading = /\bloading\b/i.test(code) || /\bisLoading\b/.test(code);
  const hasEmpty =
    /\.length\s*===?\s*0/.test(code) ||
    /\bno data\b/i.test(code) ||
    /\bempty\b/i.test(code) ||
    /!\s*\w+(\.\w+)*\.length/.test(code);
  const pass = hasLoading && hasEmpty;
  return {
    dimension: "states",
    hard: false,
    pass,
    detail: pass ? "loading + empty states present" : `missing ${[!hasLoading && "loading", !hasEmpty && "empty"].filter(Boolean).join(" + ")} state`,
  };
}

// ---- SOFT: not stenciled from the exemplar (heuristic leakage) -------------
// Flags when the generated app copies the exemplar's DISTINCTIVE string literals
// verbatim (a sign the model traced the example instead of using the real data).
export function checkLeakage(code: string, exemplarCode?: string): DimensionResult {
  if (!exemplarCode) {
    return { dimension: "leakage", hard: false, pass: true, detail: "no exemplar to compare" };
  }
  const strings = (src: string): Set<string> => {
    const out = new Set<string>();
    // Single-line literals only (no \n) so we never capture JSX that spans tags.
    const re = /"([^"\n]{4,40})"|'([^'\n]{4,40})'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const s = (m[1] ?? m[2]).trim();
      // A distinctive LABEL has a space and a capital, and contains no structural
      // characters. Tailwind classNames are lowercase (excluded by the capital
      // rule); JSX/code fragments like `<div className=` or `/>` are excluded by
      // the structural-char rule — those are boilerplate every dashboard shares,
      // not copied content.
      if (/\s/.test(s) && /[A-Z]/.test(s) && !/[<>{}[\]\/=`]/.test(s)) out.add(s);
    }
    return out;
  };
  const ex = strings(exemplarCode);
  const app = strings(code);
  const copied = [...ex].filter((s) => app.has(s));
  // a couple of incidental matches are fine; many distinctive copies = stenciling
  const pass = copied.length <= 2;
  return {
    dimension: "leakage",
    hard: false,
    pass,
    detail: pass
      ? `acceptable overlap with exemplar (${copied.length})`
      : `${copied.length} distinctive strings copied from exemplar: ${copied.slice(0, 4).map((s) => `"${s}"`).join(", ")}`,
  };
}

// ---- SOFT: compact, grid-based layout (heuristic density) ------------------
// Flags the common "sprawl" shape: several charts stacked full-width down the
// page with no multi-column grid. Conservative — only fires once there are
// enough charts that arrangement matters, and accepts grid OR fractional-width
// (flex) columns. Used as an enrollment guard so sprawling designs don't seed
// the corpus.
export function checkLayout(code: string): DimensionResult {
  const charts =
    (code.match(/<ResponsiveContainer\b/g) ?? []).length ||
    (code.match(/<(?:Line|Bar|Area|Pie|Composed|Radar|Scatter|RadialBar|Funnel|Treemap)Chart\b/g) ?? []).length;
  const hasMultiColGrid = /(?:(?:sm|md|lg|xl|2xl):)?grid-cols-(?:[2-9]|1[0-2])\b/.test(code);
  const hasFractionalCols = /\bw-1\/[2-4]\b/.test(code); // w-1/2, w-1/3, w-1/4 = side-by-side
  const arranged = hasMultiColGrid || hasFractionalCols;
  const pass = charts < 3 || arranged;
  return {
    dimension: "layout",
    hard: false,
    pass,
    detail: pass
      ? charts < 3
        ? `few charts (${charts}); layout not a concern`
        : "charts arranged in a multi-column layout"
      : `${charts} charts but no multi-column grid — likely a sprawling single-column stack`,
  };
}

/** Run all scorers and aggregate. Overall pass = every HARD dimension passes. */
export function scoreApp(app: GeneratedApp, ctx: ScoreContext): AppScore {
  const code = mainFileContent(app);
  const results: DimensionResult[] = [
    checkCompiles(code),
    checkImports(code),
    checkMarkers(code),
    checkSqlColumns(code, ctx),
    checkStates(code),
    checkLeakage(code, ctx.exemplarCode),
    checkLayout(code),
  ];
  const pass = results.filter((r) => r.hard).every((r) => r.pass);
  const score = results.filter((r) => r.pass).length / results.length;
  return { pass, score, results };
}
