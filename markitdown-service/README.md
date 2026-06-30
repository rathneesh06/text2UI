# markitdown sidecar (Wave 0 / N2a)

A tiny, isolated Python service that converts uploaded **documents** (PDF / Word /
PowerPoint / HTML / …) into **Markdown** for use as LLM **context** in text2UI.

It runs as a **separate process** from the Node BFF on purpose: markitdown is
Python, and it performs I/O with the calling process's privileges, so we keep it
isolated, whitelist extensions, and cap input size. The BFF (`bff/markitdown.ts`)
is the only client; it forwards uploaded bytes here and injects the returned
Markdown into BUILD-turn prompts.

> Data files (CSV / XLSX / JSON) are **not** handled here. They keep flowing
> through the BFF's own ingest path so they stay queryable in DuckDB.

## Run (Windows)

```powershell
cd markitdown-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8001
```

## Run (macOS / Linux)

```bash
cd markitdown-service
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8001
```

## Endpoints

- `GET /health` → `{ "ok": true }`
- `POST /convert` (multipart form, field `file`) →
  `{ "markdown": "...", "chars": 252, "truncated": false, "filename": "brief.docx" }`

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `MID_MAX_BYTES` | `26214400` (25 MB) | Reject uploads larger than this |
| `MID_MAX_CHARS` | `50000` | Truncate returned Markdown (prompt-budget guard) |

The BFF side is configured by `MARKITDOWN_URL` (default `http://127.0.0.1:8001`)
and `MARKITDOWN_TIMEOUT_MS` (default `20000`) in the main `.env`.

## Notes

- If the sidecar is **not running**, document upload simply degrades to "no
  document context" — the core build is unaffected (the BFF returns `503` with
  `optional: true`, and `convertToMarkdown` returns `null`).
- No LLM client is wired in, so there is **no image captioning** and **no
  secrets** in this service. It is cheap, offline, and deterministic.
