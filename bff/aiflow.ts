// aiflow.ts — server-side LLM client (Google Gemini). Key lives here, never in the browser.
// The model returns raw App.tsx source, finished with a //__END__ marker.
// A continuation/stitch loop covers cases where output exceeds maxOutputTokens.
// (Filename kept for import stability; provider is now Gemini, not the company AIFLOW.)
import type { GeneratedApp } from "../shared/types";
import { recordCall, type TokenUsage, ZERO_USAGE } from "./metrics";

const API_KEY = process.env.GEMINI_API_KEY!;
const MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 8192);
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const MAX_CONTINUATIONS = 4; // stitch budget before we give up

export interface GenResult { text: string; finishReason: string; usage?: TokenUsage; }

/** An image to attach to a multimodal Gemini call (base64 PNG/JPEG). */
export interface ImagePart { mimeType: string; dataB64: string; }

/** Build the user-turn parts: the text first, then any images as inlineData.
 *  Text-only callers get exactly [{text}] (unchanged behavior). */
export function buildUserParts(userPrompt: string, images: ImagePart[] = []): any[] {
  const parts: any[] = [{ text: userPrompt }];
  for (const im of images) parts.push({ inlineData: { mimeType: im.mimeType, data: im.dataB64 } });
  return parts;
}

/** Per-call generation tuning. Build turns get reasoning + warmth (design quality);
 *  edits/self-heals stay cold and fast; continuations always run thinking-free
 *  (a "thinking" continuation re-plans and restarts the file — corrupt stitches). */
export interface GenOptions { temperature?: number; thinkingBudget?: number; responseMimeType?: string; responseSchema?: unknown; }
const DEFAULT_THINKING = Number(process.env.GEMINI_THINKING_BUDGET ?? 1024);
export const BUILD_OPTS: GenOptions = { temperature: 0.22, thinkingBudget: DEFAULT_THINKING };
export const EDIT_OPTS: GenOptions = { temperature: 0.2, thinkingBudget: 0 };
// Phase 3 plan pass: cheap + fast. Thinking-off, low temp, small ceiling — this
// runs before every build, so it must never dominate latency.
export const PLAN_OPTS: GenOptions = { temperature: 0.3, thinkingBudget: 0 };
// Orchestrator: structured JSON brief. Thinking-off, slightly warmer for design.
export const ORCHESTRATE_OPTS: GenOptions = { temperature: 0.2, thinkingBudget: 0, responseMimeType: "application/json" };

function generationConfig(opts: GenOptions) {
  const thinking = opts.thinkingBudget ?? 0;
  const cfg: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.2,
    // thinking tokens count against maxOutputTokens on flash-class models —
    // grow the budget so reasoning never starves the actual code output.
    maxOutputTokens: MAX_OUTPUT_TOKENS + thinking,
    thinkingConfig: { thinkingBudget: thinking },
  };
  if (opts.responseMimeType) cfg.responseMimeType = opts.responseMimeType;
  if (opts.responseSchema) cfg.responseSchema = opts.responseSchema;
  return cfg;
}

/** Pull generated text + finishReason out of a Gemini generateContent response. */
export function extractResult(json: any): GenResult {
  const block = json?.promptFeedback?.blockReason;
  if (block) throw new Error(`Gemini blocked the prompt: ${block}`);
  const cand = json?.candidates?.[0];
  if (!cand) throw new Error("Gemini returned no candidates");
  const text = (cand.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
  const finishReason = cand.finishReason ?? "";
  if (!text) throw new Error(`Gemini returned empty text (finishReason=${finishReason || "unknown"})`);
  return { text, finishReason, usage: parseUsage(json) };
}

/** Pull token usage out of a Gemini response. Thinking tokens are billed as output. */
export function parseUsage(json: any): TokenUsage {
  const u = json?.usageMetadata ?? {};
  const inputTokens = Number(u.promptTokenCount ?? 0);
  const outputTokens = Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0);
  const totalTokens = Number(u.totalTokenCount ?? inputTokens + outputTokens);
  return { inputTokens, outputTokens, totalTokens };
}

const END_MARKER = "//__END__";

/** Strip leading/trailing markdown fences if the model added them despite instructions. */
function stripFences(s: string): string {
  return s.trim().replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

/** Done when Gemini reports a natural stop, or the file ends with the marker.
 *  Using finishReason avoids false "incomplete" when the model omits the marker. */
function isDone(raw: string, finishReason: string): boolean {
  return finishReason === "STOP" || raw.includes(END_MARKER);
}

/** Turn the (possibly stitched) raw output into a GeneratedApp (single App.tsx). */
export function toApp(raw: string): GeneratedApp {
  let code = stripFences(raw);
  const end = code.indexOf(END_MARKER);
  if (end !== -1) code = code.slice(0, end);
  code = code.trim();
  // Back-compat: if the model still wrapped it in the old {"files":[...]} JSON, unwrap it.
  if (/^\{\s*"files"\s*:/.test(code)) {
    try {
      const obj = JSON.parse(code);
      if (Array.isArray(obj.files) && typeof obj.files[0]?.content === "string") {
        return { files: obj.files, summary: obj.summary };
      }
    } catch { /* not valid JSON — fall through and treat as raw code */ }
  }
  // Pull the optional leading //__SUMMARY__ line, then drop it from the code.
  // It's just a comment, so leaving it would be harmless — but we extract it for the UI.
  let summary: string | undefined;
  const sm = code.match(/^[ \t]*\/\/__SUMMARY__[ \t]*(.*)$/m);
  if (sm) {
    summary = sm[1].trim() || undefined;
    code = code.replace(sm[0], "").replace(/^\s*\n/, "").trim();
  }
  if (!code) throw new Error("model returned no code");
  // Corrupt-stitch guard: a clean resume yields ONE component + one default export.
  // Duplicates mean the model restarted mid-file instead of continuing — almost always
  // because the app overflowed the output cap. Fail clearly instead of shipping garbage.
  const appDefs = (code.match(/\b(?:const|function)\s+App\b/g) || []).length;
  const defaultExports = (code.match(/\bexport\s+default\b/g) || []).length;
  if (appDefs > 1 || defaultExports > 1) {
    throw new Error(
      "stitched output is inconsistent (the model restarted mid-file instead of resuming) — " +
      "the app is likely too large for the workflow's output limit. Reduce the app's scope, or raise max-output-tokens.",
    );
  }
  return { files: [{ path: "App.tsx", content: code }], summary };
}

const MAX_RETRIES = 3; // transient 429/500/503 from Gemini
const RETRY_STATUSES = new Set([429, 500, 503]);
const RATE_CAP_MS = 15000; // longest we'll auto-wait before surfacing a 429 to the user
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gemini 429 bodies carry a RetryInfo { retryDelay: "37s" } in error.details. */
function parseRetryDelayMs(bodyText: string): number | null {
  try {
    const details = JSON.parse(bodyText)?.error?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const m = typeof d?.retryDelay === "string" && /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay.trim());
        if (m) return Math.round(parseFloat(m[1]) * 1000);
      }
    }
  } catch { /* non-JSON body */ }
  return null;
}

/** A human, actionable message for an exhausted quota. */
function rateLimitMessage(bodyText: string): string {
  const delay = parseRetryDelayMs(bodyText);
  const when = delay != null ? ` Gemini suggests retrying in ~${Math.ceil(delay / 1000)}s.` : "";
  return `Gemini rate limit (HTTP 429): you've hit your API quota. The free tier has low per-minute and per-day limits.${when} Wait and retry, or enable billing in Google AI Studio to raise the limits.`;
}

/** One call to Gemini generateContent, with backoff retries on transient errors. */
export async function callGemini(systemPrompt: string, userPrompt: string, opts: GenOptions = {}, images: ImagePart[] = []): Promise<GenResult> {
  const t0 = Date.now();
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: buildUserParts(userPrompt, images) }],
    generationConfig: generationConfig(opts),
  });

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
        body,
      });
    } catch (netErr) {
      if (attempt < MAX_RETRIES) {
        const wait = 500 * 2 ** attempt + Math.random() * 250;
        console.warn(`[gemini] network error, retrying in ${Math.round(wait)}ms (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }
      throw new Error(`Gemini request failed: ${(netErr as Error).message}`);
    }

    if (res.ok) {
      const result = extractResult(await res.json());
      recordCall({ model: MODEL, usage: result.usage ?? ZERO_USAGE, ms: Date.now() - t0 });
      return result;
    }

    const text = await res.text().catch(() => "");
    if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      // On 429, prefer Gemini's own suggested delay. If it's longer than our cap,
      // the quota won't reset soon — don't hang; fall through and surface it now.
      const suggested = res.status === 429 ? parseRetryDelayMs(text) : null;
      if (suggested == null || suggested <= RATE_CAP_MS) {
        const wait = Math.min(suggested ?? 500 * 2 ** attempt + Math.random() * 250, RATE_CAP_MS);
        console.warn(`[gemini] HTTP ${res.status} (transient), retrying in ${Math.round(wait)}ms (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }
    }
    if (res.status === 429) throw new Error(rateLimitMessage(text));
    throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

const CONTINUATION_TAIL = 4000; // chars of context resent — bounded to keep the call small

/** Ask the model to resume cut-off RAW code from exactly where it stopped. */
function continuationPrompt(partial: string): string {
  const tail = partial.length > CONTINUATION_TAIL ? partial.slice(-CONTINUATION_TAIL) : partial;
  return [
    "Your previous response (the raw App.tsx source) was cut off before it finished.",
    "Below is the TAIL END of the code you produced. Continue the code from EXACTLY where it stops — your next character immediately follows the last character below.",
    "Output ONLY the continuation of the code. Do NOT repeat earlier code, and do NOT add prose or markdown fences.",
    "When the file is complete, end with this exact marker on its own line: " + END_MARKER,
    "",
    "--- TAIL OF YOUR CODE (do not repeat) ---",
    tail,
    "--- CONTINUE AFTER THE LAST CHARACTER ABOVE ---",
  ].join("\n");
}

/**
 * Generate an app as raw code, stitching continuations until Gemini reports a natural
 * stop (finishReason STOP) or the //__END__ marker appears, or attempts run out.
 * `run` is injectable for testing without the network.
 */
export async function generateApp(
  systemPrompt: string,
  userPrompt: string,
  run: (s: string, u: string, o?: GenOptions, images?: ImagePart[]) => Promise<GenResult> = callGemini,
  opts: GenOptions = EDIT_OPTS,
  images: ImagePart[] = [],
): Promise<GeneratedApp> {
  // Images (retrieved design references) go on the FIRST call only; continuations
  // just finish truncated code and don't need the visual context re-sent.
  let { text: raw, finishReason } = await run(systemPrompt, userPrompt, opts, images);

  for (let i = 0; i < MAX_CONTINUATIONS && !isDone(raw, finishReason); i++) {
    console.warn(`[gemini] response not finished (finishReason=${finishReason || "none"}), requesting continuation ${i + 1}/${MAX_CONTINUATIONS}`);
    const more = await run(systemPrompt, continuationPrompt(raw), { ...opts, thinkingBudget: 0 });
    if (!more.text) break; // nothing further; use what we have
    raw += more.text;
    finishReason = more.finishReason;
  }
  return toApp(raw); // uses whatever code we have; strips the marker if present
}

/* ==== Design-plan pass (Phase 3) ============================================
   A cheap pre-build call that produces a short layout plan, injected into the
   build prompt. BEST-EFFORT BY CONTRACT: any failure (error, empty, or timeout)
   resolves to null and the build proceeds planless — the plan must never block
   or break a build. `run` is injectable for testing without the network. */

const PLAN_TIMEOUT_MS = Number(process.env.GEMINI_PLAN_TIMEOUT_MS ?? 12000);

/** Resolve to the plan text, or null if it errored/timed out/was empty. Never throws. */
export async function planApp(
  systemPrompt: string,
  userPrompt: string,
  run: (s: string, u: string, o?: GenOptions) => Promise<GenResult> = callGemini,
  timeoutMs: number = PLAN_TIMEOUT_MS,
): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async () => {
    try {
      const { text } = await run(systemPrompt, userPrompt, PLAN_OPTS);
      const plan = stripFences(text).trim();
      return plan || null;
    } catch (err) {
      console.warn(`[gemini] plan pass failed, building without a plan: ${(err as Error).message}`);
      return null;
    }
  })();
  return Promise.race([call, timeout]);
}

/* ==== Streaming (the live journey) ==========================================
   Same pipeline as generateApp — same retries, continuation/stitch loop, and
   corrupt-stitch guard — but text arrives incrementally via Gemini's
   streamGenerateContent SSE endpoint, and progress is reported through events:
     { type: "stage",        stage, detail? }   pipeline stage transitions
     { type: "chunk",        text }             raw code delta as the model writes
     { type: "progress",     chars }            cumulative size so far
   The caller (the BFF's SSE route) forwards these to the browser. */

const STREAM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;

export type GenEvent =
  | { type: "stage"; stage: "planning" | "model_call" | "continuation" | "validating" | "styling"; detail?: string }
  | { type: "chunk"; text: string }
  | { type: "progress"; chars: number };

export type StreamRunner = (s: string, u: string, onText: (delta: string) => void, o?: GenOptions, images?: ImagePart[]) => Promise<GenResult>;

/** Parse one Gemini SSE payload line's JSON into { delta, finishReason }. */
export function extractStreamPiece(json: any): { delta: string; finishReason: string } {
  const block = json?.promptFeedback?.blockReason;
  if (block) throw new Error(`Gemini blocked the prompt: ${block}`);
  const cand = json?.candidates?.[0];
  const delta = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
  return { delta, finishReason: cand?.finishReason ?? "" };
}

/** One streaming call to Gemini, retrying transient errors only BEFORE any text
 *  has arrived (a mid-stream retry would duplicate output). */
export async function callGeminiStream(
  systemPrompt: string,
  userPrompt: string,
  onText: (delta: string) => void,
  opts: GenOptions = {},
  images: ImagePart[] = [],
): Promise<GenResult> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: buildUserParts(userPrompt, images) }],
    generationConfig: generationConfig(opts),
  });

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(STREAM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
        body,
      });
    } catch (netErr) {
      if (attempt < MAX_RETRIES) {
        const wait = 500 * 2 ** attempt + Math.random() * 250;
        await sleep(wait);
        continue;
      }
      throw new Error(`Gemini request failed: ${(netErr as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
        const suggested = res.status === 429 ? parseRetryDelayMs(text) : null;
        if (suggested == null || suggested <= RATE_CAP_MS) {
          await sleep(Math.min(suggested ?? 500 * 2 ** attempt + Math.random() * 250, RATE_CAP_MS));
          continue;
        }
      }
      if (res.status === 429) throw new Error(rateLimitMessage(text));
      throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.body) throw new Error("Gemini stream had no body");

    // SSE frames: lines beginning "data: {json}", events separated by blank lines.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let finishReason = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }
        const piece = extractStreamPiece(json);
        if (piece.delta) { text += piece.delta; onText(piece.delta); }
        if (piece.finishReason) finishReason = piece.finishReason;
      }
    }
    if (!text) throw new Error(`Gemini stream returned empty text (finishReason=${finishReason || "unknown"})`);
    return { text, finishReason };
  }
}

/** Streaming twin of generateApp: identical stitch loop, evented progress. */
export async function generateAppStream(
  systemPrompt: string,
  userPrompt: string,
  onEvent: (ev: GenEvent) => void,
  runStream: StreamRunner = callGeminiStream,
  opts: GenOptions = EDIT_OPTS,
  images: ImagePart[] = [],
): Promise<GeneratedApp> {
  let total = 0;
  const onText = (delta: string) => {
    total += delta.length;
    onEvent({ type: "chunk", text: delta });
    onEvent({ type: "progress", chars: total });
  };

  onEvent({ type: "stage", stage: "model_call" });
  let { text: raw, finishReason } = await runStream(systemPrompt, userPrompt, onText, opts, images);

  for (let i = 0; i < MAX_CONTINUATIONS && !isDone(raw, finishReason); i++) {
    onEvent({ type: "stage", stage: "continuation", detail: `${i + 1}/${MAX_CONTINUATIONS}` });
    const more = await runStream(systemPrompt, continuationPrompt(raw), onText, { ...opts, thinkingBudget: 0 });
    if (!more.text) break;
    raw += more.text;
    finishReason = more.finishReason;
  }
  onEvent({ type: "stage", stage: "validating" });
  return toApp(raw);
}