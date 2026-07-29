// bff/text2sql/selection.ts — the brain of the table-selection page.
//
// The user has connected a database and is deciding which tables to carry into
// the UI builder. Every turn of that conversation is planned by the MODEL: it
// reads the catalog (names, row counts, columns), the current selection, and
// the whole conversation so far, then emits selection operations plus its own
// reply. There is no phrase-matching layer in front of it — "select 1, 2 and 7",
// "add whatever covers refunds", "drop the two you just added", and "which of
// these has customer emails?" are all the same kind of turn as far as this
// module is concerned.
//
// What is NOT left to the model: turning the names it emits into real tables.
// That runs through resolveRefs(), which matches against the live catalog and
// reports anything it can't find. A model that invents `customer_emails` gets
// told so; it never silently ends up in someone's selection. Planning is where
// intelligence belongs, resolution is where correctness belongs — the same
// split the SQL planner and its guard already use.
import type { ChatMessage } from "../../shared/types";
import { callGemini, ORCHESTRATE_OPTS, type GenOptions, type GenResult } from "../aiflow";

const PLAN_TIMEOUT_MS = Number(process.env.T2SQL_SELECT_TIMEOUT_MS ?? 25_000);
/** How many catalog entries the model is shown per turn (large DBs are ranked). */
const CATALOG_TO_MODEL = Number(process.env.T2SQL_SELECT_CATALOG_N ?? 250);

// ---- ops ---------------------------------------------------------------------

export type SelOpKind =
  | "add"       // union with the refs
  | "remove"    // subtract the refs
  | "replace"   // selection becomes exactly the refs ("only X and Y")
  | "all"       // select every table in the catalog
  | "clear"     // select nothing
  | "focus"     // no selection change — open a table's columns in the UI
  | "undo";     // no change here — the handler pops its selection history

export interface SelOp {
  op: SelOpKind;
  /** Table names as the model wrote them, or catalog numbers. Resolved below. */
  refs?: string[];
}

// ---- ref resolution: the layer the model does not get to skip ------------------

/** "Order Items" / "order-items" / "order_items" all normalize to "orderitems". */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** Trailing-s tolerance so "customer" finds "customers" and vice versa. */
const stem = (s: string) => norm(s).replace(/(?:es|s)$/, "");
/** The bare table name of a "schema.table" display name. */
const bare = (s: string) => (s.includes(".") ? s.slice(s.lastIndexOf(".") + 1) : s);

const globToRe = (g: string) =>
  new RegExp("^" + g.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");

export interface RefResolution {
  /** Real table names, catalog order, deduped. */
  tables: string[];
  /** Refs that matched nothing — reported back to the user AND to the model. */
  unresolved: string[];
  /** Refs that matched several tables — the user gets asked. */
  ambiguous: { ref: string; candidates: string[] }[];
}

/** Resolve ONE ref against the catalog. Ordered by confidence: a number or an
 *  exact name always wins over a fuzzy guess, so "3" and "orders" are never
 *  reinterpreted just because another table happens to contain that text. */
export function resolveRef(ref: string, catalog: string[]): { matches: string[]; ambiguous?: string[] } {
  const raw = String(ref ?? "").trim().replace(/^[#"'`]+|["'`,.;]+$/g, "");
  if (!raw) return { matches: [] };

  // 1. index ("3") and range ("2-6", "2..6", "2 to 6") — 1-based, as displayed.
  if (/^\d+$/.test(raw)) {
    const i = Number(raw);
    return { matches: i >= 1 && i <= catalog.length ? [catalog[i - 1]] : [] };
  }
  const range = raw.match(/^(\d+)\s*(?:-|–|\.\.|to)\s*(\d+)$/);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
    const out: string[] = [];
    for (let i = a; i <= b; i++) if (i >= 1 && i <= catalog.length) out.push(catalog[i - 1]);
    return { matches: out };
  }

  // 2. glob ("sales_*", "*_log") — an explicit multi-match request.
  if (raw.includes("*")) {
    const re = globToRe(raw);
    return { matches: catalog.filter((t) => re.test(t) || re.test(bare(t))) };
  }

  // 3. exact, then case-insensitive, then punctuation-insensitive, then
  //    schema-qualified ("orders" finding "sales.orders"), then singular/plural.
  const exact = catalog.find((t) => t === raw);
  if (exact) return { matches: [exact] };
  const ci = catalog.filter((t) => t.toLowerCase() === raw.toLowerCase());
  if (ci.length === 1) return { matches: ci };
  if (ci.length > 1) return { matches: [], ambiguous: ci };

  const n = norm(raw);
  const byNorm = catalog.filter((t) => norm(t) === n || norm(bare(t)) === n);
  if (byNorm.length === 1) return { matches: byNorm };
  if (byNorm.length > 1) return { matches: [], ambiguous: byNorm };

  const s = stem(raw);
  const byStem = catalog.filter((t) => stem(t) === s || stem(bare(t)) === s);
  if (byStem.length === 1) return { matches: byStem };
  if (byStem.length > 1) return { matches: [], ambiguous: byStem };

  // 4. last resort: substring. One hit is a win; several is a question.
  const sub = catalog.filter((t) => norm(t).includes(n) && n.length >= 3);
  if (sub.length === 1) return { matches: sub };
  if (sub.length > 1) return { matches: [], ambiguous: sub.slice(0, 8) };

  return { matches: [] };
}

export function resolveRefs(refs: string[], catalog: string[]): RefResolution {
  const order = new Map(catalog.map((t, i) => [t, i] as const));
  const picked = new Set<string>();
  const unresolved: string[] = [];
  const ambiguous: { ref: string; candidates: string[] }[] = [];
  for (const ref of refs ?? []) {
    const r = resolveRef(ref, catalog);
    if (r.matches.length) { for (const m of r.matches) picked.add(m); continue; }
    if (r.ambiguous?.length) { ambiguous.push({ ref: String(ref).trim(), candidates: r.ambiguous }); continue; }
    if (String(ref ?? "").trim()) unresolved.push(String(ref).trim());
  }
  return {
    tables: [...picked].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    unresolved,
    ambiguous,
  };
}

// ---- applying ops ---------------------------------------------------------------

export interface ApplyResult {
  selection: string[];
  added: string[];
  removed: string[];
  unresolved: string[];
  ambiguous: { ref: string; candidates: string[] }[];
  /** A "focus" op asks the UI to open this table's columns. */
  focus?: string;
  undo: boolean;
}

/** Fold ops over the current selection. Pure, catalog-ordered, and total:
 *  unknown refs surface as `unresolved` rather than throwing or guessing. */
export function applyOps(current: string[], ops: SelOp[], catalog: string[]): ApplyResult {
  const order = new Map(catalog.map((t, i) => [t, i] as const));
  const known = new Set(catalog);
  let sel = new Set(current.filter((t) => known.has(t)));
  const before = new Set(sel);
  const unresolved: string[] = [];
  const ambiguous: { ref: string; candidates: string[] }[] = [];
  let focus: string | undefined;
  let undo = false;

  for (const op of ops ?? []) {
    const r = op.refs?.length ? resolveRefs(op.refs, catalog) : { tables: [], unresolved: [], ambiguous: [] };
    unresolved.push(...r.unresolved);
    ambiguous.push(...r.ambiguous);
    switch (op.op) {
      case "add":     for (const t of r.tables) sel.add(t); break;
      case "remove":  for (const t of r.tables) sel.delete(t); break;
      case "replace": sel = new Set(r.tables); break;
      case "all":     sel = new Set(catalog); break;
      case "clear":   sel = new Set(); break;
      case "focus":   focus = r.tables[0] ?? focus; break;
      case "undo":    undo = true; break;
    }
  }

  const selection = [...sel].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return {
    selection,
    added: selection.filter((t) => !before.has(t)),
    removed: [...before].filter((t) => !sel.has(t)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    unresolved,
    ambiguous,
    focus,
    undo,
  };
}

// ---- corrections appended to the model's reply -------------------------------------

const list = (xs: string[], max = 8) =>
  xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;

/** The model writes the reply; this adds only what the model could get WRONG:
 *  names that don't exist and names that matched several tables. Returns "" when
 *  everything resolved, which is the common case. */
export function correctionNote(r: ApplyResult): string {
  const bits: string[] = [];
  for (const a of r.ambiguous) bits.push(`“${a.ref}” could mean ${list(a.candidates, 6)} — which did you want?`);
  if (r.unresolved.length) bits.push(`I couldn't find ${list(r.unresolved, 6)} in this database, so I left ${r.unresolved.length === 1 ? "it" : "them"} out.`);
  return bits.join(" ");
}

/** Fallback prose for the rare turn where the model returns ops but no words. */
export function summarizeApply(r: ApplyResult, catalogCount: number): string {
  const bits: string[] = [];
  if (r.added.length) bits.push(`Added ${r.added.length} table${r.added.length === 1 ? "" : "s"}: ${list(r.added)}.`);
  if (r.removed.length) bits.push(`Removed ${r.removed.length}: ${list(r.removed)}.`);
  if (r.selection.length) {
    bits.push(`That's ${r.selection.length} of ${catalogCount} table${catalogCount === 1 ? "" : "s"} selected: ${list(r.selection, 12)}.`);
  } else if (r.removed.length) {
    bits.push("The selection is now empty.");
  }
  const note = correctionNote(r);
  if (note) bits.push(note);
  return bits.join(" ") || "Nothing changed.";
}

// ---- the model ---------------------------------------------------------------------

export const SELECTION_PLAN_SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description: "What you say to the user. Always present. Natural, brief, specific — this IS the conversation.",
    },
    ops: {
      type: "array",
      description: "Selection changes this turn asks for, in order. Empty when the user asked a question or you need to clarify.",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "remove", "replace", "all", "clear", "focus", "undo"] },
          refs: {
            type: "array",
            items: { type: "string" },
            description: "EXACT table names copied from the catalog (preferred), catalog numbers, or a glob like sales_*. Required for add/remove/replace/focus.",
          },
        },
        required: ["op"],
      },
    },
  },
  required: ["reply", "ops"],
};

const SYSTEM = `You are the table-selection assistant in text2UI. A user has connected their database and is choosing which tables to carry forward into the UI builder. You are the whole conversation on that page: you read their message, you change the selection, and you talk back to them like a sharp colleague who knows this schema.

You are shown, every turn: the numbered catalog (table names, approximate row counts, and columns where they've been profiled), the current selection, and the conversation so far.

WHAT YOU EMIT
A "reply" (always) and "ops" (possibly empty).
- add / remove: adjust the current selection.
- replace: the selection becomes exactly these tables ("only orders and customers", "actually just the two invoice tables").
- all: every table. clear: none. undo: step back to the previous selection.
- focus: the user wants to LOOK at a table's columns, not select it ("what's in payments?", "open orders").
- No ops at all when the user asked a question, was chatting, or when you genuinely need to clarify.

REFERENCES
Copy table names EXACTLY as they appear in the catalog — including any schema prefix like "sales.orders". Catalog numbers ("3") and globs ("audit_*") also work. Never invent a name: if you think a table should exist and it isn't in the catalog, say so instead of guessing at it.

BE SMART ABOUT WHAT THEY MEAN
- Numbers, ranges, lists: "1, 2 and 7", "3-9", "the first five" — all straightforward, just do them.
- Semantics: "the ones about customer payments", "whatever I'd need for a churn dashboard", "the lookup tables" — work it out from names, columns and row counts, then say briefly WHY you picked what you picked.
- Conversation: "also add the invoices", "drop the last two", "put those back", "same as before but without the audit stuff" — the history is right there, use it.
- Plurals mean every match: "the audit ones" means both audit tables, not a question about which.
- Follow-on questions ("which of these has an email column?", "how big is orders?") deserve a real answer from the catalog, with ops empty.

JUDGEMENT
- Prefer acting on a reasonable reading over interrogating the user. One clarifying question is fine when a request is truly ambiguous; three rounds of questions is not.
- Never select everything as a way of coping with uncertainty. If you're unsure, pick the strong candidates and say what you left out and why.
- When you remove or replace, name what you dropped so nothing disappears silently.
- Big tables are fine to select — this page copies or wires them, it doesn't scan them here. Don't refuse on size; mention it if a table is enormous.

VOICE
Brief and concrete. Name the tables you touched. No preamble, no restating their message back at them, no "Certainly!". A sentence or two is usually right. When you've done exactly what was asked and there's nothing to add, a short confirmation is better than filler.`;

export interface SelectionPlanInput {
  prompt: string;
  /** Catalog in display order — index+1 is the number the user sees. */
  catalog: { name: string; approxRows?: number; columns?: string[] }[];
  selection: string[];
  history?: ChatMessage[];
}
export type PlanSelectionRun = (s: string, u: string, o?: GenOptions) => Promise<GenResult>;

/** Cheap lexical ranking so a 2,000-table database still fits in a prompt: the
 *  tables the conversation is actually about (plus everything already selected)
 *  are the ones described in full. */
function catalogForModel(input: SelectionPlanInput): { line: string; count: number } {
  const all = input.catalog;
  if (all.length <= CATALOG_TO_MODEL) {
    return { line: all.map((t, i) => describeEntry(t, i + 1)).join("\n"), count: all.length };
  }
  const words = new Set(
    [input.prompt, ...(input.history ?? []).slice(-6).map((m) => m.content)]
      .join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2),
  );
  const selected = new Set(input.selection);
  const scored = all.map((t, i) => {
    let score = selected.has(t.name) ? 50 : 0;
    const n = t.name.toLowerCase();
    if (words.has(n) || [...words].some((w) => n.includes(w))) score += 20;
    for (const tok of n.split(/[^a-z0-9]+/)) if (words.has(tok)) score += 5;
    for (const c of t.columns ?? []) if (words.has(c.toLowerCase())) score += 1;
    return { t, i, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const shown = scored.slice(0, CATALOG_TO_MODEL).sort((a, b) => a.i - b.i);
  return {
    line: shown.map((x) => describeEntry(x.t, x.i + 1)).join("\n") +
      `\n… ${all.length - shown.length} further tables exist in this database but aren't listed here. If the user seems to mean one of them, ask them to name it.`,
    count: all.length,
  };
}

const describeEntry = (t: { name: string; approxRows?: number; columns?: string[] }, n: number) =>
  `${n}. ${t.name}${t.approxRows != null ? ` (~${t.approxRows} rows)` : ""}` +
  (t.columns?.length ? ` — columns: ${t.columns.slice(0, 16).join(", ")}${t.columns.length > 16 ? ", …" : ""}` : "");

function buildUserPrompt(input: SelectionPlanInput): string {
  const hist = input.history?.length
    ? "Conversation so far:\n" + input.history.slice(-20).map((m) => `${m.role}: ${m.content}`).join("\n") + "\n\n"
    : "";
  const cat = catalogForModel(input);
  const sel = input.selection.length
    ? `Currently selected (${input.selection.length}): ${input.selection.join(", ")}`
    : "Currently selected: nothing yet";
  return `${hist}Database catalog (${cat.count} tables, numbered exactly as the user sees them):\n${cat.line}\n\n${sel}\n\nUser message: ${input.prompt}`;
}

const stripFences = (s: string) => s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

const VALID_OPS: SelOpKind[] = ["add", "remove", "replace", "all", "clear", "focus", "undo"];

/**
 * Plan one selection turn. Returns null ONLY when the model could not be
 * reached, timed out, or returned something unparseable — the handler treats
 * that as an outage, not as a refusal.
 */
export async function planSelectionTurn(
  input: SelectionPlanInput,
  run: PlanSelectionRun = callGemini,
  timeoutMs = PLAN_TIMEOUT_MS,
): Promise<{ ops: SelOp[]; reply?: string } | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<{ ops: SelOp[]; reply?: string } | null> => {
    try {
      const { text } = await run(SYSTEM, buildUserPrompt(input), { ...ORCHESTRATE_OPTS, responseSchema: SELECTION_PLAN_SCHEMA });
      const parsed = JSON.parse(stripFences(text)) as { ops?: unknown; reply?: unknown };
      if (!parsed || typeof parsed !== "object") return null;
      const ops: SelOp[] = [];
      for (const raw of (Array.isArray(parsed.ops) ? parsed.ops : []) as any[]) {
        if (!raw || typeof raw !== "object" || !VALID_OPS.includes(raw.op)) continue;
        const refs = Array.isArray(raw.refs) ? raw.refs.map((r: unknown) => String(r)).filter(Boolean) : undefined;
        // An op that needs targets and has none is dropped rather than applied:
        // a malformed "replace" with no refs would wipe the user's selection.
        if (["add", "remove", "replace", "focus"].includes(raw.op) && !refs?.length) continue;
        ops.push({ op: raw.op, ...(refs ? { refs } : {}) });
      }
      const reply = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : undefined;
      // A response with neither ops nor words is indistinguishable from a failure.
      if (!ops.length && !reply) return null;
      console.log(`[selection] plan: ${ops.map((o) => `${o.op}(${o.refs?.join("|") ?? ""})`).join(" ") || "reply only"}`);
      return { ops, reply };
    } catch (err: any) {
      console.warn(`[selection] planner failed: ${err?.message ?? err}`);
      return null;
    }
  })();
  return Promise.race([call, timeout]);
}

// ---- outage path ---------------------------------------------------------------------
// NOT a second brain and not a phrase parser: this runs only when the model is
// unreachable, and understands only what cannot be misread — a list of catalog
// numbers, ranges, or exact table names. Anything with a verb, a negation or an
// opinion in it is declined, because honouring half of "remove everything except
// orders" during an outage would be worse than saying the assistant is down.
// Set T2SQL_SELECT_OFFLINE=0 to disable it entirely.
export function offlineFallback(text: string, catalog: string[]): SelOp[] | null {
  if ((process.env.T2SQL_SELECT_OFFLINE ?? "1") !== "1") return null;
  const t = String(text ?? "").trim();
  if (!t || /[a-z]{3,}\s+[a-z]{3,}/i.test(t.replace(/\b(?:and|the|table|tables)\b/gi, " "))) return null;
  const refs = t.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
    .filter((x) => !/^(?:and|the|table|tables|select|add)$/i.test(x));
  if (!refs.length) return null;
  const r = resolveRefs(refs, catalog);
  if (r.unresolved.length || r.ambiguous.length || !r.tables.length) return null;
  return [{ op: "add", refs }];
}
