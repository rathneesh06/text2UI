# text2UI — Knowledge Transfer Document
*Handoff for continuing development in a fresh conversation. Pair this with
`IMPROVEMENT_PLAN.md` (the roadmap) and the current repo zip (the truth).*

## 1. What this project is

text2UI: an agentic pipeline that turns natural-language prompts + data
(uploaded CSVs, workbench extracts, or live MySQL/Postgres connections) into
interactive, editable dashboards. React/Vite frontend, Express BFF
("bff/"), DuckDB + Postgres storage (Docker), Gemini for model calls
(`bff/aiflow.ts`, model runners are injectable everywhere for offline tests).
A text2SQL subsystem (analyst loop, live sources, guarded query execution)
is integrated behind the same build endpoint.

## 2. Architecture — the one diagram that matters

**Build turn** (`POST /api/dashboard/build` → `bff/dashboard/handler.ts`):
```
prompt + Dataset[] profiles
 → semantic model        (bff/datasources/semantic.ts — entities, candidate
                          metrics, join candidates; deterministic)
 → query enhancement     (bff/dashboard/enhance.ts — ALWAYS-ON baseline:
                          column roles, house rules, design language, semantic
                          digest; enriched by analyst evidence > orchestrator
                          brief > LLM rewrite; combined is never empty)
 → decompose             (bff/dashboard/decompose.ts — prompt → 3-8 typed
                          tasks {kpi|trend|ranking|composition|comparison|
                          detail}; triviality gate; grounded-or-dropped;
                          deterministic fallback)
 → specialist agents     (bff/dashboard/agents.ts — kpi/bar/line/pie/table in
                          parallel, tasks routed per family, EACH with a
                          deterministic profile-derived fallback)
 → merge                 (bff/dashboard/merge.ts — dedupe by analytical
                          signature incl. chart family, interleaved caps,
                          sections, vibrant defaults)
 → validate + layout     (validate.ts, layout.ts — drop invalid, then balance
                          rows so NO row ships unfilled; 5 KPIs → 3+2)
 → compile               (compile.ts, sql.ts — deterministic SQL per widget,
                          data-scope chip; the model NEVER writes SQL)
 → render                (renderer.ts — one big template string; reference
                          design: 32px KPI values, icon chips, kind pills,
                          insight banner, rainbow bars, gradient areas,
                          compact mode for small data)
```
**Edit turn** (same endpoint, `currentSpec` present): deterministic undo/redo
intents FIRST (`session.ts`) → **patch-based ops** (`patch.ts` — model emits
minimal op list vs widget ids; unnamed widgets CANNOT change; removals gated
on removal intent or the selected widget) → fallback: full-spec planner
(`planner.ts`) + reconciliation (`reconcile.ts` — heals kept widgets against
the previous version) → same compile/render. The client persists the
returned spec as `currentSpec`.

**Chat↔dashboard connection**: per-conversation version stack + rolling
decisions (`session.ts`, in-memory, resets on BFF restart — chat itself is
durable in Postgres via the chat store); recent history + decisions reach the
edit planner; widget clicks in the preview post `t2ui.featureSelected` →
ChatPage chip → "make this a donut" binds by id; a `t2ui.query` postMessage
bridge lets the sandbox (foreign https iframe) query through the host page
(`Sandbox.tsx` `useQueryBridge`, hardened: embedded-iframe check, projectId
pinned server-side of the bridge).

**Audit**: `bff/datasources/audit.ts` → `.t2ui/audit.jsonl`, one line per
stage per turnId (prompt/enhance/decompose/agents/edit_ops/render incl. SQL).

**Data plane (mostly pre-existing — do NOT rebuild)**: `bff/sources/` —
`db-conn.ts` (conn parsing, dialect detect, DuckDB-ATTACH to live MySQL/PG —
this is why compiled DuckDB-flavor SQL runs on live DBs), `connection-
registry.ts` (tenant records, preflight, health, profiling → Dataset[]),
snapshots, workbench store, `colo.ts`; guarded execution (read-only assert,
row caps, timeouts, 410 expiry). `model.ts` is a HANDWRITTEN semantic model
for one helpdesk schema — superseded conceptually by the generic
`datasources/semantic.ts`, kept for the colo source.

## 3. Project id conventions
Uploads: plain project ids (datasets synced via `/api/datasets`, queried via
`/api/query` against server storage). `wb_` workbench extracts, `live_` live
DB sources, colo = the demo snapshot. All build through the SAME endpoint.

## 4. What was built in this conversation (chronological change-sets)
All committed on branch `restore/text2ui-pipeline` (multiple commits; last
known hash f6261ad + later ones). Each set also exists as a zip the user
applied via Claude Code:
1. **Restoration** — rerouted ALL dashboard builds through the spec pipeline
   (was gated to text2SQL sources only); enhancement layer; specialist
   agents; merger; fixed dead coverage gate (`kind === "chart"` matched
   nothing); fixed re-plan tie-break; removed dangling test refs.
2. **Layout + compact** — layout balancer (no unfilled rows), compact mode,
   pretty table headers, fixed broken date-trim regex (template-escaping
   trap — see gotchas).
3. **Chat connection** — session versions/undo/redo, chat memory to the edit
   planner, click-to-target, decisions drift guard.
4. **Brief fix** — orchestrator briefs carried `respond:false` and were
   misrouted as respond turns, discarding the whole plan (`"respond" in
   result` bug). Fixed at both layers + regression test.
5. **Query bridge** — sandbox data fetches over postMessage (browser blocked
   foreign-iframe → localhost fetches); hardened listener.
6. **Edit reconcile** — heals model-gutted edits; fixed conversationId
   stale-closure (first build was never versioned → undo broken).
7. **Figma edits + design** — patch-based ops with gated removals; insight
   banner, icon chips, subtitles, design language in baseline.
8. **Hermetic fix** — injected planner w/o injected runner pins planner path
   (tests were passing only because the live API call failed).
9. **Query breakdown** — decompose layer (user's idea), task routing.
10. **Semantic layer + audit** — generic semantic model w/ candidate-metrics
    tier (cold-start fix), audit trail.
11. **Reference design** — renderer visual anatomy rebuilt to match the
    user's five inspiration screenshots (kept in the OLD chat; the key cues:
    huge near-black KPI values, pastel icon chips, bold title + gray
    subtitle + kind pill per card, quiet dotted-grid charts, dot legends,
    soft #f6f7fb page, honest data-scope chip top-right).

## 5. Working conventions with this user (IMPORTANT)
- Claude (sandbox) edits a copy of the repo, verifies (typecheck + tests +
  vite build), zips ONLY changed files, and hands the user a **Claude Code
  prompt**: back up touched files to a NEW `./_pre-<name>-backup/` dir,
  extract-overwrite, merge (never blind-overwrite) package.json, run
  typecheck + the relevant test script, commit on `restore/text2ui-pipeline`
  with hash, remind to restart the BFF. Never touch `.env`, `bff/data/`,
  `text2sql-integration/`.
- The user's Claude Code instance is sharp: it audits zips, finds dead
  assertions and hermeticity leaks, and reports deviations. Treat its output
  as a code review; concede when it's right (it usually is).
- Tests: `npm test` chains everything; per-suite scripts `test:agents`
  (bff/dashboard/agents.test.ts — 16+ groups, the pipeline's suite) and
  `test:semantic`. ALL tests must run offline — model runners are injectable
  (`deps.agentRun`, planner injection, `skipRewrite`). Assertion style:
  plain node:assert, console.log("... ✅") per group.
- The user tests in Firefox on Windows, runs `docker compose up -d db` +
  `npm run dev:bff` + `npm run dev` (BFF local, ALLOWED_ORIGINS unset in
  local mode; compose sets localhost:4173,5173).

## 6. Gotchas that burned us (do not rediscover)
- **Renderer is ONE template literal** (`renderer.ts`). Backslash escapes
  inside it are treacherous — the date-trim regex shipped broken for ages.
  Rule: NO regex/backslash escapes in generated code; use string ops. Tests
  now EXECUTE extracted generated helpers (fmtX, prettyHeader).
- **React stale closures** on first-turn ids: conversationId is mirrored in
  `convIdRef` — same-turn uses read the ref.
- **`"key" in obj` discriminators**: caused the brief-eating bug. Use
  `=== true` + explicit narrowing.
- **Model re-emission is untrustworthy**: never trust a model to reproduce
  untouched content — that's why patch ops and reconciliation exist. Any new
  edit surface must follow the same principle.
- **Dead assertions** (`x || true`): happened twice; grep for it.
- **tsx watch** restarts the BFF on bff/ changes → in-memory session
  (undo stack) resets; expected, not a bug.
- Known data issue (user's DB, not code): negative avg ticket age — reversed
  timestamp subtraction upstream; also `.env` in early zips exposed a Gemini
  key + MySQL creds. **Rotation was still pending** as of handoff; the Gemini
  key was INVALID in dev, meaning edit-ops falls back to full-spec+reconcile
  until a valid key exists. Confirm rotation + a working key early.

## 7. Current verified state at handoff
Typecheck clean; full offline suite green (agents 16 groups, semantic,
conversational, analyst, sandbox, etc.); vite build ok. End-to-end verified
by the user through: uploads + live colo builds rendering data (via the
query bridge), patch edits, undo/redo, click-to-target. NOT yet verified
live by the user: the semantic layer zip + reference-design zip may still be
pending application (check `git log` on `restore/text2ui-pipeline` — if
`semantic:` and the 32px KPI anatomy aren't in the repo, those two zips from
Downloads still need applying).

## 8. Where to go next
Follow `IMPROVEMENT_PLAN.md`: Phase A1 (functional filters) is the agreed
next build; the user's COT/few-shot idea is Phase B (edit-ops + decompose
few-shot now, table-scoping few-shot with Phase C's schema graph). Phase D
(executed-numbers correctness harness) should land no later than mid-A.
