# Deploy & Run (Wave 5 / P8)

text2UI runs as three containers: **db** (Postgres), **bff** (the API, runs TypeScript
directly via `tsx`), and **web** (the built frontend). Not yet wired to a specific host —
this is "prod-ready in code".

## Quick start

```bash
cp .env.example .env          # then set GEMINI_API_KEY (required)
docker compose up --build
# frontend: http://localhost:4173   BFF: http://localhost:8787   /health for liveness
```

The BFF runs with `NODE_ENV=production`, so it **fails fast** if `GEMINI_API_KEY` is missing
and **warns** if CORS (`ALLOWED_ORIGINS`) or auth (`AUTH_TOKENS`) are left open.

## Configuration (env)

See `.env.example` for the full list. The security/limits knobs added in Wave 5:

| Var | Purpose |
|-----|---------|
| `ALLOWED_ORIGINS` | CORS allowlist (comma-separated). Empty = open. |
| `AUTH_TOKENS` | `tenantA:tokenA,tenantB:tokenB` — bearer-token-per-tenant. Empty = auth off. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | per-tenant request rate (0 = off). |
| `QUOTA_MAX_TOKENS` / `QUOTA_MAX_COST_USD` / `QUOTA_WINDOW_MS` | per-tenant usage quota (0 = off). |
| `STORAGE` / `PG_URL` | `postgres` + connection string (Postgres is required for the future Design Retrieval track). |

Frontend sends its tenant token via `VITE_AUTH_TOKEN` (build-time); `VITE_BFF_URL` is baked at
build (a Docker build ARG).

## Production checklist

- [ ] Rotate the Gemini key; provide it only via `.env` / secrets (never commit `.env`).
- [ ] Set `ALLOWED_ORIGINS` to your real frontend origin(s).
- [ ] Set `AUTH_TOKENS` (and the matching `VITE_AUTH_TOKEN` on the frontend build).
- [ ] Set `RATE_LIMIT_MAX` and the `QUOTA_*` caps per your budget.
- [ ] If you have pre-tenancy data, run the migration once: `npm run migrate:tenant`.
- [ ] Run the real isolation test against your DB: `PG_URL=... npm run test:storage:live`.

## CI

`.github/workflows/ci.yml` runs on every push/PR: `typecheck` → the 18-suite gate (`npm run test`)
→ the real DuckDB+Postgres tenant-isolation test (`test:storage:live`). A commented `eval-live`
job shows how to wire the live LLM eval (`test:eval:live`) behind a `GEMINI_API_KEY` secret — use
it to gate quality regressions before scaling knowledge (exemplars, domains, Design Retrieval corpus).

## Later optimizations (not blocking)

- Slimmer prod image: compile the BFF to JS and `npm prune --omit=dev`; serve the frontend `dist/`
  via nginx instead of `vite preview`.
- Hard tenant isolation: per-tenant DB roles/databases (today's isolation is app-level — see the
  tenant-scope adapter notes).
- Structured logging/metrics export (the P6 `[metrics]` line is the current signal).
