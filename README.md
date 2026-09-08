# text2UI (Phase-1 prototype)

Prompt + your data (CSV / Excel / JSON) → a live React app you refine by chatting.

Pipeline: **ingest** (browser: parse + profile) → **assemble** (server BFF: builds the
prompts; holds the Gemini key + system prompt) → **Gemini** (raw `App.tsx` framed by
`//__SUMMARY__` … `//__END__`, with continuation-stitching) → **render** (Sandpack
sandbox + DuckDB-WASM data layer, one SQL table per uploaded file) → **iterate /
self-heal**.

> Status: working prototype. Simulated full-stack — the generated app and the data
> layer run entirely in the browser. The data-access seam (`./data`'s `query(sql)`)
> is deliberately swappable for a real backend. See the handoff doc for the roadmap.

## Run it

```bash
npm install
npm run dev:bff   # Express BFF on :8787 (restart after any bff/ change)
npm run dev       # Vite UI on :5173
```

Server-side `.env` (gitignored — never commit, never bundle):

```
GEMINI_API_KEY=...                 # required
GEMINI_MODEL=gemini-flash-latest   # optional
GEMINI_MAX_OUTPUT_TOKENS=8192      # optional
```

Browser-side: `VITE_BFF_URL` (defaults to `http://localhost:8787`), and
`VITE_REMOTE_DATA=1` to switch the sandbox's data layer from in-browser
(DuckDB-WASM, rows inlined) to server-side (BFF DuckDB via `/api/query`).

Server-side storage (remote-data mode): `STORAGE_PATH` (default
`bff/data/text2ui.duckdb`, gitignored), `QUERY_ROW_CAP` (default 10000),
`QUERY_TIMEOUT_MS` (default 15000), `BODY_LIMIT` (default 64mb).

## Checks

```bash
npm run typecheck      # tsc --noEmit
npm run test:ingest    # file parsing + profiling
npm run test:sandbox   # sandpack config assembly (multi-table + remote mode)
npm run test:storage   # SQL read-only guard + DuckDB storage engine
npm run build          # vite production build
```

## Layout

```
shared/   types that cross the wire (only)
bff/      SERVER ONLY — Gemini key + system prompt live here, never in the browser
  aiflow.ts     Gemini client: retry/backoff, finishReason, stitch loop, corrupt-stitch guard
  assembler.ts  build/edit/self-heal prompts; inline + remote runtime contracts
  server.ts     POST /api/generate /api/datasets /api/query, GET /api/datasets/:id, /health
  storage/      StorageEngine seam: read-only SQL guard + DuckDB impl (Postgres adapter = M2)
src/      BROWSER ONLY
  App.tsx              two-phase builder UI (hero → chat rail + stage)
  components/Sandbox.tsx  Sandpack mount; sandpack.error → onRuntimeError (auto-fix)
  lib/ingest.ts        CSV/XLSX/JSON → { profile, rows }, values coerced to inferred types
  lib/data.ts          emits /data.js (DuckDB-WASM engine) + /rows.js (tables map)
  lib/sandbox.ts       buildSandpackConfig(app, tables[]) — pure, tested
```

Filenames are exact and case-sensitive on purpose — Windows will forgive
`app.tsx` vs `App.tsx`; Linux and CI will not.
# Kivi_by_Sarvam
