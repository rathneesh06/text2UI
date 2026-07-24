// scripts/eval-fewshot.ts — Phase B live eval harness (NOT part of npm test:
// this calls the real model). Run on a machine with a working GEMINI_API_KEY:
//
//   npx tsx scripts/eval-fewshot.ts decompose      # with few-shot (default)
//   T2UI_FEWSHOT=0 npx tsx scripts/eval-fewshot.ts decompose   # baseline
//   npx tsx scripts/eval-fewshot.ts editops
//   T2UI_FEWSHOT=0 npx tsx scripts/eval-fewshot.ts editops
//
// Scoring is PER DOMAIN, and "clinic" is the HELD-OUT domain (in no few-shot
// example). The acceptance rule (goal 5, the two-domain overfit gate):
//   keep few-shot ONLY if the with-flag run beats the baseline overall AND on
//   the held-out domain; edit-ops spurious removals must be ZERO either way.
import { decomposeQuery } from "../bff/dashboard/decompose";
import { planEditOps, type EditOp } from "../bff/dashboard/patch";
import { FEWSHOT_ENABLED, EXAMPLE_SPEC } from "../bff/dashboard/fewshot";
import { DECOMPOSE_EVAL, EDITOPS_EVAL, EVAL_DATASETS } from "../bff/dashboard/eval-sets";
import type { DashboardSpec } from "../shared/dashboard-spec";

const mode = process.argv[2];
if (mode !== "decompose" && mode !== "editops") {
  console.error("usage: tsx scripts/eval-fewshot.ts <decompose|editops>");
  process.exit(2);
}
console.log(`few-shot: ${FEWSHOT_ENABLED() ? "ON" : "OFF (baseline)"}\n`);

const perDomain = new Map<string, { pass: number; total: number }>();
const bump = (d: string, ok: boolean) => {
  const e = perDomain.get(d) ?? { pass: 0, total: 0 };
  e.total++; if (ok) e.pass++;
  perDomain.set(d, e);
};

// The eval board: EXAMPLE_SPEC retargeted at the domain's table so widget ids
// (k1/c1/t1) are comparable across domains.
const boardFor = (domain: string): DashboardSpec => {
  const table = EVAL_DATASETS[domain][0].tableName;
  const s: DashboardSpec = JSON.parse(JSON.stringify(EXAMPLE_SPEC));
  for (const w of s.sections[0].widgets as any[]) w.table = table;
  return s;
};

if (mode === "decompose") {
  for (const c of DECOMPOSE_EVAL) {
    try {
      const r = await decomposeQuery(EVAL_DATASETS[c.domain], c.prompt, "directive: answer the user's analytical intent");
      const got = (r.tasks ?? []).map((t) => t.kind).sort();
      const want = [...c.expectKinds].sort();
      // multiset match with tolerance: every expected kind present; ≤1 extra task
      const gotCopy = [...got];
      const missing = want.filter((k) => {
        const i = gotCopy.indexOf(k); if (i >= 0) { gotCopy.splice(i, 1); return false; } return true;
      });
      const ok = missing.length === 0 && gotCopy.length <= 1 && r.source === "model";
      bump(c.domain, ok);
      console.log(`${ok ? "PASS" : "FAIL"} [${c.domain}] "${c.prompt}" → ${got.join(",") || "(none)"} (want ${want.join(",")}${missing.length ? `; missing ${missing.join(",")}` : ""}${gotCopy.length > 1 ? `; ${gotCopy.length} extras` : ""})`);
    } catch (err: any) {
      bump(c.domain, false);
      console.log(`FAIL [${c.domain}] "${c.prompt}" → error: ${err?.message ?? err}`);
    }
  }
} else {
  let spuriousRemovals = 0;
  let totalOps = 0;
  for (const c of EDITOPS_EVAL) {
    try {
      const ops: EditOp[] | null = await planEditOps({
        datasets: EVAL_DATASETS[c.domain], userPrompt: c.user, currentSpec: boardFor(c.domain),
        chatContext: null, selectedWidget: c.selectedId ? { id: c.selectedId } : null, directive: undefined,
      } as any);
      const got = ops ?? [];
      totalOps += got.length;
      const removed = got.some((o) => o.op === "remove_widget");
      if (removed && c.mustNotRemove) spuriousRemovals++;
      const targeted = !c.mustTargetId || got.some((o: any) => o.id === c.mustTargetId);
      const ok = got.length <= c.maxOps
        && (!c.mustNotRemove || !removed)
        && targeted
        && (!c.expectEmptyOps || got.length === 0);
      bump(c.domain, ok);
      console.log(`${ok ? "PASS" : "FAIL"} [${c.domain}] "${c.user}" → ${got.length} op(s) ${JSON.stringify(got).slice(0, 140)}`);
    } catch (err: any) {
      bump(c.domain, false);
      console.log(`FAIL [${c.domain}] "${c.user}" → error: ${err?.message ?? err}`);
    }
  }
  console.log(`\nspurious removals: ${spuriousRemovals} (acceptance: MUST be 0)`);
  console.log(`avg ops/case: ${(totalOps / EDITOPS_EVAL.length).toFixed(2)} (acceptance: no regression vs baseline)`);
}

console.log("\nper-domain accuracy:");
let pass = 0, total = 0;
for (const [d, e] of perDomain) {
  pass += e.pass; total += e.total;
  console.log(`  ${d}${d === "clinic" ? " (HELD OUT)" : ""}: ${e.pass}/${e.total}`);
}
console.log(`  overall: ${pass}/${total}`);
console.log("\nGATE: keep few-shot only if ON beats OFF overall AND on the held-out domain.");
