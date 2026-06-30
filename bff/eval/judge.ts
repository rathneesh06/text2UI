// bff/eval/judge.ts — Wave 2 / P7, Step 2: the LLM-as-judge.
// Grades the two dimensions deterministic scorers can't: visual POLISH and
// PROMPT-RESPONSIVENESS. A single model call per case returns strict JSON.
// Best-effort: any failure (network, parse) resolves to null so the runner still
// reports the deterministic scores. The model call is injected for testability.

export interface JudgeResult {
  polish: number;           // 1..5
  promptResponsive: number; // 1..5
  notes?: string;
}

export const JUDGE_SYSTEM = [
  "You are a strict senior reviewer of data-dashboard UIs.",
  "You are given the user's PROMPT and the generated React (App.tsx) SOURCE.",
  "Rate two dimensions on a 1-5 integer scale:",
  "  polish: visual quality & information design implied by the code (hierarchy, spacing, KPI cards, chart variety, states). 5 = looks shippable; 1 = flat/unstyled.",
  "  promptResponsive: how directly the app addresses what the prompt asked for. 5 = every ask covered; 1 = generic/ignores the prompt.",
  "Be critical; reserve 5 for genuinely excellent work.",
  'Return ONLY a JSON object, no prose, no code fences: {"polish": <1-5>, "promptResponsive": <1-5>, "notes": "<=1 short sentence"}',
].join("\n");

export function buildJudgePrompt(prompt: string, code: string): string {
  // Cap the code so a huge file can't blow the judge's context/cost.
  const clipped = code.length > 16000 ? code.slice(0, 16000) + "\n/* ...truncated... */" : code;
  return `PROMPT:\n${prompt}\n\nAPP SOURCE (App.tsx):\n${clipped}`;
}

/** Tolerant parse of the judge's JSON. Returns null if it can't be trusted. */
export function parseJudge(text: string): JudgeResult | null {
  if (!text) return null;
  const stripped = text.replace(/```json|```/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  let obj: any;
  try {
    obj = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  const clamp = (n: any): number | null => {
    const v = Math.round(Number(n));
    return Number.isFinite(v) && v >= 1 && v <= 5 ? v : null;
  };
  const polish = clamp(obj.polish);
  const promptResponsive = clamp(obj.promptResponsive);
  if (polish === null || promptResponsive === null) return null;
  return { polish, promptResponsive, notes: typeof obj.notes === "string" ? obj.notes.slice(0, 200) : undefined };
}

/** Build a judge function from a raw model-call fn (system, user) => text.
 *  Injecting the call keeps this testable and decouples it from the Gemini client. */
export function makeJudge(
  call: (system: string, user: string) => Promise<string>,
): (prompt: string, code: string) => Promise<JudgeResult | null> {
  return async (prompt, code) => {
    try {
      const text = await call(JUDGE_SYSTEM, buildJudgePrompt(prompt, code));
      return parseJudge(text);
    } catch {
      return null; // best-effort: never let a judge failure break the run
    }
  };
}
