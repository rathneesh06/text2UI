# markitdown-service/main.py
# Isolated sidecar: converts uploaded documents (PDF/Word/PPT/...) to Markdown for
# use as LLM CONTEXT only. Runs as a SEPARATE process from the Node BFF because
# markitdown is Python and performs I/O with the caller's privileges — so we
# whitelist extensions, cap size, and never wire secrets in here. The BFF is the
# only client. Data files (csv/xlsx/json) are intentionally NOT handled here;
# they go through the BFF's own ingest path so they stay queryable in DuckDB.

from io import BytesIO
import os

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from markitdown import MarkItDown

MAX_BYTES = int(os.environ.get("MID_MAX_BYTES", str(25 * 1024 * 1024)))  # 25 MB hard cap
MAX_CHARS = int(os.environ.get("MID_MAX_CHARS", str(50_000)))            # prompt-budget guard

# Document inputs accepted as context. (No csv/xlsx/json here — see note above.)
ALLOWED_EXT = {
    ".pdf", ".docx", ".doc", ".pptx", ".ppt",
    ".html", ".htm", ".rtf", ".epub", ".txt", ".md",
}

app = FastAPI(title="text2UI markitdown sidecar", version="1.0.0")
_md = MarkItDown()  # no LLM client: no image captioning => cheap, offline, deterministic


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/convert")
async def convert(file: UploadFile = File(...)):
    name = file.filename or "upload"
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if ext not in ALLOWED_EXT:
        raise HTTPException(status_code=415, detail=f"unsupported extension: {ext or '(none)'}")

    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"file exceeds {MAX_BYTES} bytes")

    try:
        result = _md.convert_stream(BytesIO(data), file_extension=ext)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"conversion failed: {type(e).__name__}")

    text = (result.text_content or "").strip()
    truncated = len(text) > MAX_CHARS
    if truncated:
        text = text[:MAX_CHARS]

    return JSONResponse({
        "markdown": text,
        "chars": len(text),
        "truncated": truncated,
        "filename": name,
    })
