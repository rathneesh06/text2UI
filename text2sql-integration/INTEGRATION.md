# text2SQL / SQL Workbench — integration package
**VERSION: v7** (conversational build chat — the pipeline join, finished)

v7 fixes the reported regression ("prompts after Extract DB feel unresponsive;
colours are ignored") at its three roots, none of which was a data bug:

- **The junction was half-wired.** The orchestrator's palette/design direction
  only ever reached the legacy codegen path; the spec-driven path (colo, and
  every extracted source) got the raw prompt. The brief now flows into the spec
  planner as a visual directive (`brief` on `POST /api/dashboard/build`).
- **The spec couldn't express style.** `DashboardSpec.meta` gains `accent`
  (hex) and `chartPalette` (hex[]), sanitized deterministically; the planner is
  instructed to map color/mood prompts onto them and to preserve everything
  unrelated on edit turns; the renderer actually applies theme (light/dark
  containers, cards, table borders, axis ticks), accent (KPI values, first
  series color), and the palette. "Make the bars teal" now literally works.
- **Follow-ups had NO orchestration.** Once an artifact existed, every prompt
  went straight to the builder — questions triggered rebuilds. A new follow-up
  gate (`POST /api/gate`) classifies each turn (edit / question / chat) with an
  edit default on any failure so it can never block a build; a matching
  `respond` intent covers first turns. Follow-up turns also now enter
  conversation memory (previously history froze after turn 1).

Plus the join's payoff: **data questions inside the build chat**. For colo and
published extracts, a question ("which region drove revenue?") routes to
`POST /api/source/chat` — the text2SQL plan→guard→execute→compose loop running
against the local snapshot — so the answer is computed, not guessed. Uploaded-
file sources get the model's sample-grounded reply with honest hedging.
Dashboard turns now reply with a human change summary ("Switched to the dark
theme. Applied a 4-color chart palette. Added “Revenue by region”.") instead of
echoing the title.

Previous versions below.

**v6** (system-design-blueprint hardening)

v6 implements the relevant Phase-1/2 items from the team's system-design
blueprint, chosen for value-now and low risk to the working v5:

- **Durable staging + restart recovery**: stage state write-through to
  `stages.json` (atomic tmp+rename, like the manifest now is) and boot-time
  reconciliation — staged-but-unpublished tables survive a BFF restart, and the
  client restores the right panel after a page reload via
  `GET /api/sql/stage/:conversationId` (Extract DB works without reconnecting;
  extracting MORE tables still needs a live connection).
- **Atomic + idempotent publish**: manifest/stage writes can no longer be
  truncated by a crash; a duplicate "Extract DB" returns the already-published
  source instead of erroring.
- **Planner prompt slimming**: deterministic lexical table-relevance ranking —
  on catalogs beyond `T2SQL_SCHEMA_TOP_N` (12), only the most relevant tables
  are sent with full profiles (literal mention ≫ name-token ≫ column overlap;
  ties keep catalog order), the rest as a names-only line; long sample values
  are clipped. Small catalogs behave exactly as before.
- **Deterministic answer paths**: previews, empty results, and single-cell (KPI)
  answers skip the composer LLM entirely — lower latency, lower cost, zero
  hallucination surface on the simplest shapes.
- **Query classes**: previews get their own short timeout
  (`T2SQL_PREVIEW_TIMEOUT_MS`, 10 s) vs analytical queries
  (`T2SQL_LIVE_QUERY_TIMEOUT_MS`, 30 s).
- **Connection degradation**: two consecutive failed executions (each already
  retried on a fresh attach) mark the connection `degraded`, surface a
  reconnect prompt, and short-circuit further queries; the next success clears
  it. Status is included in the connect payload.
- **Execution telemetry**: chat responses and turn breadcrumbs carry
  `executionMeta` (duration, rows, source type) and a structured `policy`
  outcome (allowed / capped / rejected + reason); the UI shows a subtle
  "N rows · M ms · live" caption.
- **Source lifecycle**: `DELETE /api/sources/:projectId` (wb_* only) plus a
  confirm-guarded ✕ on each landing-page extract chip; deleting the active
  source falls back to a fresh session.
- **Schema search**: a filter box in the workbench table rail for large catalogs.

Deliberately deferred from the blueprint, with reasons: the Postgres metadata
store and 11 wb_* tables (real infra migration; atomic JSON + durable stages
deliver the Phase-1 benefit today — revisit for multi-instance BFF), full
service decomposition and the 4-way planner split (the single planner call is
a deliberate latency/cost choice; envelope fields were adopted instead),
async extraction jobs + turn-status streaming (needs job/SSE infra — queued
with the main-chat interactivity slice), embeddings-based retrieval (lexical
ranking first; measure before adding a vector dependency), parser-backed SQL
validation (no DuckDB-dialect-aware parser dependency worth its false-reject
risk yet; the layered guard + READ_ONLY attach stand), PII column redaction
and RBAC (needs governance rules from your side), and the /api/workbench/*
route renaming (cosmetic churn against a working frontend).

Previous versions below.

**v5** (staged "Extract DB" + interactive answers + fail-fast preflight)

v5 changes:
- **Interactive answers**: query results render by SHAPE — a single value becomes
  a KPI card, a small category aggregate an inline bar chart, a temporal
  aggregate a line chart, everything else the grid (charts collapse to "show
  rows"). Detection is deterministic — no LLM decides the UI — and the charts
  are dependency-free inline SVG.
- **Staged extraction + "Extract DB"**: "extract x and y" in chat no longer
  publishes immediately. Extracts ACCUMULATE per conversation in a right-hand
  panel (tables with expandable column lists; re-extracts dedupe), snapshotted
  into one staging DuckDB file. The **Extract DB** button at the panel's bottom
  (optional DB name) publishes everything as ONE source, which then appears on
  the text2UI start page like colo, ready for dashboard/ppt prompts. The
  schema-tree button now stages too ("Stage selected"); a build intent ("make a
  dashboard from x, y") auto-publishes since the pipeline needs a queryable
  source immediately. Unpublished stages don't survive a BFF restart; published
  sources do. New route: `POST /api/sql/extract-db {conversationId, label?}`.
- **Fail-fast TCP preflight**: connect probes `host:port` (~4s,
  `WB_PREFLIGHT_TIMEOUT_MS`) before the extension/attach machinery, so network
  problems produce an immediate, specific error — a silent drop points at
  route/VPN/firewalls; a refusal says the host is up but nothing listens on
  that port. Previously both surfaced ~20s later as a generic attach timeout.

v4 change: `/postgres` now takes a single **connection string** as the primary
input — paste `postgres://user:pass@host:5432/db` (encoded passwords like `%40`
are decoded; the scheme is optional, and `mysql://` is rejected with a pointer to
the workbench). The structured host/port/db/user/password form is still there
behind an "Enter fields manually" toggle — it remains the escape hatch for
passwords whose literal text is a valid percent-escape. v3 contents below.

> **Check what your repo has before anything else** — three revisions shipped
> under the same filename, and applying a stale download leaves you on v1
> (workbench only, MySQL only). From your repo root:
>
> ```bash
> bash check-and-apply-v7.sh          # diagnose: prints v0 … v7
> bash check-and-apply-v7.sh apply    # copy v7 in from ./paste-these + verify
> ```
>
> `paste-these/` contains FULL file versions (simplest, patch-proof application).
> After apply: restart dev:bff + dev, hard-refresh, open **/postgres**.

Everything in this package was applied to a copy of your repo and **verified**:
`tsc --noEmit` → 0 errors · `vite build` → success · both new test suites pass ·
BFF boots with all new routes live · workbench snapshot round-trip smoke-tested
(register → `/api/sources` lists it → `/api/query` serves it → writes blocked by guard).

## What this adds

**Pipeline 3 (text2SQL)** — a SQL Workbench at `/workbench`:
connect a `mysql://user:pass@host:3306/db` **or** `postgres://user:pass@host:5432/db`
string → chat with the live database
(NL → guarded SQL → grounded answers + result grid) → say "extract orders and
customers" → tables are snapshotted into a local DuckDB and registered as a
**named source** that appears on the build page exactly like "colo data".
From there it's the unchanged text2UI pipelines: the dashboard's runtime
`/api/query` and the deck compiler both route `wb_*` projectIds to the snapshot.

The design keeps your core principle: the planner LLM emits SQL as *data*, and it
only executes after `text2sql/guard.ts` → `storage/guard.assertReadOnly` (single
SELECT/WITH, banned-keyword scan) plus a forced LIMIT wrap — on top of the
`ATTACH ... READ_ONLY` that was already there.

## Package layout

```
new/        brand-new files — copy to the same paths in your repo
  bff/text2sql/guard.ts             planner-SQL safety gate (+ guard.test.ts)
  bff/text2sql/planner.ts           one structured Gemini call: intent + SQL/tables (+ planner.test.ts)
  bff/text2sql/composer.ts          rows -> grounded reply, deterministic fallback
  bff/text2sql/handler.ts           pure handlers: connect / schema / chat / extract
  bff/sources/db-conn.ts            DIALECT LAYER: parse/attach/introspect/snapshot for MySQL + Postgres (+ db-conn.test.ts)
  bff/sources/connection-registry.ts  runtime home for user connections (TTL, lazy live attach)
  bff/sources/workbench-store.ts    extracted-source registry + wbQuery (colo pattern, persistent manifest)
  src/workbench-api.ts              client for /api/sql/*
  src/pages/WorkbenchPage.tsx|.css  the workbench UI
patches/    unified diffs for the 6 modified files (apply with `git apply` or patch -p0 from repo root, strip the path prefix)
modified/   the fully-patched versions of those 6 files, for reference/diffing
```

Modified files and why:
- `bff/server.ts` — imports; `/api/sql/*` routes; `/api/sources` now lists colo **and**
  workbench extracts; `handleQuery` routes `wb_*` projectIds to `wbQuery`; the deck
  build wires `query = wbQuery` when `body.projectId` is a wb source.
- `src/App.tsx` — workbench sources discovered from the same `listSources()` call;
  `selectWbSource` / `handleUseWorkbenchSource` mirroring `selectColo`; `/workbench`
  route; wb projects excluded from upload-source persistence (server-side data).
- `src/pages/ChatPage.tsx` — the `isColo` server-source check now includes `wb_*`
  (no rows shipped; spec-driven dashboard path used).
- `src/pages/LandingPage.tsx` — extracted sources offered as chips next to colo;
  navbar link to the workbench.
- `src/components/Sidebar.tsx` — SQL Workbench nav entry.
- `package.json` — `test:t2sql-guard`, `test:t2sql-planner`, `test:db-conn`, chained into `test`.

## Dedicated Postgres page (`/postgres`)

A separate surface purely for Postgres, reachable from the sidebar ("Postgres")
and the landing navbar. Instead of one connection-string box it has a
**structured form** — host, port (default 5432), database, user (default
`postgres`), password, SSL toggle. Every field is sent literally to the BFF
(`POST /api/sql/connect` with `parts` instead of `connectionString`), so
passwords containing `@ % # $ !` need **zero escaping** — the class of bug that
percent-encoding causes cannot occur on this path. A "paste URI to fill" box
decodes a `postgres://…` string into the form (so you can review exactly what
will be sent) but the connect always uses the form values. Everything after
connect — chat, guarded queries, previews, extraction, build handoff — is the
same shared pipeline.

## Percent-encoding fix (important if you connect by URI)

Standard Postgres URIs are percent-encoded per the libpq spec: a password
`Secret@123` is written `Secret%40123`. The parser now DECODES user/password/
database for `postgres://` URLs (valid escapes only; malformed `%` falls back to
the raw text, so raw-special-character passwords still work). MySQL URLs remain
**byte-exact raw passthrough** — decoding there would silently change strings
already in production `.env`s — and this contract is pinned by tests. If a
Postgres password's literal text happens to be a valid escape sequence, use the
structured form (or key=value string), which never decodes.

## Postgres support (dialect layer)

`bff/sources/db-conn.ts` makes the engine a dispatch, not a fork:
- **Detection is explicit**: `postgres://` / `postgresql://` (SQLAlchemy `+driver`
  suffixes tolerated), or `dialect=postgres` in key=value form. Everything else is
  MySQL — byte-for-byte the previous behavior.
- **Parsing reuses the hardened mysql.ts parser** (raw `@ # $ ! :` passwords
  survive), then re-aims only the defaults at Postgres: port 5432, user `postgres`,
  `?sslmode=require` honored.
- **Both password conventions work** in URL form: standard percent-encoding is
  decoded (`Secret%40123` → `Secret@123`) while raw special characters still pass
  through untouched (invalid `%` sequences fall back to the literal text). The
  one ambiguity — a password whose LITERAL text looks like valid encoding, e.g.
  `%40` — resolves in favor of the URL standard; the key=value form
  (`host=… database=… password=… dialect=postgres`) is the always-raw escape hatch.
- **Attach mirrors attachMysql**: `INSTALL/LOAD postgres`, credentials in a DuckDB
  SECRET (never logged), `ATTACH … READ_ONLY` as `src`. First-ever Postgres connect
  downloads the `postgres` extension from extensions.duckdb.org (same egress your
  MySQL path already uses).
- **Exact SQL refs everywhere**: Postgres tables live under schemas, so
  introspection now returns each table's exact reference (`src."public"."orders"`)
  and the planner is instructed to copy it verbatim — this hardens the MySQL path
  too (refs are `src."<database>"."<table>"`), removing any guesswork about DuckDB
  name resolution.
- **One generic extraction** (`snapshotTables`) replaces the mysql-snapshot
  dependency for the workbench: whole-table pull through the read-only attach,
  capped, profiled — identical behavior for both engines. `mysql-snapshot.ts`
  is untouched (still serves the colo CLI).

## New routes

| Route | Purpose |
|---|---|
| `POST /api/sql/connect` | `{connectionString}` → introspect + register; returns `{connectionId, label, allTables, datasets}` — **never echoes credentials** |
| `GET /api/sql/:connectionId/schema` | rehydrate the schema tree |
| `POST /api/sql/chat` | `{connectionId, conversationId?, prompt}` → `{intent, answer, sql?, rows?, extracted?, handoff?}` |
| `POST /api/sql/extract` | `{connectionId, tables[]}` → snapshot + register → `{projectId, label, tables}` |

Chat intents: `query` (guarded SQL + grounded answer), `preview` (LIMIT 20 grid),
`extract` (snapshot → named source), `build` (snapshot, then the **client** drives
your existing pipeline with the returned `handoff.buildPrompt` — the source is
preselected and the user lands on the build flow), `chat` (schema Q&A).

## Config (all optional, sensible defaults)

```
WB_CONN_TTL_MS=14400000       # idle TTL for live connections (4h)
WB_DIR=./.t2ui/workbench      # snapshot files + manifest.json (survives restarts)
T2SQL_QUERY_MAX_ROWS=500      # hard LIMIT injected by the guard
T2SQL_ROWS_TO_CLIENT=200      # rows returned to the chat grid
T2SQL_PLAN_TIMEOUT_MS=20000
T2SQL_COMPOSE_TIMEOUT_MS=15000
```

Notes:
- Dashboards on workbench sources behave like colo: run the frontend with
  `VITE_REMOTE_DATA=1` so the rendered dashboard queries `/api/query` (otherwise
  it would chart only the 5 sample rows, same as colo would).
- The workbench manifest + snapshots persist on disk; live *connections* are
  in-memory with TTL (a BFF restart requires reconnecting, but extracts survive).
- First-ever connect downloads DuckDB's `mysql` extension (needs egress to
  extensions.duckdb.org) — your existing `mysql.ts` timeout messaging covers this.

## Verify after applying

```
npm run typecheck            # must be 0 errors
npm run test:t2sql-guard
npm run test:t2sql-planner
npm run test:db-conn         # dialect parsing + the generic snapshot core
npm run build                # vite
npm run dev:bff && npm run dev
```

**Verified in this sandbox:** all four test suites (guard, planner, db-conn parse
layer, and the generic snapshot core exercised against a real attached `src`
catalog — resolution, capping, skips, profiling), typecheck, vite build, BFF boot,
malformed-URL error paths, and the full extract→sources→query round trip.
**Not verifiable here (sandbox egress blocks extensions.duckdb.org):** the live
MySQL/Postgres ATTACH handshake — that is what your manual QA covers; the Postgres
attach is a line-for-line mirror of the MySQL attach your environment runs today.

Manual QA script (run once per dialect — MySQL and Postgres):
1. `/workbench` → paste the connection URL → Connect → schema tree fills.
   For Postgres, confirm non-`public`-schema tables show as `schema.table`.
   Then repeat on `/postgres` with the structured form (host/port/db/user/
   password) — this is the recommended PG path. Also test the paste-to-fill box
   with a percent-encoded URI (e.g. a password containing `%40`) and confirm the
   decoded password appears correct before connecting.
2. "which <dimension> has the most <measure>?" → answer + View SQL chip + grid.
3. "show me the <table> table" → 20-row preview.
4. "extract <t1> and <t2>, we need them later" → confirmation; check
   `./.t2ui/workbench/` for the .duckdb + manifest.
5. Go to `/` → the extract appears as a "Use …" chip → select it, type a build
   prompt → dashboard/deck builds; widgets query live (Network tab: `/api/query`
   with `projectId: wb_…`).
6. In the workbench: "make a dashboard from <t1> and <t2>" → auto-handoff to the
   build page with the source preselected and the prompt carried over.
7. Restart the BFF → the source still appears on `/` (manifest persistence).
8. Postgres-specific: preview a table in a non-`public` schema ("show me
   sales.orders") and extract it — the extract's local table name is the
   sanitized bare name (e.g. `orders`).

## Claude Code prompt (to apply this package to your live repo)

Paste this to Claude Code from your repo root, with this package unzipped at
`./text2sql-integration/`:

> First run `bash text2sql-integration/check-and-apply-v7.sh` from the repo root
> and tell me which version it reports. If it is not v7, apply the package:
> the simplest correct route is `bash text2sql-integration/check-and-apply-v7.sh apply`
> (it copies full v3 files from text2sql-integration/paste-these and runs the
> verification gate). Only if that script's verification fails, fall back to the
> manual route below and merge by hand:
> Apply the text2SQL integration package in ./text2sql-integration to this repo.
> 1) Copy everything under text2sql-integration/new/ into the repo at the same
>    relative paths (bff/text2sql/*, bff/sources/connection-registry.ts,
>    bff/sources/workbench-store.ts, src/workbench-api.ts, src/pages/WorkbenchPage.*).
> 2) Apply the unified diffs in text2sql-integration/patches/ to bff/server.ts,
>    src/App.tsx, src/pages/ChatPage.tsx, src/pages/LandingPage.tsx,
>    src/components/Sidebar.tsx, and package.json. If a hunk fails because our
>    copy has drifted, use text2sql-integration/modified/<file> as the reference
>    for the intended end state and merge the change manually — the intent of each
>    edit is described in text2sql-integration/INTEGRATION.md under "Modified
>    files and why". Do not change any other behavior.
> 3) Run `npm run typecheck` (must be 0 errors), `npm run test:t2sql-guard`,
>    `npm run test:t2sql-planner`, and `npm run build`. Fix any breakage caused by
>    drift between our repo and the package, keeping the package's design intact.
> 4) Summarize every file you touched and any manual merges you had to make.

## Known follow-ups (deliberately out of scope for this slice)

- Streaming stage events for workbench turns (planner → executor → composer) —
  same SSE pattern as /api/generate/stream.
- `@table` mentions in the workbench prompt input (autocomplete from allTables).
- Snapshot freshness: a "re-extract" action on a wb source (the manifest already
  carries everything needed).
- The goal-2 chat-interactivity items on the main ChatPage (intent gate,
  suggestion chips, version scrubber) — next slice.
