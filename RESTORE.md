# text2UI Pipeline Restoration

**What happened, what was restored, and how the new pipeline works.**

## Diagnosis — the pipeline was stranded, not deleted

The spec-driven text2UI pipeline (planner → validate → compile-to-SQL →
deterministic render) survived the text2SQL integration intact on the server.
Three things broke around it:

1. **Routing (the actual "destruction").** In `src/pages/ChatPage.tsx` the spec
   pipeline was gated behind `if (mode === "dashboard" && isColo)` — a leftover
   of the integration pilot, where `isColo` matched only colo / `wb_` / `live_`
   (text2SQL) sources. Every **uploaded-data** build — the core text2UI case,
   with data synced to the Docker-backed store via `/api/datasets` — silently
   fell through to the legacy free-form codegen path: no spec, no validation,
   no deterministic SQL. The integration's own sources got the robust pipeline;
   text2UI's original sources lost it.
2. **Query enhancement was best-effort, not guaranteed.** `rewritePrompt` was
   skipped whenever an orchestrator brief or analyst directive existed, had a
   9-second timeout, and returned `null` on any failure — so many builds reached
   the planner with *no* baseline instructions at all.
3. **One monolithic planner call** invented the entire dashboard, with no
   per-widget specialization and a single point of failure.

(Also found pre-existing: `package.json` referenced two files that do not exist
— `bff/design-rag/synth/campaign.test.ts` and `campaign-cli.ts` — which crashed
`npm test` midway. The dangling references were removed.)

## The restored pipeline

```
prompt + data
   │
   ▼
QUERY ENHANCEMENT LAYER  (bff/dashboard/enhance.ts)          ← ALWAYS runs
   • deterministic baseline: column roles (measure / dimension / temporal /
     identifier), suggested time grains, house rules, coverage minimums —
     produced for 1 column or 500, for a 2-word prompt or an essay
   • enriched by the best available directive:
     analyst evidence  >  orchestrator brief  >  LLM query rewrite
   • the directive can fail; the baseline cannot — `combined` is never empty
   │
   ▼  (build turns)                          (edit turns)
SPECIALIST WIDGET AGENTS                  SINGLE-PLANNER EDIT
(bff/dashboard/agents.ts, parallel)       (bff/dashboard/planner.ts)
   • kpi agent    → 3-6 KPI cards           minimal mutation of the
   • bar agent    → ranking charts          persisted currentSpec —
   • line agent   → temporal trends         a node-level edit is one
   • pie agent    → composition charts      surgical change, not five
   • table agent  → detail/grouped tables   parallel proposals
   • each agent has a DETERMINISTIC
     profile-derived fallback — a model
     outage degrades quality, never
     availability
   │
   ▼
MERGER  (bff/dashboard/merge.ts, deterministic)
   • dedupe by analytical signature (chart family counts: a bar and a donut
     over the same aggregate are ranking vs composition — both may live)
   • interleaved caps (never keeps 4 bars while dropping the only trend)
   • sections: Key metrics → Trends → Breakdowns → Details
   • vibrant style defaults
   │
   ▼
VALIDATE → COMPILE (SQL) → DETERMINISTIC RENDER   (unchanged: validate.ts,
compile.ts, sql.ts, renderer.ts — the model never writes SQL or JSX)
```

`bff/dashboard/handler.ts` orchestrates the above. The monolithic planner
remains as a **fallback** for builds (`DASHBOARD_AGENTS=0` kill-switch, or an
empty agent harvest), so the endpoint's contract only got stronger. The
response now includes `pipeline: "agents" | "planner"` for observability.

`src/pages/ChatPage.tsx` routes **all** dashboard builds through
`/api/dashboard/build`; legacy codegen survives strictly as an in-flight
fallback if the spec pipeline itself declines.

## Files

New: `bff/dashboard/enhance.ts`, `bff/dashboard/agents.ts`,
`bff/dashboard/merge.ts`, `bff/dashboard/agents.test.ts` (`npm run test:agents`,
also part of `npm test`).

Modified: `bff/dashboard/handler.ts` (rewired; brief helpers re-exported for
back-compat), `src/pages/ChatPage.tsx` (routing), `package.json` (new test
script; dangling refs removed).

Untouched: planner, validate, compile, sql, renderer, orchestrator, all
text2SQL modules, server routes, storage/Docker setup.

## Env knobs

- `DASHBOARD_AGENTS` (default `1`) — set `0` to force the monolithic planner.
- `DASHBOARD_AGENT_TIMEOUT_MS` (default `15000`) — per-agent timeout before its
  deterministic fallback is used.

## Verify

```
npm run typecheck        # clean
npm run test:agents      # the restored pipeline's own suite
npm test                 # full offline suite (82 groups) — green
npx vite build           # frontend builds
docker compose up --build, upload a CSV, prompt "sales dashboard"
  → BFF logs should show: [enhance] … · [agents] kpi:model(…) bar:model(…) …
    · [dashboard] pipeline: agents
```

## text2SQL integration — unchanged and ready

The join points all still work: the gate (`/api/gate`), source chat
(`/api/source/chat`), analyst directives (`analystDirective` still outranks the
brief and the rewriter inside the enhancement layer), and workbench/live
sources — which now share the exact same build path as uploads instead of a
private pilot path. Re-integrating deeper text2SQL features happens *behind*
`/api/dashboard/build`, so it can no longer strand the text2UI pipeline.

## ⚠ Security note

`.env` in the uploaded archive contains a real Gemini API key and a MySQL
connection string with credentials. Treat both as compromised (they left your
machine inside a zip): rotate the Gemini key and the `Aiuser_r_01` database
password, and keep `.env` out of future archives (`.gitignore` +
`.dockerignore` already exclude it from git/images, but not from manual zips).
