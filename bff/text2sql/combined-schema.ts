// bff/text2sql/combined-schema.ts — the layer that turns declared dependencies
// into something the UI-building pipeline can actually use.
//
// THE SHAPE OF THE PROBLEM
// Tables are staged AS-IS, one per source table, faithful to the origin database.
// That is deliberate: the snapshot should not bake in join decisions made before
// anyone knows what the dashboard needs.
//
// But "as-is" alone loses the thing that matters most about a multi-database
// selection — how the databases relate. A spec planner looking at `orders` and
// `customers` sitting side by side in one DuckDB file has no way to know that
// one row in `customers` explains 40 rows in `orders`, or that it must join on
// `customer_id` and not `id`.
//
// So this builds a THIRD thing alongside the raw tables: a combined layer.
// Three artifacts, one source of truth (the dependency list):
//
//   1. A JOIN GRAPH   — machine-readable. Connected components of tables that
//                       can be joined, with the edges and their cardinality.
//   2. VIEW DDL       — real DuckDB views over the staged tables, one per
//                       connected component, so a query can hit the combined
//                       shape directly without reconstructing the joins.
//   3. A DIRECTIVE    — prose for the spec planner, carrying both the joins and
//                       the semantic dependencies that have no SQL form.
//
// The raw tables stay untouched. Nothing here is destructive; the views are
// additive and a component that fails to build simply doesn't get one.
//
// WHAT IS DELIBERATELY NOT BUILT
// Only `confirmed`/`validated` joins become views (see isBuildable). A join the
// model inferred and nobody checked never silently shapes data — it reaches the
// planner as prose, flagged, and the user can confirm it in chat.
import {
  type Dependency, type JoinDependency, type Cardinality, type MemberId,
  isBuildable, isSemantic, isJoin,
} from "../../shared/dependencies";

/** A table as it actually landed in the stage file. `localName` is what
 *  snapshotFromHandle wrote into `main` — possibly suffixed on collision, so it
 *  must be carried, never re-derived. */
export interface StagedTable {
  /** Stable GroupPart id, not the positional src{i} — see MemberId. */
  member: MemberId;
  sourceTable: string;
  localName: string;
}

export interface GraphEdge {
  dep: JoinDependency;
  fromLocal: string;
  toLocal: string;
  /** True when traversing this edge can multiply rows. */
  fansOut: boolean;
}

export interface Component {
  /** The table the view is anchored on — every LEFT JOIN hangs off this, so its
   *  row count is preserved. */
  anchor: StagedTable;
  members: StagedTable[];
  /** Spanning tree only: cycles are dropped, since a second path between the
   *  same tables duplicates rows rather than adding information. */
  edges: GraphEdge[];
  viewName: string;
}

export interface JoinGraph {
  components: Component[];
  /** Selected tables with no usable dependency. Still staged, still queryable —
   *  they just have no combined view. */
  isolated: StagedTable[];
  warnings: string[];
}

const key = (t: { member: MemberId; table: string }) => `${t.member}\u0000${t.table.toLowerCase()}`;
const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** 1:N and N:N multiply rows when traversed from the "1" side. Worth saying out
 *  loud, because a silently fanned-out view makes every SUM() wrong. */
function fansOut(c: Cardinality): boolean {
  return c === "1:N" || c === "N:N";
}

export function buildJoinGraph(deps: Dependency[], staged: StagedTable[]): JoinGraph {
  const warnings: string[] = [];
  const byKey = new Map(staged.map((s) => [key({ member: s.member, table: s.sourceTable }), s]));

  // Only buildable joins whose BOTH ends were actually staged. A dependency
  // pointing at a table the user didn't select isn't an error — it just has
  // nothing to act on here.
  const usable: { dep: JoinDependency; a: StagedTable; b: StagedTable }[] = [];
  for (const d of deps) {
    if (isJoin(d) && d.confidence === "inferred") {
      warnings.push(`join "${d.statement}" was inferred but never confirmed — not built into a view.`);
    }
    if (!isBuildable(d)) continue;
    const a = byKey.get(key(d.from));
    const b = byKey.get(key(d.to));
    if (!a || !b) continue;
    if (a.localName === b.localName) continue; // self-join: not a component edge
    usable.push({ dep: d, a, b });
  }

  // Union-find over staged tables.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  for (const s of staged) parent.set(s.localName, s.localName);
  const union = (x: string, y: string): boolean => {
    const rx = find(x), ry = find(y);
    if (rx === ry) return false;   // already connected → this edge closes a cycle
    parent.set(rx, ry);
    return true;
  };

  // Spanning tree per component. Edge order is dependency order, so a user's
  // first-stated relationship anchors the shape — predictable, and re-running
  // with the same input gives the same views.
  const treeEdges: typeof usable = [];
  for (const u of usable) {
    if (union(u.a.localName, u.b.localName)) treeEdges.push(u);
    else warnings.push(
      `"${u.dep.statement}" creates a second join path between ${u.a.localName} and ${u.b.localName}; ` +
      `it is recorded but not added to the view, because a second path duplicates rows.`,
    );
  }

  // Bucket tables by component root.
  const buckets = new Map<string, StagedTable[]>();
  for (const s of staged) {
    const r = find(s.localName);
    (buckets.get(r) ?? buckets.set(r, []).get(r)!).push(s);
  }

  const components: Component[] = [];
  const isolated: StagedTable[] = [];
  const usedViewNames = new Set<string>();

  for (const [root, members] of buckets) {
    if (members.length < 2) { isolated.push(...members); continue; }
    const edges = treeEdges
      .filter((e) => find(e.a.localName) === root)
      .map<GraphEdge>((e) => ({
        dep: e.dep,
        fromLocal: e.a.localName,
        toLocal: e.b.localName,
        fansOut: fansOut(e.dep.cardinality),
      }));

    // Anchor: the table with the most edges — the natural centre of the star,
    // and the one whose grain the view should preserve.
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.fromLocal, (degree.get(e.fromLocal) ?? 0) + 1);
      degree.set(e.toLocal, (degree.get(e.toLocal) ?? 0) + 1);
    }
    const anchor = [...members].sort(
      (x, y) => (degree.get(y.localName) ?? 0) - (degree.get(x.localName) ?? 0) || x.localName.localeCompare(y.localName),
    )[0];

    let viewName = `v_${anchor.localName}_combined`;
    for (let n = 2; usedViewNames.has(viewName); n++) viewName = `v_${anchor.localName}_combined_${n}`;
    usedViewNames.add(viewName);

    if (edges.some((e) => e.fansOut)) {
      warnings.push(
        `${viewName} joins across a one-to-many relationship, so rows from ${anchor.localName} repeat. ` +
        `Aggregate with care — COUNT(DISTINCT …) rather than COUNT(*).`,
      );
    }
    components.push({ anchor, members, edges, viewName });
  }

  return { components, isolated, warnings };
}

/**
 * CREATE VIEW statements over the staged tables.
 *
 * LEFT JOIN throughout and anchored on one table, so the view never drops rows
 * the anchor has — an INNER JOIN here would silently hide unmatched records and
 * make the dashboard's totals disagree with the source system.
 *
 * `SELECT *` is deliberate: column names are already unique per staged table
 * only by luck, so each side is projected with a table-qualified alias prefix to
 * keep collisions apart.
 */
export function viewDdl(graph: JoinGraph, columnsOf: (localName: string) => string[]): string[] {
  const out: string[] = [];
  for (const c of graph.components) {
    // BFS from the anchor so every JOIN references a table already in scope.
    const placed = new Set<string>([c.anchor.localName]);
    const ordered: GraphEdge[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (const e of c.edges) {
        if (ordered.includes(e)) continue;
        const hasFrom = placed.has(e.fromLocal), hasTo = placed.has(e.toLocal);
        if (hasFrom === hasTo) continue;        // both or neither: not yet joinable
        placed.add(hasFrom ? e.toLocal : e.fromLocal);
        ordered.push(e);
        progress = true;
      }
    }
    if (ordered.length !== c.edges.length) continue; // disconnected: skip rather than emit a broken view

    const proj: string[] = [];
    for (const m of c.members) {
      for (const col of columnsOf(m.localName)) {
        proj.push(`${qid(m.localName)}.${qid(col)} AS ${qid(`${m.localName}_${col}`)}`);
      }
    }
    if (!proj.length) continue;

    // Scope is rebuilt INCREMENTALLY here, not read from `placed`: the BFS above
    // leaves `placed` holding every table, so testing it would report both ends
    // of every edge as already-known, pick the wrong direction, and re-join the
    // anchor to itself ("duplicate alias"). Walk `ordered` and grow scope as the
    // joins are emitted, exactly as the SQL will see it.
    const inScope = new Set<string>([c.anchor.localName]);
    const joins: string[] = [];
    for (const e of ordered) {
      const fromKnown = inScope.has(e.fromLocal);
      const incoming = fromKnown ? e.toLocal : e.fromLocal;
      if (inScope.has(incoming)) continue; // spanning tree, but never emit a self-join
      const d = e.dep;
      // Both sides must be LOCAL staged names. d.from/d.to carry the SOURCE table
      // names, which differ from the local ones whenever the merged catalog
      // suffixed a collision (users -> users_2) — referencing those would name a
      // table that isn't in the query.
      const leftLocal = fromKnown ? e.fromLocal : e.toLocal;
      const leftCol = fromKnown ? d.from.column : d.to.column;
      const rightCol = fromKnown ? d.to.column : d.from.column;
      joins.push(`LEFT JOIN ${qid(incoming)} ON ${qid(leftLocal)}.${qid(leftCol)} = ${qid(incoming)}.${qid(rightCol)}`);
      inScope.add(incoming);
    }

    out.push(
      `CREATE OR REPLACE VIEW ${qid(c.viewName)} AS\nSELECT ${proj.join(", ")}\n` +
      `FROM ${qid(c.anchor.localName)}\n${joins.join("\n")};`,
    );
  }
  return out;
}

/**
 * The prose the spec planner reads. This is what makes the difference between a
 * dashboard that joins correctly and one that puts two unrelated tables side by
 * side, so it states the relationships plainly and does not bury them.
 *
 * Semantic dependencies are included even though they have no SQL form — they
 * are frequently the ones that prevent a wrong number.
 */
export function describeCombinedSchema(graph: JoinGraph, deps: Dependency[]): string {
  const lines: string[] = ["CROSS-DATABASE SCHEMA — the selected tables come from several databases and are related as follows."];

  if (graph.components.length) {
    lines.push("", "Joinable groups (a combined view exists for each — prefer it over re-joining by hand):");
    for (const c of graph.components) {
      lines.push(`- ${c.viewName}: ${c.members.map((m) => m.localName).join(", ")} (anchored on ${c.anchor.localName}).`);
      for (const e of c.edges) {
        lines.push(
          `    ${e.dep.from.table}.${e.dep.from.column} = ${e.dep.to.table}.${e.dep.to.column} ` +
          `(${e.dep.cardinality}${e.fansOut ? ", one-to-many: rows repeat" : ""})`,
        );
      }
    }
  }

  if (graph.isolated.length) {
    lines.push("", `Standalone tables with no declared relationship: ${graph.isolated.map((t) => t.localName).join(", ")}. ` +
      `Do not join these to anything without being told how.`);
  }

  const semantic = deps.filter(isSemantic);
  if (semantic.length) {
    lines.push("", "Semantic rules stated by the user. These do not appear in the schema and MUST be respected:");
    for (const s of semantic) lines.push(`- ${s.statement}`);
  }

  const unconfirmed = deps.filter((d) => isJoin(d) && d.confidence === "inferred");
  if (unconfirmed.length) {
    lines.push("", "Possible relationships that were never confirmed — do not rely on these:");
    for (const d of unconfirmed) lines.push(`- ${d.statement}`);
  }

  if (graph.warnings.length) {
    lines.push("", "Cautions:");
    for (const w of graph.warnings) lines.push(`- ${w}`);
  }

  return lines.join("\n");
}
