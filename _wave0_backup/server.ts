// server.ts — the BFF. Holds the AIFLOW key (via env), exposes POST /api/generate,
// and ties assemble() -> generateApp() together. No business logic beyond that.
//
// IMPORTANT: `import "dotenv/config"` must be FIRST so process.env is populated
// before aiflow.ts reads it at module load.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { assemble, assembleSummary, assemblePlan } from "./assembler";
import { callGemini, generateApp, generateAppStream, planApp, BUILD_OPTS, EDIT_OPTS, type GenOptions } from "./aiflow";
import { compileCss } from "./tailwind";
import { DuckDBStorage } from "./storage/duckdb";
import { PostgresStorage } from "./storage/postgres";
import { PROJECT_ID_RE, TABLE_NAME_RE, type StorageEngine, type DatasetUpload } from "./storage/types";
import type { AssembleInput, DataProfile, Dataset, GeneratedApp } from "../shared/types";
import { fileURLToPath } from "url";

// ---- storage (M1: embedded DuckDB; M2: Postgres adapter behind the same interface) ----
const STORAGE_KIND = (process.env.STORAGE ?? "duckdb").toLowerCase();
const STORAGE_PATH = process.env.STORAGE_PATH ?? "bff/data/text2ui.duckdb";
const QUERY_ROW_CAP = Number(process.env.QUERY_ROW_CAP ?? 10_000);
const QUERY_ROW_CAP_MAX = Number(process.env.QUERY_ROW_CAP_MAX ?? 200_000); // ceiling for explicit rowCap requests (project restore)
const QUERY_TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS ?? 15_000);
let _storage: StorageEngine | null = null;
export function getStorage(): StorageEngine {
  if (!_storage) {
    if (STORAGE_KIND === "postgres") {
      if (!process.env.PG_URL) {
        throw new Error("STORAGE=postgres requires PG_URL (e.g. postgres://user:pass@localhost:5432/text2ui)");
      }
      _storage = new PostgresStorage(process.env.PG_URL);
    } else if (STORAGE_KIND === "duckdb") {
      _storage = new DuckDBStorage(STORAGE_PATH);
    } else {
      throw new Error(`unknown STORAGE "${STORAGE_KIND}" (use "duckdb" or "postgres")`);
    }
  }
  return _storage;
}

type GenerateFn = typeof generateApp;

function isProfile(p: any): boolean {
  return !!p && typeof p === "object" && Array.isArray(p.columns);
}

/** Validate an untrusted request body into an AssembleInput. */
function validateInput(body: any): { ok: true; input: AssembleInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const { datasets, profile, userPrompt, currentCode, lastError, dataAccess } = body;
  if (dataAccess !== undefined && dataAccess !== "inline" && dataAccess !== "remote") {
    return { ok: false, error: 'dataAccess must be "inline" or "remote"' };
  }

  let ds: Dataset[];
  if (Array.isArray(datasets) && datasets.length) {
    for (const d of datasets) {
      if (!d || typeof d.tableName !== "string" || !d.tableName.trim() || !isProfile(d.profile)) {
        return { ok: false, error: "each dataset needs { tableName, profile.columns[] }" };
      }
    }
    ds = datasets;
  } else if (isProfile(profile)) {
    ds = [{ tableName: "data", profile }]; // back-compat: single profile -> table "data"
  } else {
    return { ok: false, error: "datasets[] (each with tableName + profile.columns[]) is required" };
  }

  if (typeof userPrompt !== "string") return { ok: false, error: "userPrompt must be a string" };
  if (!lastError && !userPrompt.trim()) return { ok: false, error: "userPrompt is required for a build/edit turn" };
  if (currentCode !== undefined && typeof currentCode !== "string") return { ok: false, error: "currentCode must be a string" };
  if (lastError !== undefined && typeof lastError !== "string") return { ok: false, error: "lastError must be a string" };
  return { ok: true, input: { datasets: ds, userPrompt, currentCode, lastError, dataAccess } };
}

/** Pure handler — generate fn is injectable so the route is testable without the network. */
export async function handleGenerate(
  body: unknown,
  generate: GenerateFn = generateApp,
  plan: (s: string, u: string) => Promise<string | null> = (s, u) => planApp(s, u),
): Promise<{ status: number; body: any }> {
  const v = validateInput(body);
  if (!v.ok) return { status: 400, body: { error: v.error } };

  // The model must speak the dialect of whatever engine will execute its SQL.
  // Server decides — never trusted from the client.
  if (v.input.dataAccess === "remote") v.input.sqlDialect = getStorage().dialect;
  // Phase 3: best-effort design plan on build turns (mutates v.input.plan).
  await runPlanForBuild(v.input, plan);
  const { system_prompt, user_prompt } = assemble(v.input);

  try {
    const app = await generate(system_prompt, user_prompt, undefined, optsForTurn(body));
    const withCss = await compileForBuild(v.input, app);
    return { status: 200, body: withCss };
  } catch (err: any) {
    const msg = err?.message ?? "unknown error";
    // A truncated payload surfaces as a parse failure here. Until we confirm the
    // workflow's max-output-tokens, surface it clearly rather than shipping a
    // broken app. CONTINUE-PASS SEAM: if the cap is low, retry/continue here.
    const looksTruncated = /not JSON|files\[\]|Unexpected end/.test(msg);
    const hint = looksTruncated
      ? " (output may have been truncated — check the workflow's max-output-tokens)"
      : "";
    return { status: 502, body: { error: `generation failed: ${msg}${hint}` } };
  }
}

/** Pure handler for POST /api/datasets — storage is injectable for tests. */
export async function handleDatasets(
  body: unknown,
  storage: StorageEngine = getStorage(),
): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  const { projectId, datasets } = b;
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    return { status: 400, body: { error: "projectId must match " + PROJECT_ID_RE.source } };
  }
  if (!Array.isArray(datasets)) return { status: 400, body: { error: "datasets[] is required" } };
  for (const d of datasets) {
    if (!d || typeof d.tableName !== "string" || !TABLE_NAME_RE.test(d.tableName)) {
      return { status: 400, body: { error: "each dataset needs a valid tableName" } };
    }
    if (typeof d.filename !== "string" || !Array.isArray(d.rows) || !d.profile) {
      return { status: 400, body: { error: "each dataset needs { tableName, filename, profile, rows[] }" } };
    }
  }
  try {
    const meta = await storage.replaceDatasets(projectId, datasets as DatasetUpload[]);
    return { status: 200, body: { datasets: meta } };
  } catch (err: any) {
    return { status: 500, body: { error: `storing datasets failed: ${err?.message ?? "unknown error"}` } };
  }
}

/** Pure handler for POST /api/query — read-only, row-capped, timed out. */
export async function handleQuery(
  body: unknown,
  storage: StorageEngine = getStorage(),
): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  const { projectId, sql, rowCap } = b;
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    return { status: 400, body: { error: "projectId must match " + PROJECT_ID_RE.source } };
  }
  if (typeof sql !== "string" || !sql.trim()) return { status: 400, body: { error: "sql is required" } };
  const cap = typeof rowCap === "number" && rowCap > 0 ? Math.min(Math.floor(rowCap), QUERY_ROW_CAP_MAX) : QUERY_ROW_CAP;
  try {
    const result = await storage.query(projectId, sql, { rowCap: cap, timeoutMs: QUERY_TIMEOUT_MS });
    return { status: 200, body: result };
  } catch (err: any) {
    // guard rejections and SQL errors are client errors, not server faults
    return { status: 400, body: { error: err?.message ?? "query failed" } };
  }
}


/** Pure handler for POST /api/summary — Feature Inspector summaries. */
export async function handleSummary(
  body: unknown,
  run: (s: string, u: string) => Promise<{ text: string; finishReason: string }> = callGemini,
): Promise<{ status: number; body: any }> {
  const b = body as any;
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
  const { projectId, tableName, profile, featureTitle, featureType, featureDetails, query } = b;
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    return { status: 400, body: { error: "projectId must match " + PROJECT_ID_RE.source } };
  }
  if (typeof tableName !== "string" || !tableName.trim()) {
    return { status: 400, body: { error: "tableName is required" } };
  }
  if (!profile || typeof profile !== "object" || typeof profile.rowCount !== "number" || !Array.isArray(profile.columns)) {
    return { status: 400, body: { error: "profile must be a valid DataProfile" } };
  }

  try {
    const { system_prompt, user_prompt } = assembleSummary(tableName, profile as DataProfile, {
      featureTitle,
      featureType,
      featureDetails,
      query,
    });
    const result = await run(system_prompt, user_prompt);
    return { status: 200, body: { summary: result.text.trim() } };
  } catch (err: any) {
    return { status: 500, body: { error: `summary generation failed: ${err?.message ?? "unknown error"}` } };
  }
}



/** Build turns get reasoning + warmth; edit/self-heal turns stay cold and fast. */
function optsForTurn(body: any): GenOptions {
  const isBuild = !body?.currentCode && !body?.lastError;
  return isBuild ? BUILD_OPTS : EDIT_OPTS;
}

/** A turn is a BUILD when there's no existing code and no error to fix. The
 *  Phase-3 plan pass runs on build turns only (edits/heals already have code). */
function isBuildTurn(input: AssembleInput): boolean {
  return !input.currentCode && !input.lastError;
}

/** Best-effort design-plan pass for a build turn. Returns the plan text (also
 *  mutates input.plan so the subsequent assemble() injects it), or null when
 *  skipped/failed. Never throws — a missing plan just means a planless build. */
async function runPlanForBuild(
  input: AssembleInput,
  plan: (s: string, u: string) => Promise<string | null> = (s, u) => planApp(s, u),
): Promise<string | null> {
  if (!isBuildTurn(input)) return null;
  const { system_prompt, user_prompt } = assemblePlan(input.datasets, input.userPrompt);
  const text = await plan(system_prompt, user_prompt);
  if (text) input.plan = text;
  return text;
}

/** Best-effort: compile Tailwind CSS for a freshly BUILT app and attach it to
 *  app.css, so the sandbox styles from compiled CSS instead of the racy CDN.
 *  Build turns only — edits/heals keep the build's CSS (most edits reuse its
 *  class vocabulary; recompiling every edit would add latency for little gain).
 *  On compile failure, app.css stays undefined and the sandbox uses the CDN. */
async function compileForBuild(
  input: AssembleInput,
  app: GeneratedApp,
  compile: (files: GeneratedApp["files"]) => Promise<string | null> = compileCss,
): Promise<GeneratedApp> {
  if (!isBuildTurn(input)) return app;
  const css = await compile(app.files);
  return css ? { ...app, css } : app;
}

/** Validate + prep for the streaming route. Returns the validated AssembleInput
 *  (dialect stamped) so the route can interleave the Phase-3 plan stage before
 *  assembling. Assembly itself happens after the plan, in the route. */
function prepareGenerate(body: unknown): { ok: true; input: AssembleInput } | { ok: false; error: string } {
  const v = validateInput(body);
  if (!v.ok) return { ok: false, error: v.error };
  if (v.input.dataAccess === "remote") v.input.sqlDialect = getStorage().dialect;
  return { ok: true, input: v.input };
}

/** M3 — project persistence handlers (storage injectable for tests). */
export async function handleUpsertProject(body: unknown, storage: StorageEngine = getStorage()) {
  const b = body as any;
  if (!b || typeof b.projectId !== "string" || !PROJECT_ID_RE.test(b.projectId)) {
    return { status: 400, body: { error: "projectId must match " + PROJECT_ID_RE.source } };
  }
  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120) {
    return { status: 400, body: { error: "name (1-120 chars) is required" } };
  }
  try {
    await storage.upsertProject(b.projectId, b.name.trim());
    return { status: 200, body: { ok: true } };
  } catch (err: any) {
    return { status: 500, body: { error: err?.message ?? "saving project failed" } };
  }
}

export async function handleSaveVersion(projectId: string, body: unknown, storage: StorageEngine = getStorage()) {
  if (!PROJECT_ID_RE.test(projectId)) return { status: 400, body: { error: "invalid projectId" } };
  const b = body as any;
  if (!b || typeof b.num !== "number" || b.num < 1 || typeof b.label !== "string" || !b.app?.files) {
    return { status: 400, body: { error: "version needs { num >= 1, label, app: GeneratedApp }" } };
  }
  try {
    await storage.saveVersion(projectId, { num: Math.floor(b.num), label: b.label, app: b.app });
    return { status: 200, body: { ok: true } };
  } catch (err: any) {
    return { status: 500, body: { error: err?.message ?? "saving version failed" } };
  }
}

// ---- HTTP wiring ----
function requireEnv() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing env var GEMINI_API_KEY. Put it in a server-side .env (gitignored).");
  }
}

export function createServer() {
  const app = express();
  app.use(cors()); // TODO: restrict origin for production
  app.use(express.json({ limit: process.env.BODY_LIMIT ?? "64mb" })); // dataset rows travel once at upload

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/generate", async (req, res) => {
    const { status, body } = await handleGenerate(req.body);
    res.status(status).json(body);
  });

  // Streaming generate: Server-Sent Events. Every event the client renders
  // corresponds to a real pipeline moment (model call, code chunks, continuation,
  // validation) — no simulated progress.
  app.post("/api/generate/stream", async (req, res) => {
    const prep = prepareGenerate(req.body);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const send = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (!prep.ok) {
      send({ type: "error", error: prep.error });
      return res.end();
    }
    try {
      // Phase 3: design-plan pass on build turns, surfaced in the journey. The
      // "planning" stage shows first; if a plan comes back, its text streams as
      // a plan event so the user sees the blueprint. Best-effort — on skip/fail
      // the build proceeds with no plan and no stall.
      if (isBuildTurn(prep.input)) {
        send({ type: "stage", stage: "planning" });
        const planText = await runPlanForBuild(prep.input);
        if (planText) send({ type: "plan", text: planText });
      }
      const { system_prompt, user_prompt } = assemble(prep.input);
      const app_ = await generateAppStream(system_prompt, user_prompt, send, undefined, optsForTurn(req.body));
      // Build turns: compile Tailwind from the finished source (kills the CDN
      // render race). Best-effort — on failure app_.css stays undefined and the
      // sandbox falls back to the CDN.
      let finalApp = app_;
      if (isBuildTurn(prep.input)) {
        send({ type: "stage", stage: "styling" });
        finalApp = await compileForBuild(prep.input, app_);
      }
      send({ type: "done", app: finalApp });
    } catch (err: any) {
      send({ type: "error", error: err?.message ?? "generation failed" });
    }
    res.end();
  });

  app.post("/api/datasets", async (req, res) => {
    const { status, body } = await handleDatasets(req.body);
    res.status(status).json(body);
  });

  app.get("/api/datasets/:projectId", async (req, res) => {
    const projectId = String(req.params.projectId);
    if (!PROJECT_ID_RE.test(projectId)) return res.status(400).json({ error: "invalid projectId" });
    try {
      res.json({ datasets: await getStorage().listDatasets(projectId) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "listing failed" });
    }
  });

  app.post("/api/query", async (req, res) => {
    const { status, body } = await handleQuery(req.body);
    res.status(status).json(body);
  });

  app.post("/api/summary", async (req, res) => {
    const { status, body } = await handleSummary(req.body);
    res.status(status).json(body);
  });

  // ---- M3: projects ----
  app.get("/api/projects", async (_req, res) => {
    try {
      res.json({ projects: await getStorage().listProjects() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "listing projects failed" });
    }
  });

  app.get("/api/projects/:projectId", async (req, res) => {
    const projectId = String(req.params.projectId);
    if (!PROJECT_ID_RE.test(projectId)) return res.status(400).json({ error: "invalid projectId" });
    try {
      const found = await getStorage().getProject(projectId);
      if (!found) return res.status(404).json({ error: "project not found" });
      res.json(found);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "loading project failed" });
    }
  });

  app.post("/api/projects", async (req, res) => {
    const { status, body } = await handleUpsertProject(req.body);
    res.status(status).json(body);
  });

  app.post("/api/projects/:projectId/versions", async (req, res) => {
    const { status, body } = await handleSaveVersion(String(req.params.projectId), req.body);
    res.status(status).json(body);
  });

  app.delete("/api/projects/:projectId", async (req, res) => {
    const projectId = String(req.params.projectId);
    if (!PROJECT_ID_RE.test(projectId)) return res.status(400).json({ error: "invalid projectId" });
    try {
      await getStorage().deleteProject(projectId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "deleting project failed" });
    }
  });

  return app;
}

// Start only when this file is the entry module (so tests can import it freely).
const isDirectRun =
  process.env.START_BFF === "1" ||
  (!!process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url));
if (isDirectRun) {
  requireEnv();
  const port = Number(process.env.PORT ?? 8787);
  createServer().listen(port, () => console.log(`BFF listening on http://localhost:${port}`));
}