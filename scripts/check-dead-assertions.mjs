// scripts/check-dead-assertions.mjs — Phase D hygiene gate (npm run test:hygiene).
// The dead-assertion class shipped twice (`assert.ok(x || true)` passes forever).
// This grep fails the chain when a test contains an assertion that cannot fail.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = ["bff", "shared", "src"];
const BAD = [
  /\|\|\s*true\s*[,)]/,          // assert.ok(x || true)
  /assert\.ok\(\s*true\s*[,)]/,  // assert.ok(true)
  /assert\.equal\(\s*1\s*,\s*1\s*[,)]/,
];
const offenders = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(p); continue; }
    if (!/\.test\.tsx?$/.test(name)) continue;
    const lines = readFileSync(p, "utf-8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes("hygiene-allow")) return;
      for (const re of BAD) if (re.test(line)) offenders.push(`${p}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
};
for (const r of ROOTS) { try { walk(r); } catch { /* missing root is fine */ } }
if (offenders.length) {
  console.error("dead assertions found (an assertion that cannot fail is not a test):");
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log("hygiene: no dead assertions ✅");
