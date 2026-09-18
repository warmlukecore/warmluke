// Runs the checks — all of them, or one tier — and says which ran.
//
// There were fifty-two check-*.mjs files and about twenty of them were
// being run, because the list lived in somebody's memory. Nothing was
// wrong with the other thirty; nobody remembered them. A list in a file
// has the same weakness one step removed: a new check has to be added
// to it, and the one that is forgotten is the one that would have
// caught something.
//
// So there is no list. Every scripts/check-*.mjs is a check, and what
// it needs is read off the file itself:
//
//   pure   nothing — parses, validates, formats. Runs anywhere, in CI
//          on every push, with no secrets.
//   live   a database and usually a running server. Runs locally, or
//          in CI once it has somewhere safe to point at.
//   model  a paid model call, and an answer that can differ between
//          runs. Run by hand, or nightly — never on every push.
//
// A new file lands in a tier on its next run. A half-written one goes
// red, which is the right way for it to be noticed.
//
//   node scripts/run-checks.mjs               every tier, in order
//   node scripts/run-checks.mjs --tier pure   what CI runs
//   node scripts/run-checks.mjs --list        classification only
//   APP_URL=http://localhost:3100             where the live ones look

import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const here = new URL(".", import.meta.url);
const args = process.argv.slice(2);
const tierWanted = args.includes("--tier") ? args[args.indexOf("--tier") + 1] : "all";
const listOnly = args.includes("--list");

// The two that spend money and can disagree with themselves. Named
// rather than inferred: what makes them different is not visible in
// the file, it is what the server does when they call propose_change.
const MODEL = new Set(["check-mcp", "check-auto-build"]);

const classify = (name) => {
  const src = readFileSync(new URL(`./${name}.mjs`, here), "utf8");
  // A file that reads a secret's name needs the secret. check-rls and
  // check-weakest make no client — they fetch PostgREST directly with
  // the service-role key — and the first CI run called them pure and
  // went red on "missing Supabase env". The name of the key is the
  // surer signal.
  const needsDb =
    /createClient\(|api\.supabase\.com|owner-session|client-session/.test(src) ||
    /ADAPTIVE_OS_SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN|OWNER_PASSWORD/.test(src);
  const needsServer = /APP_URL|localhost:3100/.test(src);
  const tier = MODEL.has(name) ? "model" : needsDb || needsServer ? "live" : "pure";
  // Checks that import from src/ run TypeScript through the hook the
  // rest of the scripts already use.
  const hook = /from "\.\.\/src\//.test(src);
  return { name, tier, hook, needsServer };
};

const checks = readdirSync(here)
  .filter((f) => /^check-.*\.mjs$/.test(f))
  .map((f) => classify(f.replace(/\.mjs$/, "")))
  .sort((a, b) => a.name.localeCompare(b.name));

const order = { pure: 0, live: 1, model: 2 };
const chosen = checks
  .filter((c) => tierWanted === "all" || c.tier === tierWanted)
  .sort((a, b) => order[a.tier] - order[b.tier] || a.name.localeCompare(b.name));

if (listOnly) {
  for (const c of chosen) console.log(`${c.tier.padEnd(6)} ${c.name}${c.hook ? "  (ts)" : ""}`);
  console.log(`\n${checks.length} checks: ${["pure", "live", "model"].map((t) => `${checks.filter((c) => c.tier === t).length} ${t}`).join(", ")}`);
  process.exit(0);
}

// Live checks need the server; say so once rather than fail forty times.
const APP = process.env.APP_URL ?? "http://localhost:3100";
if (chosen.some((c) => c.needsServer)) {
  const up = await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false);
  if (!up) {
    console.log(`the live checks need a server at ${APP} and there is none — start one, or run --tier pure`);
    process.exit(2);
  }
}

// One after another, never at once: the live ones share one check
// user, whose hourly request budget they would otherwise spend on each
// other.
const failed = [];
for (const c of chosen) {
  const cmd = c.hook
    ? ["--experimental-strip-types", "--import", new URL("./ts-hook.mjs", here).pathname, `scripts/${c.name}.mjs`]
    : [`scripts/${c.name}.mjs`];
  const started = Date.now();
  const run = spawnSync(process.execPath, cmd, { encoding: "utf8", env: process.env });
  const ok = run.status === 0;
  const secs = ((Date.now() - started) / 1000).toFixed(0).padStart(3);
  console.log(`${ok ? "ok  " : "FAIL"}  ${c.tier.padEnd(6)} ${c.name.padEnd(26)} ${secs}s`);
  if (!ok) {
    failed.push(c.name);
    const out = `${run.stdout}${run.stderr}`;
    // What went red, not the whole transcript.
    const lines = out.split("\n").filter((l) => /FAIL|→|Error|could not|Cannot/.test(l)).slice(0, 8);
    for (const l of lines) console.log(`        ${l.trim().slice(0, 160)}`);
  }
}

console.log(
  failed.length === 0
    ? `\n${chosen.length} ${tierWanted === "all" ? "" : tierWanted + " "}checks, all green`
    : `\n${failed.length} of ${chosen.length} FAILED: ${failed.join(", ")}`
);
process.exit(failed.length === 0 ? 0 : 1);
