// shared/dependencies.ts — cross-database dependencies declared by the user.
//
// WHY TWO SHAPES
// A user describing how their databases relate says two different kinds of thing,
// and they have two different consumers:
//
//   "orders.customer_id points at customers.id"   → a JOIN. Machine-usable.
//        Drives real SQL: the combined-schema views are built from these.
//
//   "revenue in billing is net of refunds in ops"  → SEMANTICS. Not a join.
//        Can't be executed, but the spec planner must know it or the dashboard
//        will double-count.
//
// Both are captured. Neither is discarded because it didn't fit the other's
// shape — that is the failure mode of a "mid" chat: it hears something it can't
// structure and drops it. The user's own words are ALWAYS kept verbatim in
// `statement`, whatever else we manage to extract.
//
// This type is shared because the /select page renders dependencies, the BFF
// validates and stores them, and the build pipeline consumes them.

/** Which database in the group — a STABLE id (GroupPart.id), generated once when
 *  that member is opened and never reused.
 *
 *  It is deliberately NOT the positional index. `src{i}` is an attach-time
 *  artifact: it is assigned by position each time the group is attached, so
 *  removing member 0 renumbers every member after it. Anything persisted against
 *  a position — a stored dependency, a selection origin — would silently start
 *  pointing at a different database. Positions are resolved from ids at attach
 *  time (see memberIndexById in connection-registry); nothing durable stores one. */
export type MemberId = string;

/** @deprecated The positional form. Only for reading rows written before the
 *  switch to stable ids — see migrateDependencyMembers. */
export type MemberIndex = number;

export interface ColumnRef {
  member: MemberId;
  /** Table name as it appears in the MERGED catalog (post collision-suffixing),
   *  so it round-trips against selection state without re-resolution. */
  table: string;
  column: string;
}

export type Cardinality = "1:1" | "1:N" | "N:1" | "N:N";

/** How much we trust this — drives whether it silently builds a view or asks. */
export type Confidence =
  | "confirmed"   // columns exist AND a value-overlap probe passed
  | "validated"   // columns exist; overlap not probed (or not probeable)
  | "inferred"    // the model extracted it; columns NOT yet checked
  | "rejected";   // columns don't exist — kept, shown to the user, never built on

export interface JoinDependency {
  id: string;
  kind: "join";
  from: ColumnRef;
  to: ColumnRef;
  cardinality: Cardinality;
  confidence: Confidence;
  /** The user's own words. Never paraphrased away. */
  statement: string;
  /** Why it's not `confirmed` — shown in the UI, fed back into the chat. */
  note?: string;
  /** Populated by the overlap probe: what fraction of `from` values matched. */
  overlap?: { sampled: number; matched: number };
}

export interface SemanticDependency {
  id: string;
  kind: "semantic";
  /** Tables this constrains, best-effort. Empty is legal — a statement about the
   *  data as a whole ("all timestamps are UTC") still matters to the planner. */
  scope: { member: MemberId; table: string }[];
  statement: string;
  confidence: Confidence;
  note?: string;
}

export type Dependency = JoinDependency | SemanticDependency;

export const isJoin = (d: Dependency): d is JoinDependency => d.kind === "join";
export const isSemantic = (d: Dependency): d is SemanticDependency => d.kind === "semantic";

/** Only these may be built into views. `inferred` is deliberately excluded:
 *  a join the model guessed and nobody checked must not silently shape data. */
export const isBuildable = (d: Dependency): d is JoinDependency =>
  isJoin(d) && (d.confidence === "confirmed" || d.confidence === "validated");

/** Stable id from content, so re-stating the same dependency updates rather than
 *  duplicates. Deliberately NOT random. */
export function depId(
  d: { kind: Dependency["kind"]; from?: ColumnRef; to?: ColumnRef; statement?: string },
): string {
  if (d.kind === "join" && d.from && d.to) {
    const a = `${d.from.member}.${d.from.table}.${d.from.column}`;
    const b = `${d.to.member}.${d.to.table}.${d.to.column}`;
    // Order-independent: A→B and B→A are the same edge stated twice.
    return "j_" + [a, b].sort().join("~").toLowerCase().replace(/[^a-z0-9~._]/g, "");
  }
  return "s_" + Math.abs(hash(String((d as any).statement ?? ""))).toString(36);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** Merge new dependencies into existing, replacing by id. Later wins — a user
 *  correcting themselves must not leave the stale version behind. */
export function mergeDependencies(existing: Dependency[], incoming: Dependency[]): Dependency[] {
  const byId = new Map(existing.map((d) => [d.id, d]));
  for (const d of incoming) byId.set(d.id, d);
  return [...byId.values()];
}

/** Qualified name matching how the merged catalog and selection state key tables.
 *  Keyed on the stable member id, not `src{i}` — the positional form would change
 *  under the caller's feet when a member is removed. */
export const qualify = (member: MemberId, table: string): string => `${member}:${table}`;

// ---- migration: positional members -> stable ids ------------------------------------

/** True for a dependency row written before members had stable ids. */
function hasNumericMember(d: any): boolean {
  if (!d || typeof d !== "object") return false;
  if (typeof d.from?.member === "number" || typeof d.to?.member === "number") return true;
  return Array.isArray(d.scope) && d.scope.some((s: any) => typeof s?.member === "number");
}

/**
 * Rewrite stored dependencies whose `member` is still a positional index.
 *
 * `idAt(i)` maps the OLD position to the member's stable id — callers pass the
 * current group order, which is correct as long as no member was removed between
 * the row being written and this running. When a position can't be mapped (the
 * group shrank), the dependency is KEPT and marked `rejected` with a note rather
 * than dropped: the user's statement survives even when we can no longer say
 * which database it referred to. Ids are also re-derived, since depId() hashes
 * member values.
 */
export function migrateDependencyMembers(
  stored: unknown,
  idAt: (index: number) => MemberId | null,
): Dependency[] {
  if (!Array.isArray(stored)) return [];
  const out: Dependency[] = [];
  for (const raw of stored) {
    const d: any = raw;
    if (!d || typeof d !== "object" || (d.kind !== "join" && d.kind !== "semantic")) continue;
    if (!hasNumericMember(d)) { out.push(d as Dependency); continue; }

    const unmapped: number[] = [];
    const fix = (m: unknown): MemberId => {
      if (typeof m !== "number") return String(m);
      const id = idAt(m);
      if (id) return id;
      unmapped.push(m);
      return `missing:${m}`;
    };

    if (d.kind === "join") {
      const next: any = {
        ...d,
        from: { ...d.from, member: fix(d.from?.member) },
        to: { ...d.to, member: fix(d.to?.member) },
      };
      next.id = depId(next);
      if (unmapped.length) {
        next.confidence = "rejected";
        next.note = `${d.note ? d.note + " " : ""}Stored against database position ${[...new Set(unmapped)].join(", ")}, which no longer exists in this group — restate it to reattach.`;
      }
      out.push(next as Dependency);
    } else {
      const next: any = {
        ...d,
        scope: Array.isArray(d.scope) ? d.scope.map((s: any) => ({ ...s, member: fix(s?.member) })) : [],
      };
      if (unmapped.length) {
        next.confidence = "rejected";
        next.note = `${d.note ? d.note + " " : ""}Stored against database position ${[...new Set(unmapped)].join(", ")}, which no longer exists in this group — restate it to reattach.`;
      }
      out.push(next as Dependency);
    }
  }
  return out;
}
