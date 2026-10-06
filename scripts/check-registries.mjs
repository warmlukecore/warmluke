// What the console shows is declared once, so a new thing appears on its
// own and nobody keeps a second list:
//
// - every agent in lib/agents.ts: this fails on a model job (UsageJob)
//   no agent claims, a step a turn tells that is neither an agent's nor
//   the turn's own plumbing, or a card the database's Agents report
//   makes that has no name;
// - every console screen in lib/console-nav.ts: this fails on a page
//   under src/app/[gate]/ the sidebar does not list, or a line there
//   with no page.
//
// Pure: reads files.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-registries.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, TURN_STEPS, agentLabel, jobLabel } from "../src/lib/agents.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");
const filesUnder = (dir) =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const p = join(dir, f);
    return statSync(join(root, p)).isDirectory() ? filesUnder(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

const agents = Object.values(AGENTS);

console.log("model jobs");
const union = read("src/lib/types.ts").match(/export type UsageJob =([^;]+);/)?.[1] ?? "";
const jobs = [...union.matchAll(/"([a-z_-]+)"/g)].map((m) => m[1]);
check("the job list is read", jobs.length >= 10);
const unclaimed = jobs.filter((j) => !agents.some((a) => a.jobs?.includes(j)));
check(`each is an agent's${unclaimed.length ? ` (none for: ${unclaimed.join(", ")})` : ""}`, unclaimed.length === 0);
check(
  "and has words in a reply's breakdown",
  jobs.every((j) => jobLabel(j) !== j)
);

console.log("\nsteps a turn tells");
const told = new Set(filesUnder("src").flatMap((f) => [...read(f).matchAll(/step: "([a-z_-]+)"/g)].map((m) => m[1])));
check("the steps are read", told.size >= 10);
const known = new Set([...agents.map((a) => a.step).filter(Boolean), ...TURN_STEPS]);
const unnamed = [...told].filter((s) => !known.has(s));
check(
  `each is an agent's or the turn's own${unnamed.length ? ` (neither: ${unnamed.join(", ")})` : ""}`,
  unnamed.length === 0
);
const stale = agents.map((a) => a.step).filter((s) => s && !told.has(s));
check(`and every agent's step is still told${stale.length ? ` (not: ${stale.join(", ")})` : ""}`, stale.length === 0);

console.log("\nthe database's cards");
// The newest migration that writes the report is the one the database runs.
const defining = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql") && read(`supabase/migrations/${f}`).includes("function public.abo_admin_agents("))
  .sort()
  .at(-1);
const sql = read(`supabase/migrations/${defining}`);
const cards = [...sql.matchAll(/select \d+, '([a-z -]+)', '/g)].map((m) => m[1]);
check(`the report's cards are read (${defining})`, cards.length >= 10);
const nameless = cards.filter((c) => !AGENTS[c]);
check(`each has a name here${nameless.length ? ` (none for: ${nameless.join(", ")})` : ""}`, nameless.length === 0);
check("and one nobody named still shows, under its own name", agentLabel("someday") === "someday");

console.log("\nconsole screens");
const gate = "src/app/[gate]";
const pages = readdirSync(join(root, gate)).filter((d) => {
  const p = join(root, gate, d);
  return statSync(p).isDirectory() && readdirSync(p).includes("page.tsx");
});
const listed = [...read("src/lib/console-nav.ts").matchAll(/\bto: "([a-z-]*)"/g)].map((m) => m[1]);
check("the sidebar's screens are read", listed.length >= 10 && listed.includes(""));
const unlisted = pages.filter((p) => !listed.includes(p));
check(`every page is in the sidebar${unlisted.length ? ` (not: ${unlisted.join(", ")})` : ""}`, unlisted.length === 0);
const pageless = listed.filter((t) => t !== "" && !pages.includes(t));
check(
  `and every line there has a page${pageless.length ? ` (none for: ${pageless.join(", ")})` : ""}`,
  pageless.length === 0
);

console.log(fails.length === 0 ? "\neverything the console shows is declared once" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
