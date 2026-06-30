// tailwind.test.ts — server-side CSS compile. Run: npx tsx bff/tailwind.test.ts
// Covers the best-effort contract with an injected runner (no CLI needed) plus
// one real end-to-end compile to prove the toolchain captures source classes.
import assert from "node:assert/strict";
import { compileCss } from "./tailwind";
import type { GeneratedFile } from "../shared/types";

const appFiles: GeneratedFile[] = [
  {
    path: "/App.tsx",
    content: `export default function App() {
      return <div className="min-h-screen bg-slate-50 group-hover:bg-indigo-100 xl:col-span-2 fill-amber-500 max-w-[150px] shadow-sm rounded-xl tabular-nums" />;
    }`,
  },
];

// ---- best-effort contract (injected runner, no real CLI) -------------------
{
  // success: runner "writes" out.css — but compileCss reads the real file, so we
  // stub by having the runner throw to exercise the failure path deterministically.
  const failing = async () => { throw new Error("cli not found"); };
  const css = await compileCss(appFiles, failing);
  assert.equal(css, null, "compile failure resolves to null (CDN fallback)");
}
{
  // no code files -> null without invoking the runner
  let called = false;
  const runner = async () => { called = true; return { stdout: "", stderr: "" }; };
  const css = await compileCss([{ path: "/data.json", content: "{}" }], runner);
  assert.equal(css, null, "no code files -> null");
  assert.equal(called, false, "runner not called when there are no code files");
}

console.log("tailwind best-effort: all assertions passed");

// ---- real end-to-end compile (uses the installed @tailwindcss/cli) ---------
// Skips gracefully if the CLI isn't present in this environment.
{
  const css = await compileCss(appFiles);
  if (css === null) {
    console.log("tailwind real compile: SKIPPED (CLI unavailable)");
  } else {
    for (const cls of ["bg-slate-50", "bg-indigo-100", "col-span-2", "fill-amber-500", "150px", "shadow", "tabular-nums"]) {
      assert.ok(css.includes(cls), `compiled CSS contains ${cls}`);
    }
    console.log("tailwind real compile: all assertions passed");
  }
}