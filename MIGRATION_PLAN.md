# MIGRATION_PLAN.md — text2UI → the flow platform (hybrid, per MIGRATION_ASSESSMENT.md)

*The pipeline is published INTO the platform as three composite tools plus a
routing flow. Correctness-critical logic stays in code; the flow routes and
carries state. This document is the step-by-step; the façade code lives in
`bff/tools.ts` (suite: `npm run test:tools`).*

## 0. Prerequisites (once)

1. Set `T2UI_TOOLS_API_KEY=<long random string>` in `.env`. Unset = the façade
   is open (dev only); the BFF warns once at startup.
2. The BFF must be reachable from the platform (same host or an internal URL).
3. Restart the BFF; confirm the startup line
   `[tools] façade mounted (v1.0.0) — OpenAPI at /tools/openapi.json` and that
   `GET /tools/openapi.json` returns the document.

## 1. Register the three tools (platform: custom tool from OpenAPI)

In the platform's tool creator, import from URL:
`http://<bff-host>:8787/tools/openapi.json`
Auth type: **API Key, header `x-api-key`**, value = `T2UI_TOOLS_API_KEY`.
This yields three tools in one import:

| Tool (operationId) | Does | In | Out |
|---|---|---|---|
| `datasource` | register a DB connection + profile it | connectionString \| parts, mode ("live" = store nothing) | connectionId, datasets, `projectId` when live |
| `text2sql` | guarded data question | projectId, question | answer, sql, rows, columns |
| `text2ui` | build/edit a dashboard | prompt + (projectId \| datasets); currentSpec for edits | spec, app (renderable file map), warnings, summary |

Smoke each tool from the platform's test panel before building flows:
- datasource with a test connection string + `"mode":"live"` → expect a
  `live_…` projectId.
- text2sql: that projectId + "how many rows are in <table>?" → expect answer + SQL.
- text2ui: that projectId + "build an overview dashboard" → expect spec + app
  + a warnings array (possibly empty).

## 2. State in the flow world (the one simplification)

The tools are stateless by contract — **spec-in/spec-out**:

- The flow keeps a conversation variable `currentSpec` (object) and, if undo
  is wanted, `specStack` (array).
- Build turn: call text2ui WITHOUT currentSpec → save response.spec into
  `currentSpec`, push onto `specStack`.
- Edit turn: call text2ui WITH `currentSpec` → on success (and
  `noChange=false`), push the returned spec.
- Undo: pop `specStack`, set `currentSpec` to the new top. That is the whole
  undo implementation — no server session involved. (`tools.test.ts` pins
  that an edit works with nothing but the previous response's spec.)

## 3. The orchestration flow (replaces `orchestrator.ts` routing — the piece
     that genuinely belongs in the flow layer)

Nodes:

1. **Start**: inputs `message` (string), plus conversation vars `projectId`,
   `currentSpec`, `specStack`, `history`.
2. **LLM router** (JSON mode). System prompt:
   > You route a data-analytics chat. Given the user message and whether a
   > dashboard already exists (currentSpec present), output ONLY
   > `{"route": "connect" | "data_question" | "build" | "edit" | "respond"}`.
   > "connect" when the message contains a connection string or asks to hook
   > up a database. "data_question" for questions answerable with a number or
   > a table. "build" to create a dashboard when none exists (or a new one is
   > explicitly asked for). "edit" when a dashboard exists and the message
   > changes it (including "undo"). Otherwise "respond".
3. **Condition** on `route`:
   - `connect` → **datasource tool** (pass the message's connection string;
     default `mode` per your ops posture) → save `projectId` → answer node
     summarizing tables + warnings.
   - `data_question` → **text2sql tool** (projectId + message) → answer node
     rendering `answer` (+ `sql` in a collapsible if your platform supports it).
   - `build` → **text2ui tool** (projectId + message) → save spec (per §2) →
     answer node rendering `summary` + `warnings`.
   - `edit` → IF the message is undo-like, do the §2 stack pop in a code node
     (this is list manipulation, fine for a code node — it is not pipeline
     logic); ELSE **text2ui tool** with `currentSpec` (+ last N `history`
     turns) → save spec → answer with `summary` + `warnings`.
   - `respond` → plain LLM node, with the datasets' table/column names as
     context variables.
4. **Answer** nodes: ALWAYS surface `warnings` verbatim — the honesty channel
   ("degradation is said out loud") must survive the migration.

Publish this flow, then wrap it as the **final pipeline** app (chat entry →
this flow). If the platform supports publishing flows as tools, the routing
flow itself becomes reusable by other team flows.

## 4. What deliberately does NOT migrate (and why — short form)

enhance/decompose/agents/merge/validate/compile/render internals, patch ops +
reconcile, all SQL construction and guards, profiling/enrichment, the FK
prover, the query bridge. They stay inside the tools because the three
mechanisms that keep numbers honest — three-surface symmetry contracts, the
closed-grammar compiler + sanitizer, executed-number goldens — have no
platform equivalent. Full argument: `MIGRATION_ASSESSMENT.md`.

Also migratable as-is, when wanted: the markitdown sidecar (already an
isolated HTTP service — register its endpoint the same way) and, as easy
next tools, the PDF report / PPT deck generators.

## 5. The cutover gate: replay parity (Phase D harness)

Before routing real users through the flow:

1. On the CURRENT app, set `T2UI_REPLAY_CAPTURE=1`, restart, and use the
   product normally for a day → `.t2ui/replay.jsonl` accumulates real turns.
2. Baseline check (no flow involved): replay them in-process —
   `loadReplayTurns()` → `replayTurn()` each — all diffs must be empty.
3. Flow parity: for each recorded turn, POST its recorded `body` fields at
   the platform-invoked text2ui tool (build turns: prompt+datasets; edit
   turns: +currentSpec) and diff the returned spec against the recorded one
   with `diffSpecs` from `bff/dashboard/harness.ts`. Model nondeterminism
   makes some diffs expected here — the gate is: no diff may be a GUARD
   difference (a widget dropped/repaired on one side only) or a NUMBER
   difference (metric identity changed). Layout/color/wording diffs are
   reviewable noise.
4. Cut over the entry point only when §3's flow passes §5.3 on the recorded
   set and the team has eyeballed the diff report.

## 6. Rollback

The façade is additive: the existing app and routes are untouched. Rollback =
point the chat entry back at the app. Nothing in the migration deletes or
rewires the current product.
