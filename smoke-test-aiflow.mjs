// smoke-test-aiflow.mjs
// Reveals the AIFLOW workflow's response shape + whether it can return clean JSON.
//
// Run (do NOT hardcode the key):
//   AIFLOW_API_KEY=app-xxxx AIFLOW_API_URL=https://aiflow.ctrls.in/v1/workflows/run \
//   node smoke-test-aiflow.mjs
//
// Node 18+ (built-in fetch).

import 'dotenv/config';

const key = process.env.AIFLOW_API_KEY;
const url = process.env.AIFLOW_API_URL;
if (!key || !url) {
  console.error("Set AIFLOW_API_KEY and AIFLOW_API_URL as env vars first.");
  process.exit(1);
}

const body = {
  inputs: {
    system_prompt:
      "You are a code generator. Reply with ONLY this JSON object and nothing else " +
      '(no prose, no markdown fences): {"ok": true, "echo": <the integer in the user prompt>}',
    user_prompt: "The number is 42.",
  },
  response_mode: "blocking",
  user: "smoke-test",
};

const t0 = Date.now();
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

console.log("HTTP status:", res.status, `(${Date.now() - t0} ms)`);
const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  console.log("Body was not JSON:\n", text.slice(0, 2000));
  process.exit(0);
}

console.log("\n--- full response envelope ---");
console.log(JSON.stringify(json, null, 2).slice(0, 4000));

// What we actually need to find: where the generated text lands.
const guesses = {
  "data.outputs": json?.data?.outputs,
  "data.text": json?.data?.text,
  answer: json?.answer,
  outputs: json?.outputs,
};
console.log("\n--- likely output locations ---");
for (const [path, val] of Object.entries(guesses)) {
  if (val !== undefined) console.log(`${path} =>`, JSON.stringify(val).slice(0, 500));
}
