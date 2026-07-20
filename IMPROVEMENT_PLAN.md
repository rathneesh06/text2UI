# text2SQL / text2UI Improvement Plan v1

Research-grounded, sequenced, with acceptance criteria. Each phase is
independently shippable and lands behind the existing seams (enhance /
decompose / agents / patch / compile / render), so no phase risks the
foundation.

Guiding findings (from the text2SQL literature + our own audit trail):

- **Schema linking (table/column selection) is the dominant error source** in
  text2SQL systems — bigger than SQL syntax. Aim few-shot there first.
- **Retrieved few-shot beats static few-shot**; static beats zero-shot. Start
  static (curated fixtures), upgrade to retrieval reusing the design-RAG
  machinery.
- **Schema-constrained COT** (a bounded `reasoning` field ahead of the answer
  fields in the response schema) captures most COT gains without free-text
  parsing risk. Gate it on non-trivial prompts.
- **Constrained AST + deterministic compilation beats model-written SQL** on
  execution accuracy. Every new SQL capability below is a spec node, never a
  free SQL string from a model.
- Our own audit: every visible quality gap of the last week traces to either
  the one-shape SQL compiler or an unverified model output that a
  deterministic layer later had to heal.

---

## Phase A — SQL expressiveness (the ceiling)

Extend `DashboardSpec` + `sql.ts`/`compile.ts` with four node types, in this
order (each builds on the previous):

1. **Filters.**
   - Spec: `spec.filters?: GlobalFilter[]` (`{ id, col, table?, kind:
     "daterange" | "select" | "multiselect", label }`) and
     `widget.where?: FilterExpr[]` (`{ col, op: eq|neq|in|gte|lte|between,
     value }`, values type-checked against the profile).
   - Compile: per-widget SQL gains a deterministic WHERE builder with strict
     literal escaping; global filters compile to a parameter slot per widget.
   - Render: a functional filter bar (date range from temporal min/max,
     selects from `topValues`); filter change re-queries through the existing
     `/api/query` bridge with server-rebuilt WHERE (client sends filter
     values, never SQL).
   - Acceptance: reference-style date-range + dropdown actually filter every
     widget; injection attempts via filter values are neutralized in tests.
2. **Derived metrics (safe expressions).**
   - Spec: `metric.expr?: { op: "ratio" | "pct" | "diff", num: Metric,
     den: Metric }` — a closed AST, no free SQL.
   - Compile: `sum(x)*1.0/nullif(count(*),0)` patterns; format `percent`
     auto-applies.
   - Acceptance: "SLA attainment %" computes correctly on the golden fixture;
     the fake-ratio class ("5559.0%") is structurally impossible.
3. **Joins — FK-verified only.**
   - Introspection surfaces real foreign keys into the schema graph (Phase C
     provides caching; a minimal FK fetch lands here).
   - Spec: `widget.join?: { table, on: [l, r], type: "left" }`, valid ONLY if
     the pair matches a verified FK; semantic-layer name-heuristic candidates
     remain advisory prompt content, never compiled.
   - Acceptance: "tickets by status *name*" (lookup join) renders labels; a
     join not backed by a verified FK is rejected in validation with a note.
4. **Period comparison (delta badges).**
   - Spec: `kpi.compare?: { grain, offset: 1 }`.
   - Compile: two aggregates over adjacent windows (or one windowed query);
     renderer shows the reference "+12.4% vs prev period" badge with
     direction arrow. Only offered when a temporal column exists.
   - Acceptance: badge values verified against hand-computed fixture numbers.

## Phase B — COT + few-shot (the reasoning upgrades)

1. **Edit-ops few-shot + COT** (`patch.ts`): 6-10 curated examples
   (request → minimal ops), including the "5 rows" incident as a negative
   example (what NOT to touch); add a bounded `reasoning` field ahead of
   `ops` in the schema. Acceptance: op-count on a scripted edit suite doesn't
   regress; spurious-removal rate on the suite drops to zero.
2. **Decompose few-shot + COT** (`decompose.ts`): examples of prompt → task
   lists across domains; `reasoning` field; keep the triviality gate so COT
   costs nothing on trivial prompts. Acceptance: task-kind accuracy on a
   labeled prompt set improves vs. baseline (measure before/after).
3. **Schema-scoping few-shot (the table-picking idea)** — lands with Phase C
   where it has real leverage: when a connected DB exposes many tables, a
   scoping step selects the relevant subset before profiling/planning.
   Few-shot examples: user prompt + table inventory → chosen tables. This is
   the literature's schema-linking step, applied at onboarding scale.
   Acceptance: on a many-table fixture DB, scoping picks the labeled correct
   tables ≥ target rate; profiling cost drops accordingly.
4. **Upgrade path**: example retrieval (embed examples, pick top-k per query)
   reusing design-RAG plumbing. Only after static examples show gains.

## Phase C — Schema graph + metric lifecycle

1. **Cached schema graph**: introspection results (tables, columns, verified
   FKs, row estimates) cached per datasource with TTL + manual refresh;
   async job for large sources. Feeds Phase A joins and Phase B scoping.
2. **Metric persistence + promotion**: candidate metrics stored per
   datasource (storage engine); `approved` tier; a small UI affordance to
   promote; the compiler resolves metric ids to expressions, and approved
   metrics rank above candidates in the semantic digest.

## Phase D — Correctness harness (the missing control)

- A golden fixture dataset (DuckDB, ~1k rows, hand-computed truths) checked
  into the repo; every compiled SQL shape (aggregate, grain, filter, ratio,
  join, comparison) EXECUTES in tests and asserts NUMBERS, not structure.
- A scripted conversation suite (build → 6 edits → undo) asserting spec
  invariants after each turn.
- CI greps for dead-assertion patterns (`|| true`).
- Acceptance: the harness would have caught the negative average-age bug —
  prove it by including that exact case.

## Phase E — Governance & polish

- PII masking pass in profiling (email/phone/name pattern columns masked in
  sample values and topValues before they reach any prompt).
- Audit viewer (simple route rendering `.t2ui/audit.jsonl` per conversation).
- Production CORS hard gate (fail startup in prod with empty allowlist).

---

## Sequence rationale

A before B: reasoning upgrades are wasted if the compiler can't express the
answer (better table-picking can't fix a missing JOIN capability). B2/B1 are
cheap and can overlap A. C unlocks A3 at scale and hosts B3. D should land no
later than mid-A — every new SQL shape ships with executed-number tests from
day one. E rides along.

## Definition of done for "v2 pipeline"

A rich prompt against a live multi-table DB produces a dashboard with working
filters, at least one verified-FK join widget, honest ratio KPIs with delta
badges, business-named metrics from the approved tier — and every number on
screen is covered by an executed golden test of its SQL shape.
