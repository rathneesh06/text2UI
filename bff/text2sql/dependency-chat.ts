// bff/text2sql/dependency-chat.ts — the /select chat's one job: capture how the
// connected databases relate, and never lose what the user said.
//
// WHY THIS REPLACED AN ANALYST
// The /select chat used to select tables and answer data questions. Selection is
// now manual (checkboxes and tabs), and data questions belong to the build chat.
// What no other surface can do is record the JOIN SEMANTICS that only the user
// knows: a spec planner looking at `orders` and `customers` in one DuckDB file
// cannot tell that one row of `customers` explains forty of `orders`, or that the
// key is `customer_ref` and not `id`.
//
// THE FAILURE MODE THIS IS BUILT AGAINST
// A chat that hears something it can't structure and quietly drops it. So the
// contract is absolute: every statement survives. If it has a join form it becomes
// a JoinDependency; if it doesn't it becomes a SemanticDependency with the user's
// own words in `statement`. There is no third branch where input disappears.
//
// VALIDATION IS CODE, NOT PROMPT. The model proposes; this module checks the
// columns actually exist and (best-effort) that the values actually overlap. A
// dependency that fails is KEPT and marked `rejected` — feedback the user can
// correct, not garbage to be swallowed.
import { callGemini, ORCHESTRATE_OPTS, type GenResult } from "../aiflow";
import {
  depId, isJoin, mergeDependencies,
  type Dependency, type JoinDependency, type MemberId,
} from "../../shared/dependencies";

export type DependencyRun = (system: string, user: string, opts?: any) => Promise<GenResult>;

const PROBE_TIMEOUT_MS = () => Math.max(1_000, Number(process.env.T2SQL_DEP_PROBE_TIMEOUT_MS ?? 8_000));
const PROBE_SAMPLE = 1000;

// ---- the prompt -------------------------------------------------------------------

/** Edit THIS first when the chat misbehaves — the behaviour lives here, not in the
 *  code below it. */
export const DEPENDENCY_SYSTEM = `You are helping someone describe how their connected databases relate to each other, so a dashboard builder can join the data correctly. You do NOT select tables (they do that with checkboxes) and you do NOT answer questions about the data itself.

You are given the catalog of connected databases: each database has a member id, a label, and its tables and columns. You are also given the dependencies captured SO FAR.

Reply with ONLY a JSON object:
{"dependencies": [...], "reply": "what you say to the user", "removeIds": ["..."]}

TWO KINDS OF DEPENDENCY.

1) A JOIN — two columns that line up:
{"kind":"join","from":{"member":"<memberId>","table":"orders","column":"customer_id"},
 "to":{"member":"<memberId>","table":"customers","column":"id"},
 "cardinality":"N:1","statement":"<the user's own words>"}
cardinality is one of "1:1", "1:N", "N:1", "N:N". From the many side to the one side is "N:1".

2) A SEMANTIC statement — true and important, but not a join:
{"kind":"semantic","scope":[{"member":"<memberId>","table":"orders"}],
 "statement":"<the user's own words>"}
scope may be empty when the statement is about the data as a whole.

THE RULE THAT MATTERS MOST: never discard what the user said. If a statement cannot be expressed as a join, capture it as semantic with "statement" kept VERBATIM. Do not paraphrase it away, do not summarise it into nothing, and never reply as though they had said nothing. Examples that are semantic, not joins: "all timestamps are UTC", "revenue is net of refunds recorded in ops", "amounts are in GBP", "the archive table only has data after 2023".

Use ONLY member ids, table names and column names that appear in the catalog you were given. Never invent one.

HANDLING EACH KIND OF TURN:

- SEVERAL AT ONCE. One message may contain several relationships. Return them all in "dependencies".

- CORRECTIONS. "no, it's the other way round" / "I meant customer_ref". Return the CORRECTED dependency. Ids are derived from content, so a corrected join replaces the old one only if it describes the same pair of columns; when the columns change, also put the OLD dependency's id in "removeIds" so it doesn't linger. The captured list is given to you with ids — use them.

- DELETIONS. "forget the orders link" → put its id in "removeIds" and confirm in "reply". Return no dependency for it.

- QUESTIONS ABOUT STATE. "what have you got so far?", "which tables are still unconnected?" → answer from the captured list and the catalog in "reply", and return an EMPTY "dependencies" array. Answering is not capturing; do not re-add what is already there.

- VAGUE INPUT. "orders relate to customers somehow" → do NOT guess and do NOT refuse. Ask ONE targeted question in "reply" naming the plausible columns you can actually see in the catalog: "Which pairs up — orders.customer_id with customers.id, or orders.account_ref with customers.account_no?" Return an empty "dependencies" array for that turn. Ask one question, not a list.

- Anything the user asserts that you cannot turn into a join, and that is not a question or a deletion, is a semantic dependency. When in doubt, capture it as semantic rather than losing it.

"reply" is what the user reads. Be brief and concrete: say what you captured, in their terms. Do not restate the JSON. Do not apologise. If you captured nothing because you asked a question, just ask it.`;

// ---- model call ---------------------------------------------------------------------

export interface DependencyCatalogTable { member: MemberId; memberLabel: string; table: string; columns: string[] }

export interface DependencyTurn {
  dependencies: Dependency[];
  removeIds: string[];
  reply: string;
}

function buildUserPrompt(
  prompt: string,
  catalog: DependencyCatalogTable[],
  captured: Dependency[],
  history: { role: string; content: string }[],
): string {
  const byMember = new Map<string, { label: string; lines: string[] }>();
  for (const t of catalog) {
    if (!byMember.has(t.member)) byMember.set(t.member, { label: t.memberLabel, lines: [] });
    byMember.get(t.member)!.lines.push(`  ${t.table}(${t.columns.join(", ") || "columns not profiled yet"})`);
  }
  const cat = [...byMember.entries()]
    .map(([id, m]) => `Database ${id} — ${m.label}:\n${m.lines.join("\n")}`)
    .join("\n\n");

  const so_far = captured.length
    ? captured.map((d) => `  [${d.id}] ${d.kind} (${d.confidence}): ${d.statement}`).join("\n")
    : "  (nothing captured yet)";

  const hist = history.length
    ? "Recent conversation:\n" + history.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n") + "\n\n"
    : "";

  return `${hist}Connected databases and their tables:\n${cat}\n\nCaptured so far:\n${so_far}\n\nUser says: ${prompt}`;
}

/** Ask the model to structure this turn. Never throws — a dead model returns null
 *  and the caller keeps the user's turn alive. */
export async function planDependencyTurn(
  input: { prompt: string; catalog: DependencyCatalogTable[]; captured: Dependency[]; history?: { role: string; content: string }[] },
  run: DependencyRun = callGemini,
): Promise<DependencyTurn | null> {
  let text: string;
  try {
    const r = await run(DEPENDENCY_SYSTEM, buildUserPrompt(input.prompt, input.catalog, input.captured, input.history ?? []), ORCHESTRATE_OPTS);
    text = String(r?.text ?? "").trim();
  } catch (err: any) {
    console.warn(`[dependency] model call failed: ${err?.message ?? err}`);
    return null;
  }
  if (!text) return null;
  try {
    const j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    const raw = Array.isArray(j?.dependencies) ? j.dependencies : [];
    const dependencies: Dependency[] = [];
    for (const d of raw) {
      if (!d || typeof d !== "object") continue;
      if (d.kind === "join") {
        if (!d.from?.table || !d.from?.column || !d.to?.table || !d.to?.column) continue;
        const dep: JoinDependency = {
          id: "", kind: "join",
          from: { member: String(d.from.member ?? ""), table: String(d.from.table), column: String(d.from.column) },
          to: { member: String(d.to.member ?? ""), table: String(d.to.table), column: String(d.to.column) },
          cardinality: ["1:1", "1:N", "N:1", "N:N"].includes(d.cardinality) ? d.cardinality : "N:1",
          confidence: "inferred",
          statement: String(d.statement ?? input.prompt),
        };
        dep.id = depId(dep);
        dependencies.push(dep);
      } else if (d.kind === "semantic") {
        const dep: Dependency = {
          id: "", kind: "semantic",
          scope: Array.isArray(d.scope)
            ? d.scope.filter((s: any) => s?.table).map((s: any) => ({ member: String(s.member ?? ""), table: String(s.table) }))
            : [],
          statement: String(d.statement ?? input.prompt),
          confidence: "validated", // nothing to check: it is a claim, not a join
        };
        dep.id = depId(dep);
        dependencies.push(dep);
      }
    }
    return {
      dependencies,
      removeIds: Array.isArray(j?.removeIds) ? j.removeIds.map(String).filter(Boolean) : [],
      reply: String(j?.reply ?? "").trim(),
    };
  } catch {
    console.warn("[dependency] model returned unparseable JSON");
    return null;
  }
}

/** Last resort when the model is unavailable. Keeps the statement rather than
 *  losing the turn — the whole point of this feature. */
export function captureVerbatim(prompt: string): Dependency {
  const dep: Dependency = {
    id: "", kind: "semantic", scope: [], statement: prompt,
    confidence: "inferred",
    note: "Saved as written — the assistant was unavailable, so this hasn't been structured into a join yet.",
  };
  dep.id = depId(dep);
  return dep;
}

// ---- validation (code, not prompt) --------------------------------------------------

export interface ColumnLookup { (member: MemberId, table: string): string[] | null }

/** Check both ends against the REAL catalog. A dependency naming a column that
 *  doesn't exist is kept and marked `rejected`, with a note saying what was
 *  missing — the user can then correct it, which they cannot do if it vanished. */
export function validateAgainstCatalog(deps: Dependency[], columnsOf: ColumnLookup): Dependency[] {
  return deps.map((d) => {
    if (!isJoin(d)) return d;
    const missing: string[] = [];
    for (const end of [d.from, d.to]) {
      const cols = columnsOf(end.member, end.table);
      if (cols === null) { missing.push(`table ${end.table}`); continue; }
      if (!cols.some((c) => c.toLowerCase() === end.column.toLowerCase())) {
        missing.push(`${end.table}.${end.column}`);
      }
    }
    if (!missing.length) return { ...d, confidence: "validated" as const, note: undefined };
    return {
      ...d,
      confidence: "rejected" as const,
      note: `Not found in the connected databases: ${missing.join(", ")}. Check the spelling, or tell me the right column.`,
    };
  });
}

export interface ProbeRunner { (sql: string): Promise<{ rows: Record<string, unknown>[] }> }

const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Does the data actually line up? Samples up to 1000 distinct values from `from`
 * and counts how many exist in `to`.
 *
 * Strictly best-effort. A probe that times out, errors, or can't be expressed
 * leaves the dependency `validated` and the turn unaffected — the columns are
 * known to exist either way, and failing a user's turn over an optimisation would
 * be a much worse outcome than an unprobed join.
 */
export async function probeOverlap(
  deps: Dependency[],
  refFor: (member: MemberId, table: string) => string | null,
  run: ProbeRunner,
): Promise<Dependency[]> {
  const out: Dependency[] = [];
  const deadline = Date.now() + PROBE_TIMEOUT_MS();
  for (const d of deps) {
    // Only probe joins we already believe in, and stop probing once the budget is
    // spent rather than making the user wait per dependency.
    if (!isJoin(d) || d.confidence === "rejected" || Date.now() > deadline) { out.push(d); continue; }
    const fromRef = refFor(d.from.member, d.from.table);
    const toRef = refFor(d.to.member, d.to.table);
    if (!fromRef || !toRef) { out.push(d); continue; }
    const sql =
      `WITH s AS (SELECT DISTINCT ${qid(d.from.column)} AS v FROM ${fromRef} ` +
      `WHERE ${qid(d.from.column)} IS NOT NULL LIMIT ${PROBE_SAMPLE}) ` +
      `SELECT count(*) AS sampled, ` +
      `count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ${toRef} t WHERE t.${qid(d.to.column)} = s.v)) AS matched FROM s`;
    try {
      const r = await Promise.race([
        run(sql),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("probe timed out")), Math.max(500, deadline - Date.now()))),
      ]);
      const row: any = r.rows?.[0] ?? {};
      const sampled = Number(row.sampled ?? 0);
      const matched = Number(row.matched ?? 0);
      if (!sampled) { out.push({ ...d, confidence: "validated", overlap: { sampled: 0, matched: 0 } }); continue; }
      const ratio = matched / sampled;
      if (ratio >= 0.9) {
        out.push({ ...d, confidence: "confirmed", overlap: { sampled, matched }, note: undefined });
      } else {
        out.push({
          ...d, confidence: "validated", overlap: { sampled, matched },
          note: `Both columns exist, but only ${matched} of ${sampled} sampled values matched — that usually means the wrong column.`,
        });
      }
    } catch (err: any) {
      console.warn(`[dependency] overlap probe skipped: ${err?.message ?? err}`);
      out.push(d);
    }
  }
  return out;
}

/** Apply one turn to the captured list: remove, then merge. */
export function applyTurn(captured: Dependency[], turn: { dependencies: Dependency[]; removeIds: string[] }): Dependency[] {
  const kept = turn.removeIds.length
    ? captured.filter((d) => !turn.removeIds.includes(d.id))
    : captured;
  return mergeDependencies(kept, turn.dependencies);
}
