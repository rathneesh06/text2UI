// Manual end-to-end test for the BFF. Requires `npm run dev:bff` running.
// Usage:  npx tsx scripts/test-generate.ts "your prompt here"
import { ingest } from "../src/lib/ingest";

const BFF = process.env.BFF_URL ?? "http://localhost:8787";

const csv = `region,product,revenue,date
West,Widget,1200.50,2024-01-15
East,Gadget,980,2024-02-03
West,Gadget,4500,2024-03-01
North,Widget,300,2024-03-11`;

const { profile } = ingest("sales.csv", csv);
const userPrompt = process.argv.slice(2).join(" ") || "A dashboard showing total revenue by region as a bar chart";

console.log("POST", BFF + "/api/generate");
console.log("prompt:", userPrompt, "\n");

try {
  const res = await fetch(BFF + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, userPrompt }),
  });
  console.log("HTTP", res.status);
  const json: any = await res.json();
  if (Array.isArray(json.files)) {
    console.log("summary:", json.summary);
    for (const f of json.files) {
      console.log(`\n--- ${f.path} (${f.content.length} chars) ---`);
      console.log(f.content.slice(0, 500) + (f.content.length > 500 ? "\n...(preview truncated)" : ""));
    }
  } else {
    console.log("error:", json.error);
  }
} catch (e) {
  console.error("Request failed - is the BFF running? (npm run dev:bff)\n", (e as Error).message);
}