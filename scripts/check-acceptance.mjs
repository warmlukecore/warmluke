// The sprint's acceptance, read without a run (lib/acceptance).
//
// Pure: the ten critical scenarios each stand on something that exists (a
// check script, a browser spec, an eval case); the bar is 68 of 75; a
// critical case missed on any run fails it however many pass; p50 and p95
// are nearest-rank; a known gap is said on the page, never hidden.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-acceptance.mjs
import { existsSync } from "node:fs";
import { CRITICAL, percentile, scorecard, scorecardMarkdown } from "../src/lib/acceptance.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const at = (p) => new URL(`../${p}`, import.meta.url);

console.log("the ten critical scenarios");
check("ten of them", CRITICAL.length === 10 && new Set(CRITICAL.map((c) => c.id)).size === 10);
check(
  "each stands on something",
  CRITICAL.every((c) => c.checks.length + (c.e2e?.length ?? 0) + (c.cases?.length ?? 0) > 0)
);
const missing = [
  ...CRITICAL.flatMap((c) => c.checks.map((n) => `scripts/${n}.mjs`)),
  ...CRITICAL.flatMap((c) => c.e2e ?? []),
  ...CRITICAL.flatMap((c) => (c.cases ?? []).map((id) => `evals/cases/${id}.json`)),
].filter((p) => !existsSync(at(p)));
check(
  `every check, spec and case named exists${missing.length ? `: missing ${missing.join(", ")}` : ""}`,
  missing.length === 0
);

console.log("\nthe scorecard");
const run = (id, ok, ms, kind = "build", repeat = 1) => ({
  id,
  title: id,
  kind,
  turns: 1,
  built: ok,
  signs: { workarounds: [], jargon: [], proposed_first: true },
  criteria: [{ text: `${id} done`, met: ok, evidence: "" }],
  must_not: [],
  scores: {},
  checks: [],
  cost: 0.1,
  ms,
  repeat,
});
const all = Array.from({ length: 75 }, (_, i) =>
  run(`case-${i % 25}`, i % 25 !== 3, 1000 * (i + 1), i % 2 ? "question" : "build", Math.floor(i / 25) + 1)
);
const card = scorecard(all);
check("68 of 75 is the bar", card.needed === 68 && card.runs === 75);
check("72 passing meets it", card.passed === 72 && card.ok === true);
const withCritical = scorecard([...all.slice(0, 74), run("m-exit", false, 500, "meet", 3)]);
check(
  "a critical case missed on one run fails it, however many pass",
  withCritical.ok === false && withCritical.criticalMisses.join() === "m-exit#3"
);
check(
  "p50 and p95 nearest-rank",
  percentile([5, 1, 3, 2, 4], 50) === 3 &&
    percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) === 10 &&
    percentile([], 50) === 0
);
check("by kind, in seconds", card.byKind.find((k) => k.kind === "question").p95_s > 0 && card.byKind.length === 2);
check("every failed run listed with why", card.failed.length === 3 && card.failed.every((f) => /done/.test(f.why)));
check("nothing run is not a pass", scorecard([]).ok === false);

console.log("\nthe page");
const page = scorecardMarkdown("baseline", [{ name: "check-rls", ok: true }], null);
check("says the paid part was not run", /Not run: the paid part waits for a budget/.test(page));
check("and the open gap", /auto-send \(0195\)/.test(page));
check(
  "with each check's result, or that it was not run",
  /check-rls: pass/.test(page) && /check-build-once: not run/.test(page)
);
const met = scorecardMarkdown("final", [], card);
check(
  "a run's numbers and its verdict",
  /72 of 75 runs passed end to end; the bar is 68/.test(met) && /\*\*Met\.\*\*/.test(met)
);

console.log(fails.length ? `\n${fails.length} FAILED` : "\nacceptance is one command, against the sprint's own bar");
process.exit(fails.length ? 1 : 0);
