// bff/text2sql/stream-compose.ts — the one piece of streaming that isn't already
// in the repo: a composer that forwards tokens as they arrive AND still returns
// the complete text, so every caller downstream is unchanged.
//
// WHY A WRAPPER RATHER THAN A NEW STREAMING PATH
// callGeminiStream() (bff/aiflow.ts) already streams from Gemini, and runChatAnalyst
// takes an injectable `model` dep whose contract is "give me the whole answer".
// Wrapping the former to satisfy the latter means the analyst loop, its need_more
// follow-up parsing, and the non-streaming routes all keep working untouched.
//
// THE INTERMEDIATE-ROUND PROBLEM
// runChatAnalyst's composer may reply {"need_more": ["SELECT ..."]} to ask for one
// more round. Streaming that verbatim means the user watches raw JSON appear and
// then vanish when the real answer replaces it. So: withhold the first ~40 chars.
// If they open with `{` the round is machine-to-machine — emit nothing but a
// "querying" stage and let the final round do the talking. Worst case (a genuine
// answer that happens to start with a brace) the user sees no tokens for that
// round and still gets the full reply in the `done` event: degraded, never lost.
import { callGeminiStream, type GenOptions, type GenResult } from "../aiflow";

export type StreamSend = (ev: unknown) => void;

/** How much to hold back before deciding whether this round is JSON plumbing. */
const SNIFF_CHARS = 40;

/**
 * Build a non-streaming-shaped model runner that emits `token` events as it goes.
 *
 * Returns the same `GenResult` the caller would have got from callGemini, so it
 * drops into `deps.model` / `deps.answer` / `deps.compose` without ceremony.
 */
export function streamingComposer(send: StreamSend) {
  return async (system: string, user: string, opts: GenOptions = {}): Promise<GenResult> => {
    let sniff = "";
    let decided = false;
    let emitting = false;

    const decide = (): void => {
      decided = true;
      // A round that opens with `{` is need_more plumbing, not prose.
      if (sniff.trimStart().startsWith("{")) {
        emitting = false;
        send({ type: "stage", stage: "querying" });
        return;
      }
      emitting = true;
      if (sniff) send({ type: "token", text: sniff });
    };

    const result = await callGeminiStream(system, user, (delta) => {
      if (decided) {
        if (emitting && delta) send({ type: "token", text: delta });
        return;
      }
      sniff += delta;
      if (sniff.length >= SNIFF_CHARS) decide();
    }, opts);

    // A reply shorter than the sniff buffer never tripped the check above.
    if (!decided) decide();
    return result;
  };
}
