# text2UI — Pipeline-Completeness Audit

**Date:** 2026-07-22 · **Scope:** read-only; no code changed. · **Branch:** `restore/text2ui-pipeline` @ `cb41a88`

**Baseline:** `npm run typecheck && npm test` → **both pass** (typecheck clean; full offline suite `FULLTEST_EXIT=0`, no failures).

**Method:** Each capability was walked across the five layers — Producer → Emitter (schema/prompt/coercer) → Validator → Consumer (compile/SQL/renderer) → Round-trip (edit/applyOps/reconcile/undo/bridge). A capability is "complete" only if all five hold. Six sweeps (A–F) fanned out over the codebase; the highest-severity findings (A3/D1/F1, D3, D5a, and the percent double-scale check) were re-verified against source by hand before inclusion. Absence of a finding in a traced area means the chain held — the "verified complete" lists record what was checked.

**Bug class under audit:** a capability wired into *some* layers but not *all* — consumed-but-not-produced (topValues), produced-but-not-consumed (dead), schema-accepts/coercer-drops (coerceExpr↔where), or emittable-by-nothing (widget.filters). Feature tests missed these because fixtures hand-supplied the missing link.

---

## Headline

The historical bug class (`expr.where`, `widget.filters` asymmetry) is **closed** — those chains are now symmetric across schema/coercer/prompt/compile/render (verified, Sweep B). But the same class survives in **four new places**, one of which can silently drop legitimate widgets and show an incomplete dashboard:

1. **P1 (P0-shaped on the live path) — profile enrichment is not uniform across sources.** The observed-value / exhaustiveness honesty guards (A2.5/A2.8) depend on a *truthful* `uniqueCount`/`topValues` pairing, but the **MySQL introspect/live** path and **text2sql finding views** build profiles from a ~5-row sample and never call `exactColumnStats` — so `uniqueCount ≤ 5` makes the guard think it has seen every value, and any real literal outside the sample is dropped as "matches NO observed value." Cross-confirmed independently by Sweeps A, D, and F. This is exactly the A2.8 failure mode, one source-type deeper.

2. **P1 — `reconcile` does not protect `meta`/`filters` the way `patch` does** — a planner-fallback edit that drops accent/insight/subtitle/filters silently distorts prior work.

3. **P1 — the query-path sanitizer is *stricter* than compile** — an `expr` (rate/ratio) KPI added via an edit turn renders on build, then 400s the moment any global filter is applied.

4. **P1 — chart & table `format` is produced but the renderer ignores it** — a currency/percent/hours column or series renders as a bare number.

Plus a cluster of honesty gaps (Sweep E): model-down degradation, declined edits, and net-zero edits can all return a success-shaped message with no user-visible signal.

**No P0 wrong-number-from-double-transform was found.** Percent is scaled exactly once (×100 in `sql.ts:49` for `op:"pct"` only; `renderer.ts:74` appends `%` without re-scaling) — verified by hand.

---

## Sweep A — Field Contracts

| ID | Sev | Capability / field | Broken link | Evidence (file:line) | What completion requires |
|----|-----|--------------------|-------------|----------------------|--------------------------|
| A1 | P2 | `ColumnProfile.avg` — consumed, never produced | Producer | Declared `shared/types.ts:14`; **no producer** (`exact-stats.ts:57` min/max only; `profile-enrich.ts` no avg; `ingest.ts:82`). Consumed `deck/catalog.ts:52,76` → slide-planner grounding → "avg N" always blank | Compute `avg(col)` in `exactColumnStats`/`enrichColumn`, or delete field + consumer |
| A2 | P3 | `ColumnProfile.nullCount` — declared, dead both ends | Producer+Consumer | Declared `shared/types.ts:15`; only in test fixtures (`text2sql/planner.test.ts:16`); no producer, no consumer | Delete, or populate + use (null-share warnings) |
| A3 | **P1** | topValues/exact stats **produced inconsistently** — MySQL introspect skips `exactColumnStats` | Producer asymmetry | MySQL: `mysql.ts:351` `enrichColumns` on 5-row sample only (`:346` uniqueCount from sample). Postgres sibling: `db-conn.ts:375` runs `exactColumnStats`. Consumer `validate.ts:59` `exhaustive = uniqueCount ≤ observed.length` → always true on 5 rows → real literal dropped `validate.ts:74`. Live path `connection-registry.ts:109,240` → `handler.ts:404`. **Verified by hand.** | Call `exactColumnStats` in `introspectMysql` (handle already open); gated behind `T2SQL_LIVE_SOURCE` |
| A4 | P2 | `deck/local-data.ts` skips `exactColumnStats` despite a live DuckDB handle | Producer under-enriches | `local-data.ts:60` `enrichColumns` on 20-row sample; `uniqueCount` exact via `approx_count_distinct` (`:45`) so lower risk, but topValues/min/max are a 20-row floor | Run `exactColumnStats` in `profileTable` |
| A5 | P2 | `text2sql materializeFindings` — crude types + no exact stats | Producer replicates shape incompletely | `handler.ts:550-556`: type only `number`/`string` (date→string → no min/max → no daterange filter `filters.ts:71`); 5-row `enrichColumns` | Type from `DESCRIBE`; run `exactColumnStats`; flag-gated |
| A6 | P2 | `DashboardMeta.audience` — produced, never consumed | Consumer | Produced `planner.ts:203` (schema `:71`); no dashboard consumer (`renderer.ts` reads title/subtitle/insight/theme/accent/palette only; `patch.ts:157` allowlist excludes it; `merge.ts:62` excludes it) | Consume (feed tone/subtitle) or drop from `DashboardMeta` + planner schema |
| A7 | P3 | `KpiWidget.subtitle` — produced + rendered, absent from type | Type | Rendered `renderer.ts:152`; produced `planner.ts:49`, `agents.ts:117`; `KpiWidget` omits it `dashboard-spec.ts:51-59` (Chart/Table declare it) | Add `subtitle?: string` to `KpiWidget` |

**Verified complete:** `min`/`max` (produced ingest/enrich/exact, consumed filters/validate/enhance/catalog), `topValues` (complete for uploads/colo/PG/workbench; the inconsistent producers are A3/A4/A5), `CompiledGlobalFilter.{tables,cols,options,min,max}`, `CompiledWidget.seriesKeys`, `DashboardMeta.{subtitle,insight,accent,chartPalette,theme}`, `Metric.{label,format,expr}`, `BaseMetric.where`, `Dimension.{timeGrain,label}`, widget `{filters,sort,limit,groupBy,width}`.

---

## Sweep B — Model-Surface Symmetry (agents ↔ planner ↔ patch schemas ↔ coercers ↔ prompts)

| ID | Sev | Capability / field | Broken link | Evidence (both sides) | What completion requires |
|----|-----|--------------------|-------------|-----------------------|--------------------------|
| B1 | **P2** | `sort` ({by,dir}) unreachable on agent + edit paths | Schema (agents+patch) + prompt (all) | Live downstream: `sql.ts:107-109,137-139`, sanitized `filters.ts:379`. Exposed only in `planner.ts:58`. **Missing** from agents `CHART_ITEM`/`TABLE_ITEM` (`agents.ts:40,41`) and patch `WIDGET_FIELDS` (`patch.ts:25-38`). No prompt teaches it. "Sort this chart descending" on an edit has no field to land in | Add `sort` to agents CHART/TABLE items + patch `WIDGET_FIELDS`; teach it in planner + patch prompts |
| B2 | P3→**see C2** | `TableColumn.format` not exposed by any schema, not rendered | Schema (all 3) + consumer | Type `dashboard-spec.ts:79`, sanitizer keeps it `filters.ts:371`; no schema exposes it (`agents.ts:41`, `planner.ts:55`, `patch.ts:33` = `{col,label,agg}`); renderer ignores it `renderer.ts:250-253`. (Consumer half = C2, rated P1) | Expose in the 3 column schemas **and** apply in `DataTable`, or drop |
| B3 | P3 | `meta.audience` uneditable on patch path | Schema (patch) | Planner sets it `planner.ts:203`; patch `update_meta` excludes it (`patch.ts:59-63` schema, `:157` allowlist). Same dead field as A6 | Drop, or add to patch meta schema + allowlist + render |
| B4 | P3 | agg/format/timeGrain enums unconstrained on the edit path | Schema (patch) over-permissive | agents/planner constrain (`agents.ts:29,30,35`); patch `WIDGET_FIELDS` types them as bare `{type:"string"}` (`patch.ts:30,32,33`). `format` never enum-checked in validate → out-of-enum format renders as plain number `renderer.ts:70-78` | Give patch the same enums the other two schemas use |
| B5 | P3 | `groupBy[].label` dropped by `coerceTables` | Coercer | Schema accepts `agents.ts:35`; `coerceTables` maps `{col,timeGrain}` only `agents.ts:141` (chart-x keeps it `:126`). Cosmetic — renderer uses SQL keys `renderer.ts:243`, so unused anyway | Keep `label` in `coerceTables`, or drop from schema |
| B6 | P3 | `KpiWidget.subtitle` type gap (= A7) | Type | Schema+coercer+render all present (`agents.ts:39,117`, `renderer.ts:152`); type omits it `dashboard-spec.ts:51-59` | Add `subtitle?` to `KpiWidget` |
| B7 | P3 | `CHART_ITEM.kind` enum broader than each agent honors | Schema over-advertises | Shared `CHART_ITEM` offers all 5 kinds to every chart agent `agents.ts:40`; `coerceCharts` collapses to family fallback `agents.ts:124,271`. Prompts steer correctly, so benign | Optionally narrow per-agent `kind` enums |

**Verified complete & symmetric:** `expr` (op/num/den + `where` on **both** sides) across all three schemas, coercers (`coerceExpr`/`coerceWhere` keep num.where AND den.where `agents.ts:100-106`), prompts, and compile (`sql.ts:38-50`) — the previously-regressed field now holds. `widget.filters`/`where` grammar symmetric on all three paths. Filter-op enum, expr-op enum, agg/format/timeGrain enums identical between agents and planner (patch is the loose one, B4).

---

## Sweep C — Renderer Coverage

**Percent double-scaling: NOT present (verified).** `×100` in `sql.ts:49` (only `op:"pct"`); `renderer.ts:74` appends `%` without re-scaling. Single transform on the KPI path.

| ID | Sev | Capability | Broken link | Evidence (file:line) | What completion requires |
|----|-----|-----------|-------------|----------------------|--------------------------|
| C1 | **P1** | Chart **series `format`** (currency/percent/hours/days/compact) | Consumer = renderer `Chart` | Produced `compile.ts:36` (`seriesKeys.format`); typed `dashboard-spec.ts:178`. `Chart` reads seriesKeys for key/label only (`renderer.ts:162,202,218`); `YAxis` has no `tickFormatter` (`:190`), `Tooltip` no `formatter` (`:178,191`). A pct series shows `45.2` (unitless) | Apply `fmt(v,k.format)` in chart `YAxis.tickFormatter` + `Tooltip.formatter`, per series |
| C2 | **P1** | **Table column `format`** | Producer (`compile` drops) + consumer (`DataTable`) | `TableColumn.format` `dashboard-spec.ts:79`, kept by query validator `filters.ts:371`; but `buildTableSql` cols carry only `{key,label}` (`sql.ts:121-132`), `compile.ts:29` discards cols; `DataTable` formats by JS type only `renderer.ts:253`. Currency/percent column → plain number | Carry per-column format map through compile onto the widget; `DataTable` calls `fmt(v,colFormat)` per column |
| C3 | P3 | KPI `subtitle`/`format` read but not on the type (= A7/B6) | Type | `Kpi` reads `w.subtitle` `renderer.ts:152` and `w.format` `:151,127`; `KpiWidget` declares neither `dashboard-spec.ts:51-59`; sanitizer drops them `filters.ts:359` | Add fields to type + sanitizer, or drop the reads |

**Verified complete & single-transform:** all 7 widget kinds render with no dead branch (`renderer.ts:312-317`); all 6 `ValueFormat` values handled once each in `fmt()` (`:74-79`, wired to KPI — the chart/table gap is C1/C2); expr KPI value + div-by-zero→`—`; sort/limit (SQL-side); width (`widthClass` all 4 values `:95-98`); theme/accent/chartPalette (hex-guarded `:22-25`); meta.subtitle/insight (`:326-333`); global daterange+select UI wired through `activeFor`→`queryWidget`→`filterConditions`, gracefully hidden for pre-`queryWidget` data layers. **Latent (not a finding, per scope):** multiselect renderer support exists (`renderer.ts:292`, `filters.ts:246`) with no derivation — intentional.

---

## Sweep D — Flow Traces

| ID | Sev | Capability / flow | Broken link | Evidence (both sides for parity) | What completion requires |
|----|-----|-------------------|-------------|----------------------------------|--------------------------|
| D5a | **P1** | Global-filter re-query of an **expr (rate/ratio) KPI** — sanitizer *stricter* than compile | Round-trip (query path rejects what compile renders) | `sanMetric` requires `agg`+`col` unconditionally `filters.ts:288-289`; `metricExpr` ignores them when `expr` set `sql.ts:44-52`; validate never backfills top-level agg (expr branch `validate.ts:97+`); patch add_widget metric has **no `required:agg`** `patch.ts:30` (planner does `planner.ts:32`). → expr KPI renders on build, **400s on filter** (`server.ts:565`). **Verified by hand.** | `sanMetric` skips agg/col when a valid `expr` is present (mirror `metricExpr`), OR validate backfills `agg:"count",col:""` on expr metrics |
| D3 | **P1** | `reconcile` ↔ `patch` **meta/filters protection parity** (planner-fallback edit) | Round-trip (reconcile) | Removal parity **holds** (same `REMOVAL_INTENT`, `patch.ts:210` vs `reconcile.ts:47`). Meta does **not**: patch whitelist-merges over `{...current.meta}` `patch.ts:143,156-160`; reconcile takes `{...next.meta}` and heals only title `reconcile.ts:34-35`. Dropped accent/insight/subtitle fall to **defaults** `handler.ts:200`. Filters use `next.filters` not current `reconcile.ts:37`. **Verified by hand.** | Base meta on `current.meta`, overlay only model-changed keys (patch's whitelist-merge); carry `current.filters` forward |
| D1 | **P1** | Build → equivalent enriched Dataset across all sources (= A3/A5/F1) | Producer asymmetry | MySQL introspect stops at 5-row `enrichColumns` `mysql.ts:346,351` vs PG `db-conn.ts:375`; `materializeFindings` collapses types + no exact stats `text2sql/handler.ts:550-559`; `local-data.ts` `approx_count_distinct` `:45`. Consumer `validate.ts:57-59`, `filters.ts:110`. Exact tier: uploads `ingest.ts:64-93`, workbench snapshot `db-conn.ts:492` | Run `exactColumnStats` on MySQL introspect + materializeFindings; or make the exhaustiveness guard treat sampled profiles as non-exhaustive |
| D6 | P2 | Audit trail covers every stage incl. rejections/warnings/restores | Consumer (missing `audit()` calls) | All 7 `audit()` in `handler.ts` (`:102,121,132,137,170,177,220`); none in `server.ts`. Unlogged: undo/redo returns (`:83-96`), unactionable noChange (`:161`), 422 (`:206`), 502 (`:186`), reconcile heals (only `console.log` `:195`), `/api/dashboard/query` (`server.ts:552-570`). Declared-but-never-emitted stages `history`/`validate`/`reject` `audit.ts:19` | Add `audit()` at those returns + inside `handleDashboardQuery` (success + 400 catch) |
| D5b | P2 | Global-filter re-query of **oversized** widgets — sanitizer caps compile lacks | Round-trip | `filters.ts:338` limit ≤10000, `:364,384` ≤30 cols/≤8 series, `:376` ≤5 groupBy — no matching caps in validate/sql → a large widget renders then 400s on filter | Apply the same caps at validate time |
| D2 | P3 | Edit → patch → validate → compile → re-render, incl. selected-widget | — (complete) | Flow complete; `applyOps` accepts `selectedId` but never reads it `patch.ts:137` (targeting is LLM-side); stale comment `handler.ts:145` | Delete dead param + fix comment |
| D4 | P3 | Undo/redo full-spec restore | — (complete) | Full `DashboardSpec` incl. meta/insight/filters stored + recompiled `session.ts:46-50`, `handler.ts:89`. Nit: `decisions[]` not truncated on undo `session.ts:49` | Optional: prune redo-branch decisions |
| D7 | P3 | Session/conversation continuity | — (complete) | Editor-semantics version stack `session.ts:49`; chat context merges history+decisions `handler.ts:232` | None |

**Verified complete:** the **P0 sanitizer concern (sanitizer *looser* than compile = injection/drift) is NOT present** — every SQL-affecting field compile reads is whitelisted and rebuilt identically by `sanitizeWidget` across KPI/chart/table (`filters.ts:285-399` vs `sql.ts:96-142`); the only drift is the *stricter* direction (D5a/D5b). Per-table date cols (`f.cols[table]||f.col` `renderer.ts:60`) and select-option resolution (`filters.ts:171`) correct. Removal-intent parity holds.

---

## Sweep E — Error-Path Honesty

| ID | Sev | Capability / path | Broken link | Evidence (file:line) | What completion requires |
|----|-----|-------------------|-------------|----------------------|--------------------------|
| E1 | **P1** | Model-down / agent-timeout → deterministic fallback is **invisible** | Consumer (warnings) | Per-agent `source:"fallback"/"skipped"` built `agents.ts:334-336,351`, decompose `decompose.ts:139`; lands only in `audit()` `handler.ts:137`; `warnings` = `[...healedNotes,...plan.warnings]` `handler.ts:218` excludes them. A model-down build returns a schema-derived board with a plain success summary. Self-documented `aiflow.ts:154-157` | When ≥1 agent served `fallback`/`skipped` **due to failure** (not applicability), append a user-facing note; distinguish inapplicable (silent) from model-failed (surface) |
| E2 | **P1** | Edit applies ops but net-zero effective change → "Updated the dashboard." | Consumer | Metric-identity guard reverts the only change but pushes to `applied` `patch.ts:186-189`; `summarizeSpecChange` finds no diff → generic fallback `handler.ts:370`. Only `applied.length===0` is covered `handler.ts:166` | Detect net-zero (deep-equal current vs rendered) → honest noChange message |
| E3 | **P1** | Declined metric change surfaced to nobody | Consumer | Decline note "kept X — the request didn't ask to change the metric" pushed to `applied` `patch.ts:188`; handler surfaces only `r.rejected` `handler.ts:176`. User told nothing | Route decline-class `applied` notes into surfaced warnings, or split ApplyResult into applied/declined/rejected |
| E4 | P2 | 422 (all widgets dropped) warnings dropped by the client | Round-trip | Server sends `{error,warnings}` `handler.ts:205`; client throws `json.error` only `api.ts:61-63`; ChatPage falls back to codegen `ChatPage.tsx:392`. Drop reasons never reach user | Attach `warnings` to the thrown Error and surface them |
| E5 | P2 | 0-rows-after-filter conflated with no-data | Consumer | `ErrorBox` for query-fail (honest) `renderer.ts:115`; `Empty()` "No data" fires identically for empty source, filter-excluded-all, and 0-after-agg `renderer.ts:116,168,238`. Filter state known `activeFor` `:52-68` but unused | When `activeFor(table)` non-empty and 0 rows → "No rows match the current filters" + reset |
| E6 | P3 | LLM rewrite failure silent | — (harmless) | `directiveSource→"none"`, proceeds on complete baseline `enhance.ts:231-244` | None required (baseline is the contract) |

**Verified honest:** all-ops-rejected edit (`handler.ts:166-173` returns noChange + reasons — the recent fix holds); unactionable edit (`:161`); validation drops on success path flow to `warnings` and display (`ChatPage.tsx:385`, count uses validated widgets — al5); reconcile heals→warnings→displayed; undo/redo + stale-version 422; planner total failure → 502 with GEMINI_API_KEY diagnostic; `callGemini` throws (not empty). The invisibility is strictly downstream aggregation (E1).

---

## Sweep F — Test Blindness

| ID | Sev | Capability under-tested | Blindness type | Evidence (file:line) | What a test should assert |
|----|-----|------------------------|----------------|----------------------|---------------------------|
| F1 | **P1** | Exhaustiveness guard on sample-only producers (= A3/D1) | Fixture-supplied + contract-missing | Guard `validate.ts:59,74`; truthful producers `exact-stats.ts:52`; untruthful `mysql.ts:346`, `mysql-snapshot.ts:152`, `text2sql/handler.ts:554`. `pipeline.test.ts:63` reads only enrich+exact+ingest — blind to the three | Drive each producer path; assert non-exhaustive `uniqueCount > topValues.length`; prove a partial-sample category isn't falsely dropped |
| F2 | P2 | "Every consumed profile field has a producer" | Contract-by-grep | `pipeline.test.ts:63-68` regexes 3 files for substrings; `min`/`max`/`type`/`name` match trivially (`Math.min`, `.name`); proves nothing is *assigned* to output | Enumerate every `ColumnProfile` builder; assert each output carries topValues+min/max |
| F3 | P2 | Agent coercion of `expr.where` + `widget.filters` | Injected-bypass + grep | Asserted only by grepping `agents.ts` source `pipeline.test.ts:51-52,127`; no fake response with `expr.where` fed through `runChartAgents`; injected widgets carry neither `agents.test.ts:74-95` | Inject a model widget with expr.where + filters; assert `FILTER (WHERE…)` + widget WHERE in compiled SQL |
| F4 | P2 | Schema ↔ coercer round-trip (the A2.4 class) | Injected-bypass | All suites use `fake()` runners `agents.test.ts:39`; real JSON schemas never validate a response; `pipeline.test.ts:23-53` greps schema text | Validate a representative object against each JSON schema, then round-trip through the coercer, asserting field preservation |
| F5 | P2 | Sanitizer ↔ compile SQL parity | Contract-missing | Build compiles from validated widget `compile.ts:24`; query recompiles from independent whitelist `filters.ts:349`; no test asserts equality. Whitelists duplicate `dashboard-spec.ts:7-10` | (a) SQL-equality round-trip; (b) assert sanitizer whitelists ⊇ shared Agg/Format/Grain/Op/Kind unions |
| F6 | P3 | Renderer covers every kind; chart/table format consumed (= C1/C2) | Contract-missing | Renderer tests only render KPI (`agents.test.ts:213`), theming, one bar (`filters.test.ts:253`); never line/area/pie/donut/table | Render a plan with all KINDS + formats; assert each recharts component + formatted output |
| F7 | P3 | Guards only ever run against truthful fixtures | Fixture-supplied (canonical A2.8 mask) | Every fixture hand-builds consistent topValues/uniqueCount `derived.test.ts:24`, `filters.test.ts:31`, `pipeline.test.ts:81`, `enrich.test.ts:125` | A fixture with topValues ⊊ uniqueCount (non-exhaustive) asserting no false drop |

**`pipeline.test.ts` enforces today:** schema symmetry (expr op/num/den, where, filters) via regex; coercer preservation via grep; profile producer/consumer via substring (weak, F2); **widget.filters validate→compile end-to-end (genuinely executed — the strongest section).**

---

## (a) Five highest-leverage completions, ranked

1. **Uniform profile enrichment across all sources (A3/D1/F1).** Call `exactColumnStats` on the MySQL introspect path and `materializeFindings` (and ideally deck `local-data`), *or* make the exhaustiveness guard treat any sampled profile as non-exhaustive. This is the only finding that silently drops legitimate widgets / shows an incomplete dashboard, and it's the A2.8 class one source deeper. Highest leverage — it protects the honesty guards you already built.
2. **`reconcile` meta/filters protection parity with `patch` (D3).** Base meta on `current.meta` and overlay only model-changed keys; carry `current.filters` forward. Stops silent distortion of user work on planner-fallback edits.
3. **Consume chart & table `format` in the renderer (C1/C2).** Wire `fmt()` into chart `YAxis`/`Tooltip` and per-column in `DataTable`. Stops unformatted/misleading numbers on every non-KPI widget.
4. **`sanMetric` expr-aware, or validate backfills agg (D5a).** Stops rate/ratio KPIs added via edit turns from 400-ing the instant a filter is applied.
5. **Honest degradation surfacing (E1/E2/E3).** Fold fallback-source, declined-edit, and net-zero-change signals into the returned `warnings`. Closes the "success message over nothing applied / model-down" honesty gap — the exact product-bar violation this codebase has been hardening against.

## (b) Contracts to add to `pipeline.test.ts`

1. **Source-shape equivalence (P1).** Drive *every* `ColumnProfile` producer (upload, colo, PG, MySQL introspect/live, MySQL snapshot, workbench extract, text2sql findings, deck local-data) and assert each output carries `topValues` + `min/max` and a *truthful* `uniqueCount` (> `topValues.length` when the column is non-exhaustive). Directly catches A3/D1/F1/F7.
2. **Sanitizer ↔ compile parity (P2).** Round-trip SQL-equality: `buildKpiSql/buildChartSql(validatedWidget)` == `buildWidgetSql(sanitizeWidget(sameWidget), [])`; plus a set assertion that the sanitizer whitelists ⊇ the shared `Agg`/`ValueFormat`/`TimeGrain`/`FilterOp`/`WidgetKind` unions. Catches D5a/D5b and future drift.
3. **Schema ↔ coercer round-trip (P2).** Validate a representative object against each real JSON schema (agents per-agent, `DASHBOARD_SCHEMA`, `EDIT_OPS_SCHEMA`), then push it through the matching coercer and assert field preservation. Replaces the source-text greps; catches the coerceExpr-drops-where / A2.4 class structurally.
4. **Renderer coverage (P3).** Assert every `KINDS` entry has a renderer branch, and that every `ValueFormat` is applied by KPI **and** chart **and** table. Catches C1/C2/F6.

## (c) Could not verify (and why)

- **Runtime frequency** of D5a (edit model emitting an `expr` KPI with no `agg`), D3 (model dropping meta on a fallback re-emission), and E2 (net-zero op sets) — all are schema/code-*permitted* and the asymmetry is certain from source, but read-only static analysis can't prove how often a live model triggers them. The patch prompt actively steers toward expr rate-KPIs (`patch.ts:77`), so D5a is plausible, not rare-by-construction.
- **Whether A3/A5 actually flip an exhaustiveness decision** depends on real column cardinality vs sample size at runtime; the *producer asymmetry* is certain, the *drop* is conditional on data.
- **Audit file actually being written** depends on `T2UI_AUDIT` (default on) + filesystem permissions (`audit.ts:13,33`); D6's missing call-sites are certain from grep, the sink behavior was not exercised.
- **UI rendering** of warnings / the 422→codegen fallback branch (E4) was reasoned from code, not executed — this is a read-only audit; the BFF was not driven.
- **`compile.ts` KPI/chart SQL bodies** were confirmed via `sql.ts` + `validate.ts` + targeted greps, not read end-to-end; the load-bearing stages were traced directly.

---

*Severity legend — P0: can show a wrong number or destroy/distort user work · P1: advertised capability nonfunctional on some path · P2: dead/latent/asymmetric code · P3: hygiene. No code was modified in producing this report.*

---

## Resolution — Phase A2.10 (commit `8e6c1a4`)

The five ranked completions were implemented and verified (typecheck clean; targeted suites + full `npm test` green). Status per finding ID:

| ID | Status | Resolution |
|----|--------|-----------|
| A1 | ✅ | `avg` now produced in exact-stats / enrich |
| A2 | ⏸ deferred | `nullCount` — delete-or-consume decision, not forced |
| A3 | ✅ | `statsExact` gate + MySQL introspect computes exact stats |
| A4 | ✅ | deck `local-data` computes exact stats over its DuckDB handle |
| A5 | ✅ | text2sql finding views typed from DESCRIBE + exact stats |
| A6 | ⏸ deferred | `meta.audience` — delete-or-consume decision |
| A7 | ✅ | `KpiWidget.subtitle` typed |
| B1 | ✅ | `sort` added to agent + patch schemas and prompts |
| B2 | ✅ | `TableColumn.format` exposed in schemas and rendered |
| B3 | ⏸ deferred | `meta.audience` on patch path — delete-or-consume |
| B4 | ✅ | patch `WIDGET_FIELDS` enums constrained to match agents/planner |
| B5 | ⏸ deferred | `groupBy[].label` coercer drop — hygiene |
| B6 | ✅ | same as A7 (`subtitle` typed) |
| B7 | ⏸ deferred | `CHART_ITEM.kind` over-broad enum — hygiene |
| C1 | ✅ | chart `YAxis.tickFormatter` + tooltip `formatter` apply `fmt()` |
| C2 | ✅ | per-column format carried through compile (`columns: cols`) + `DataTable` |
| C3 | ✅ | KPI `subtitle`/`format` typed (= A7) |
| D1 | ✅ | = A3/F1 — uniform enrichment + unforgeable `statsExact` gate |
| D2 | ⏸ deferred | dead `selectedId` param + stale comment — hygiene |
| D3 | ✅ | reconcile whitelist-merges meta over current + carries filters forward |
| D4 | ⏸ deferred | redo-branch `decisions` truncation — hygiene (correctness was fine) |
| D5a | ✅ | `sanMetric` skips agg/col when a valid `expr` is present |
| D5b | ✅ | sanitizer size caps matched at validate time |
| D6 | ✅ | `audit()` added at undo/redo, query path, 422/502, reconcile heals |
| D7 | — | complete at audit time; no change needed |
| E1 | ✅ | fallback/degradation source surfaced in returned warnings |
| E2 | ✅ | net-zero edit returns an honest no-change message |
| E3 | ✅ | metric-guard decline routed to the surfaced `notes` channel |
| E4 | ✅ | client preserves 422 `warnings` on the thrown error |
| E5 | ✅ | 0-rows-after-filter distinguished from no-data |
| E6 | — | no action required (baseline is the contract — harmless by design) |
| F1 | ✅ | pipeline.test.ts group 5 — exhaustiveness requires `statsExact` |
| F2 | ⏸ deferred | producer/consumer output assertion — test-hardening |
| F3 | ⏸ deferred | agent coercion of expr.where/filters via injected round-trip — test-hardening |
| F4 | ⏸ deferred | schema↔coercer conformance round-trip — test-hardening |
| F5 | ✅ | pipeline.test.ts group 6 — sanitizer ↔ compile parity |
| F6 | ✅ | pipeline.test.ts group 7 — renderer consumes every produced format |
| F7 | ✅ | pipeline.test.ts group 5 fixture — sample-floor profile cannot hard-drop |

**Not resolved by design:** A2/A6/B3 are delete-or-consume product decisions left to the owner; B5/B7/D2/D4 are hygiene; F2/F3/F4 are further test contracts beyond the four that landed. No P0 was ever open. The one P0-shaped finding (A3/D1/F1) is closed both at the consumer (unforgeable `statsExact` gate — structurally cannot misfire) and at the producers (uniform exact enrichment).
