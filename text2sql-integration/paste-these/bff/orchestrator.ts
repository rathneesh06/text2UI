// bff/orchestrator.ts — the planner stage (Phase 1).
//
// One structured Gemini call that studies the data + the user's prompt and emits
// a BRIEF: it picks the output mode (dashboard/pdf/ppt) and fully specifies the
// build — KPIs, charts, color palette, design direction, and a detailed enhanced
// prompt. The brief gives the downstream generator complete context, which is
// what turns "mid" output into good output. Falls back gracefully: on any failure
// the caller proceeds with the raw prompt exactly as before.

import type { Dataset, OrchestratorBrief, OrchestratorResult, ChatMessage } from "../shared/types";
import { callGemini, ORCHESTRATE_OPTS, type GenResult, type GenOptions } from "./aiflow";

export const ORCHESTRATOR_ENABLED = (process.env.ORCHESTRATOR_ENABLED ?? "0") === "1";
const ORCH_TIMEOUT_MS = Number(process.env.ORCHESTRATOR_TIMEOUT_MS ?? 15000);

// JSON schema handed to Gemini via responseSchema (OpenAPI subset). Kept compact
// per Google's guidance (short names, few constraints) for reliable output.
export const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    outputMode: { type: "string", enum: ["dashboard", "pdf", "ppt"], description: "Artifact to build. Honor the user's explicit ask; default dashboard." },
    needsClarification: { type: "boolean", description: "True only if the request is too ambiguous to proceed." },
    respond: { type: "boolean", description: "True when the message wants an ANSWER (a question, greeting, thanks, feedback), not a build." },
    reply: { type: "string", description: "If respond: the answer, grounded ONLY in the schema, samples, and conversation." },
    dataQuestion: { type: "boolean", description: "If respond: true when a correct answer requires computing over the full data, not the samples." },
    question: { type: "string", description: "If needsClarification, the single question to ask the user." },
    title: { type: "string" },
    narrative: { type: "string", description: "The story the data tells, 1-2 sentences." },
    kpis: { type: "array", items: { type: "string" }, description: "Headline metrics to surface as stat cards." },
    charts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", description: "e.g. bar, line, area, pie, funnel, table" },
          x: { type: "string" }, y: { type: "string" }, why: { type: "string" },
        },
        required: ["type", "x", "y"],
      },
    },
    palette: {
      type: "object",
      properties: {
        primary: { type: "string", description: "hex" }, accent: { type: "string", description: "hex" },
        neutrals: { type: "array", items: { type: "string" } },
        vibe: { type: "string", description: "e.g. vibrant, calm, corporate, playful" },
      },
      required: ["primary", "accent", "vibe"],
    },
    designDirection: { type: "string", description: "Concrete visual direction: density, mood, emphasis." },
    enhancedPrompt: { type: "string", description: "The full, detailed build brief for the generator." },
  },
  required: ["outputMode", "title", "kpis", "charts", "palette", "designDirection", "enhancedPrompt"],
};

const SYSTEM = `You are the planning stage of a data-app generator. Study the dataset schema and the user's request, then ALWAYS produce a single complete JSON brief that fully specifies what to build.
- Choose outputMode from the user's intent (a "report" -> pdf, "slides/deck/presentation" -> ppt, otherwise dashboard).
- Pick the KPIs and charts that best represent THIS data; reference real column names.
- Specify a concrete, attractive color palette (hex) and a vivid design direction — favor tasteful vibrance over dull defaults.
- Write enhancedPrompt as a complete, detailed brief the generator can follow without guessing.
- DEFAULT TO BUILDING. Commit to a confident best plan in essentially every case; make reasonable assumptions instead of asking. NEVER ask the user to clarify styling, colors, chart choice, or which metrics to show — decide yourself.
- Set needsClarification=true ONLY when the request is empty or entirely unrelated to the data. If the conversation already contains a clarifying question, never ask again — proceed with a best-effort plan.
- RESPOND, DON'T BUILD, when the message is a QUESTION about the data ("which region sold most?"), a greeting, thanks, or feedback wanting an answer: set respond=true and write a warm, direct reply grounded ONLY in the schema/samples/conversation. Set dataQuestion=true when the honest answer needs the full data (aggregations, extremes, counts) rather than the 3 sample rows — never present sample-derived numbers as facts about the whole dataset. Still fill the required brief fields with a best plan; they are ignored when respond=true.`;

function describeDatasets(datasets: Dataset[]): string {
  return datasets.map((d) => {
    const cols = d.profile.columns.map((c: any) => `${c.name}:${c.type ?? "?"}`).join(", ");
    const sample = (d.profile.sampleRows ?? []).slice(0, 3).map((r) => JSON.stringify(r)).join("\n");
    return `Table ${d.tableName} (${d.profile.rowCount} rows)\nColumns: ${cols}\nSample:\n${sample}`;
  }).join("\n\n");
}

function buildUserPrompt(datasets: Dataset[], userPrompt: string, history?: ChatMessage[]): string {
  const hist = history?.length
    ? "Conversation so far:\n" + history.map((m) => `${m.role}: ${m.content}`).join("\n") + "\n\n"
    : "";
  return `${hist}Data:\n${describeDatasets(datasets)}\n\nUser request: ${userPrompt}`;
}

export interface OrchestrateInput { datasets: Dataset[]; userPrompt: string; history?: ChatMessage[] }
export type OrchestrateRun = (s: string, u: string, o?: GenOptions) => Promise<GenResult>;

/** Run the planner. Returns a brief, a clarification request, or null (caller
 *  then falls back to the raw prompt). Never throws. */
export async function orchestrate(input: OrchestrateInput, run: OrchestrateRun = callGemini, timeoutMs = ORCH_TIMEOUT_MS): Promise<OrchestratorResult | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<OrchestratorResult | null> => {
    try {
      const { text } = await run(SYSTEM, buildUserPrompt(input.datasets, input.userPrompt, input.history), { ...ORCHESTRATE_OPTS, responseSchema: BRIEF_SCHEMA });
      const parsed = JSON.parse(stripFences(text));
      // A respond turn beats a build: the user asked a question, so building
      // would feel unresponsive — exactly the failure mode this intent removes.
      if (parsed?.respond === true && typeof parsed.reply === "string" && parsed.reply.trim()) {
        console.log(`[orchestrator] respond turn (dataQuestion=${!!parsed.dataQuestion})`);
        return { respond: true, reply: parsed.reply.trim(), dataQuestion: !!parsed.dataQuestion };
      }
      // Prefer a usable plan. The schema requires the brief fields, so the model
      // almost always supplies them — even when it also flags clarification.
      // Checking the brief FIRST stops spurious "needs clarification" stalls.
      if (isValidBrief(parsed)) {
        const { needsClarification: _nc, question: _q, ...brief } = parsed as any; // keep the discriminator clean
        console.log(`[orchestrator] brief: mode=${brief.outputMode} title="${brief.title}"`);
        return brief as OrchestratorBrief;
      }
      if (parsed?.needsClarification && parsed?.question) {
        console.log(`[orchestrator] needsClarification (no valid brief): ${parsed.question}`);
        return { needsClarification: true, question: String(parsed.question) };
      }
      console.warn("[orchestrator] no valid brief and no clarification -> null (raw fallback)");
      return null;
    } catch (err) {
      console.warn(`[orchestrator] failed, falling back to raw prompt: ${(err as Error).message}`);
      return null;
    }
  })();
  return Promise.race([call, timeout]);
}

// ---- follow-up gate ---------------------------------------------------------------
// Once an artifact exists, the mode is locked and (previously) every prompt went
// STRAIGHT to the builder — questions triggered rebuilds and felt robotic. This
// gate is the missing orchestration layer for turns 2..n: a small, fast call that
// decides edit vs answer. It defaults to "edit" on any failure, so it can never
// block a build.
export interface GateResult { action: "edit" | "question" | "chat"; reply?: string; dataQuestion?: boolean }

export const GATE_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["edit", "question", "chat"], description: "edit: change/restyle/extend the artifact. question: asks ABOUT the data or artifact. chat: greeting/thanks/meta." },
    reply: { type: "string", description: "For question/chat: the answer, grounded ONLY in the provided context." },
    dataQuestion: { type: "boolean", description: "For question: true when answering needs computing over the full data." },
  },
  required: ["action"],
};

const GATE_SYSTEM = `A data artifact already exists and the user sent a follow-up. Classify it:
- edit: ANY request to change the artifact — colors, theme, layout, add/remove/resize charts or KPIs, filters, titles, different metrics. When ambiguous, choose edit.
- question: the user asks ABOUT the data or the artifact ("which month peaked?", "what does this chart show?"). Write reply grounded ONLY in the context below; set dataQuestion=true when a correct answer needs full-data computation (totals, extremes, group-bys) — NEVER invent numbers.
- chat: greetings, thanks, meta ("nice!", "what can you do?"). Write a short, warm reply.`;

export interface GateInput { userPrompt: string; history?: ChatMessage[]; artifactKind: string; artifactSummary?: string; datasets?: Dataset[] }

export async function gateTurn(input: GateInput, run: OrchestrateRun = callGemini, timeoutMs = 8000): Promise<GateResult | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const call = (async (): Promise<GateResult | null> => {
    try {
      const hist = input.history?.length ? "Conversation so far:\n" + input.history.slice(-10).map((m) => `${m.role}: ${m.content}`).join("\n") + "\n\n" : "";
      const data = input.datasets?.length ? `Data:\n${describeDatasets(input.datasets)}\n\n` : "";
      const art = `Current artifact: a ${input.artifactKind}${input.artifactSummary ? ` — ${input.artifactSummary}` : ""}.\n\n`;
      const { text } = await run(GATE_SYSTEM, `${hist}${data}${art}User message: ${input.userPrompt}`, { ...ORCHESTRATE_OPTS, responseSchema: GATE_SCHEMA });
      const parsed = JSON.parse(stripFences(text));
      if (!parsed || !["edit", "question", "chat"].includes(parsed.action)) return null;
      if (parsed.action !== "edit" && !(typeof parsed.reply === "string" && parsed.reply.trim())) return { action: "edit" };
      console.log(`[gate] action=${parsed.action}${parsed.dataQuestion ? " dataQuestion" : ""}`);
      return { action: parsed.action, reply: parsed.reply?.trim(), dataQuestion: !!parsed.dataQuestion };
    } catch (err) {
      console.warn(`[gate] failed -> edit: ${(err as Error).message}`);
      return null;
    }
  })();
  return Promise.race([call, timeout]);
}

function isValidBrief(b: any): b is OrchestratorBrief {
  return b && ["dashboard", "pdf", "ppt"].includes(b.outputMode)
    && typeof b.enhancedPrompt === "string" && b.enhancedPrompt.trim().length > 0
    && Array.isArray(b.kpis) && Array.isArray(b.charts) && b.palette && typeof b.palette.primary === "string";
}

function stripFences(t: string): string {
  return t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

/** Compose the final builder prompt from a brief (enhanced prompt + design spec). */
export function composePrompt(brief: OrchestratorBrief): string {
  const charts = brief.charts.map((c) => `${c.type} of ${c.y} by ${c.x}${c.why ? ` (${c.why})` : ""}`).join("; ");
  const neutrals = brief.palette.neutrals?.length ? `, neutrals ${brief.palette.neutrals.join("/")}` : "";
  return [
    brief.enhancedPrompt,
    ``,
    `Title: ${brief.title}`,
    brief.narrative ? `Narrative: ${brief.narrative}` : "",
    `Key metrics: ${brief.kpis.join(", ")}.`,
    `Charts: ${charts}.`,
    `Color palette: primary ${brief.palette.primary}, accent ${brief.palette.accent}${neutrals}; vibe ${brief.palette.vibe}.`,
    `Design direction: ${brief.designDirection}`,
  ].filter(Boolean).join("\n");
}
