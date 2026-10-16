// The sprint's acceptance (lib/acceptance), in one command.
//
// First what costs nothing: every check the ten critical scenarios and the
// ten conditions stand on, each run on its own against the check project and the running app.
// Then, only with a budget (--max-usd, for each half), the paid part: every
// eval case three times on a fresh store each time (eval-luke --repeat 3),
// in two halves so neither passes the harness's cap, read into one
// scorecard against the bar (90% of runs, every critical case every run).
// The scorecard lands in evals/acceptance/<label>.md, committed beside the
// runs it reads. Not named check-*, so run-checks never starts it.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/acceptance.mjs --label baseline [--max-usd 8]
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CONDITIONS, CRITICAL, scorecard, scorecardMarkdown } from "../src/lib/acceptance.ts";

const argv = process.argv.slice(2);
const value = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const label = value("--label");
const maxUsd = value("--max-usd");
if (!label || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(label)) {
  console.log("--label is required: lowercase letters, digits and dashes (baseline, final)");
  process.exit(2);
}
const node = (script, args = []) =>
  spawnSync("node", ["--experimental-strip-types", "--import", "./scripts/ts-hook.mjs", script, ...args], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

console.log("what costs nothing: the checks the critical scenarios and the conditions stand on");
const names = [...new Set([...CRITICAL, ...CONDITIONS].flatMap((c) => c.checks))];
const checks = names.map((name) => {
  const r = node(`scripts/${name}.mjs`);
  const ok = r.status === 0;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
  return { name, ok };
});
console.log(
  `  browser: ${[...new Set([...CRITICAL, ...CONDITIONS].flatMap((c) => c.e2e ?? []))].join(", ")} (run with playwright at both widths)`
);

let card = null;
if (maxUsd) {
  console.log(`\nthe paid part: every case three times, in two halves, $${maxUsd} at most each`);
  const index = new URL("../evals/runs/index.json", import.meta.url);
  const before = new Set(JSON.parse(readFileSync(index, "utf8")).map((e) => e.file));
  for (const set of ["full-a", "full-b"]) {
    const r = spawnSync(
      "node",
      ["scripts/eval-luke.mjs", "--label", `${label}-${set}`, "--max-usd", maxUsd, "--set", set, "--repeat", "3"],
      { encoding: "utf8", env: process.env, stdio: "inherit" }
    );
    if (r.status !== 0) console.log(`  ${set} ended with ${r.status}: what it finished is still read`);
  }
  const fresh = JSON.parse(readFileSync(index, "utf8")).filter((e) => !before.has(e.file));
  const results = fresh.flatMap(
    (e) => JSON.parse(readFileSync(new URL(`../evals/runs/${e.file}`, import.meta.url), "utf8")).cases
  );
  card = scorecard(results);
}

const page = scorecardMarkdown(label, checks, card);
writeFileSync(new URL(`../evals/acceptance/${label}.md`, import.meta.url), `${page}\n`);
console.log(`\nwritten: evals/acceptance/${label}.md`);
const ok = checks.every((c) => c.ok) && (card ? card.ok : true);
console.log(
  ok
    ? card
      ? "the bar is met"
      : "every critical check holds; the paid part waits for a budget"
    : "NOT met: see the page"
);
process.exit(ok ? 0 : 1);
