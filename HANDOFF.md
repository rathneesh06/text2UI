# text2UI — Knowledge Transfer & Handoff (2026-07-22)

This document carries the FULL working context: product vision, architecture,
everything shipped, the principles that emerged from live incidents, current
state, and the roadmap. Read it top to bottom before touching code.

## 1. Product & vision

**text2UI**: natural-language prompts + the user's data (CSV/XLSX uploads,
workbench extracts, live MySQL/Postgres, colo demo snapshot) → interactive,
editable, filterable dashboards rendered as a real React app. The bar:
**every number on screen is honest, every advertised capability works
producer→pixel, and no request may silently destroy or distort user work.**
Latency is explicitly NOT a priority; correctness and completeness are.

## 2. Environment & workflow

- Repo: `C:\dev\text2UI`, branch `restore/text2ui-pipeline` (PR #1). Windows,
  Firefox. Run: `docker compose up -d db` + `npm run dev:bff` (terminal A) +
  `npm run dev`. BFF on :8787, app on :5173.
- The developer works with a sandboxed Claude (this lineage) that edits a copy,
  verifies (typecheck + suites + vite build + full `npm test`), zips ONLY
  changed files, and writes a Claude Code prompt: backup to
  `./_pre-<name>-backup/`, extract-overwrite, merge package.json if present,
  run named suites, commit with a given message, report hash, push. Claude
  Code audits every zip — treat its review as real code review.
- NEVER touch `.env`, `bff/data/`, `text2sql-integration/`.
- Tests: plain node:assert, fully offline (injectable model runners), one
  `console.log("... ✅")` per group, per-suite npm scripts chained into
  `npm test`. Full chain needs a generous timeout (~8 min).
- Audit trail: `.t2ui/audit.jsonl` — stages prompt/enhance/decompose/agents/
  edit_ops/history/validate/render/reject/query. It is the primary debugging
  instrument; live incidents are diagnosed from it plus terminal-A logs.
- Gemini: key + model via `.env` (`GEMINI_API_KEY`, `GEMINI_MODEL`,
  pin `gemini-3.6-flash` as of 2026-07). aiflow.ts auto-resolves a retired
  model via ListModels (newest stable flash) and self-heals the Gemini-3.x
  `thinkingConfig` rejection (drops the field process-wide after one 400).

## 3. Architecture (bff/dashboard unless noted)

**Build**: enhance (schema roles + baseline digest incl. OBSERVED CATEGORY
VALUES + VERIFIED RELATIONSHIPS) → decompose → five specialist agents
(kpi/bar/line/pie/table; each with deterministic fallback + `modelFailed`
reporting) → merge (dedupe by `widgetSignature` = compiled analytical
identity incl. expr + join) → validate → layout → compile (deterministic SQL
via sql.ts — the model NEVER writes SQL) → renderer (ONE template literal —
NO regex/backslash escapes in generated code).

**Edit**: undo/redo intents (deterministic version stack) → patch ops
(`planEditOps` → `applyOps`, gated) → fallback full planner + `reconcileEdit`.
Edits recompile, so filters re-resolve every turn.

**Query bridge**: sandbox iframe → postMessage (`t2ui.widgetQuery`) → host →
`POST /api/dashboard/query` → `sanitizeWidget` (whitelist grammar rebuild) →
`buildWidgetSql` → handleQuery guards. The client sends widget JSON + filter
VALUES, never SQL.

**Spec grammar** (shared/dashboard-spec.ts): sections → widgets
(kpi/line/bar/area/pie/donut/table) with `metric`/`series` (incl. derived
`expr {op: ratio|pct|diff, num/den: {col, agg, where?: Filter[]}}`),
`filters?: Filter[]`, `join?: {table, on:[baseCol,refCol], cols?}` (cols
filled by validation = join-only columns), `sort`, `limit`, formats
(number/percent/currency/hours/days/compact). `CompiledWidget` carries `sql`,
`seriesKeys` (with formats), and `columns` (table label+format metadata).

**Profiles** (shared/types.ts): every producer enriches columns with
`topValues` (≤25, cap 50 distinct) + `min`/`max` + `avg` via
shared/profile-enrich.ts (sample floor) and bff/sources/exact-stats.ts
(full-table SQL where we own a handle). `statsExact` is set ONLY by full-pass
producers — the observed-value guard may hard-drop ("provably empty") only
then. `foreignKeys` carry VERIFIED relationship edges (see §5 A3).

## 4. The three model surfaces — SYMMETRY IS LAW

agents (per-agent schemas), planner (`DASHBOARD_SCHEMA`), patch
(`EDIT_OPS_SCHEMA`). Every widget capability must exist in ALL THREE schemas,
be PRESERVED by the corresponding coercers (agents: coerceExpr/coerceWhere/
coerceWidgetFilters/coerceJoin; planner passes raw; patch merges field-wise),
and be TAUGHT in all three prompts. `bff/dashboard/pipeline.test.ts` enforces
this structurally — a capability added to one layer fails the build until it
exists everywhere. This suite exists because every major bug was exactly this
class (see §6).

## 5. Shipped change-sets (chronological, all committed)

- **A1 / A1.1 — global filters**: derived filter bar (daterange with
  per-table date-col map; selects from topValues), FilterCtx re-query via the
  bridge, strict server-side `filterConditions` (400-throwing, qid/lit
  escaping). A3.1 made select derivation board-governed (only tables hosting
  widgets, ranked by governed-widget count).
- **A2 — derived metrics**: closed expr AST; SQL `(num*100.0/nullif(den,0))`;
  fake-percent guard.
- **A2.1**: model-health startup banner, `/health?model=1`, deterministic
  fallback ratio KPI.
- **A2.2**: add_widget repair (kind/table/title inference; A3.1 added the
  filtered-count metric default).
- **A2.3**: conditional sides (`agg() FILTER (WHERE …)`), degenerate-ratio
  guard (num≡den → drop).
- **A2.4**: patch expr schema `required` (the schema-asymmetry incident);
  missing-den repair → count(*).
- **A2.5**: observed-value guard — case-mismatched literals REWRITTEN to the
  observed spelling; provably-empty conditions dropped (now gated on
  `statsExact`).
- **A2.6 — removal safety**: removal ALWAYS requires removal words in the
  user's own prompt (selection only targets); reconcile restores widgets
  absent from planner re-emissions ("restored — the edit didn't ask for a
  removal").
- **A2.7 — KPI honesty**: dedupe by compiled identity (count's ignored col
  normalized, expr included); rate-title guard (rate-titled plain count →
  drop); avg/median+percent requires observed 0..100 range; metric-identity
  guard on edits (changing agg/col requires the user's own words naming it).
- **A2.8 — profile enrichment**: the 0.0% root cause — NO producer populated
  topValues/min/max; all nine producers wired, exact SQL stats where handles
  exist, observed values surfaced in the model digest.
- **A2.9 — pipeline audit**: coerceExpr preserved `where` (build-path strip);
  widget.filters completed end-to-end; pipeline.test.ts born.
- **A2.10 — audit completions** (from Claude Code's AUDIT_FINDINGS.md, in
  repo root with per-ID resolutions): `statsExact` unforgeable exhaustiveness;
  uniform enrichment (MySQL/text2sql/local-data); reconcile meta parity;
  chart+table formats rendered (tickFormatter/tooltip/colMeta); sanitizer↔
  compile parity (expr KPIs no longer 400 under filters); honest degradation
  (modelFailed surfaced, net-zero edits honest, decline notes channel, error
  warnings kept client-side, filter-aware empty states); full audit-trail
  coverage; caps parity.
- **A3 — FK-verified joins**: `widget.join` compiles ONLY against VERIFIED
  edges — `constraint` (live PG/MySQL catalogs) or `measured` (executed
  uniqueness + containment proofs, ≤0.5% orphans; bff/sources/relationships.ts;
  candidate generation deliberately loose because measurement is the strict
  filter). Wired into all six producers. Aliased SQL
  (`FROM t b LEFT JOIN r j ON b.x=j.y`, scoped qualifier), base-qualified
  global filters, sanitizer grammar parity, join in the merge signature,
  VERIFIED RELATIONSHIPS in the digest. Executed goldens incl. the acceptance
  case (tickets by status NAME = hand-computed counts) in joins.test.ts.
- **hotfix-model-resilience**: dynamic model auto-resolution
  (`pickBestFlash`, pure/tested) + adaptive thinkingConfig degradation.
- **A3.1 (this zip)**: board-governed select filters; filtered-count KPI
  metric default; POST-VALIDATION net-zero honesty ("That edit didn't land:
  …" when validation dropped the only change); id-like aggregation guard
  (sum/avg over `*_id`-named or near-unique integer columns → drop — the
  "itilticketid over time" 1M garbage line).

## 6. Principles (each paid for by a live incident)

1. **Honest gap over a wrong number.** Drop with a warning naming the fix;
   never render a lie (100% tautology, 0.0% guessed literal, rate-titled
   count, -26919.5%, sum-of-ids).
2. **Producer→pixel or it doesn't exist.** Every capability: producer →
   emitter (3 schemas + prompts + coercers) → validator → consumer →
   round-trip. Contracts in pipeline.test.ts BEFORE feature code.
3. **Fixtures lie.** Feature tests can't catch consumed-but-never-produced;
   only contract tests can. When a fixture claims knowledge (statsExact,
   topValues), the claim must be one production can actually make.
4. **Removal requires removal words. Re-emission absence is never removal.
   Selection targets, never permits.**
5. **A display edit may not change what a number MEANS** (metric-identity
   guard; new agg/col must be named in the user's words).
6. **Deterministic beats clever**: repairs (missing den → count(*), missing
   metric on filtered KPI → count(*)), rewrites (observed-value casing),
   guards — all deterministic and prompt-anchored, never model-judged.
7. **Degradation is said out loud** — in the chat response, not just logs.
8. **No partial ships.** A change-set zips only when the full chain is green.

## 7. Current state & pending live verification

All suites + typecheck + build + full chain green as of this handoff. Live
probes still to confirm on the user's machine (Gemini was down for the first
attempt; model resilience hotfix + A3.1 fixes since):
1. Fresh colo build → SLA attainment ON the build, plausible %, FILTER SQL.
2. Select dropdowns now derive from board tables (tickets.status/priority/…)
   and re-query on change.
3. "add a KPI counting only open tickets" → lands with count(*) + WHERE.
4. "show average ticket age as a line chart over time" → id-sum chart is now
   impossible; expect a real avg line or an honest drop (note: age_hours has
   corrupted upstream timestamps — negative avg is a DATA issue, documented).
5. Rate KPI under date filter recomputes (D5a).
6. Join phrasing → LEFT JOIN SQL or drop naming verified edges.
7. Edit-safety pair (percentage prompts) still safe.
8. Degraded-mode chat note when the key is bad.

## 8. Known issues / deferred (deliberate)

- Upstream colo data: reversed timestamps → negative avg ticket age. DATA,
  not code.
- Near-black chart color = accent #0F172A as series color 1 — cosmetic;
  reference-design renderer port (32px KPI, #f6f7fb, kind pills) exists as an
  old unapplied zip and needs manual re-port over A1+ renderer changes.
- Planner-path meta drift on style edits — bounded by reconcile meta parity +
  undo.
- Audit doc deferrals: A2/A6/B3 (delete-or-consume product calls), B5/B7/D2/
  D4 (hygiene), F2-F4 (further contracts).
- Session state is in-memory (resets on BFF restart) — expected.

## 9. Roadmap

- **A4 — period comparison** (NEXT): "vs last month" deltas on KPIs/trends.
  Grammar: `metric.compare?: {period: prior_period|prior_year}` compiling to
  two windows + delta; renderer delta chips. Same discipline: contracts in
  pipeline.test.ts first, executed goldens, all three surfaces symmetric,
  honest fallbacks (no date column → drop with warning).
- **B — prompting quality**: COT/few-shot on agents/patch using the incident
  library as negative examples; digest compression.
- **C — schema-graph cache**: persist enrichment + measured edges per source
  (invalidate on schema change) so cold builds stop re-measuring.
- **D — eval harness completion**: the executed-goldens pattern
  (derived/filters/joins tests) is the seed; add scenario replay from
  audit.jsonl + a scored regression suite.
- **E — governance**: per-tenant policy (allowed tables/columns), PII
  awareness in profiles, audit retention.

## 10. Test suite map

`test:agents` (pipeline mechanics incl. reconcile/applyOps), `test:derived`
(expr + guards, executed), `test:filters` (A1 + injection), `test:semantic`,
`test:enrich` (profile enrichment, executed), `test:pipeline` (STRUCTURAL
CONTRACTS — 10 groups), `test:joins` (A3, executed goldens),
`test:conversational`, plus the pre-existing ~25 suites in the chain.
