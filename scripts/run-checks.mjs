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
// --needs pat: only the checks that need the management PAT — the
// ones CI cannot hold the key for, run by the pre-push hook on the
// machine that already has it. --no-server: when nothing is listening,
// skip the ones that need a server and say so, rather than refusing
// to run the ones that do not.
const needsFilter = args.includes("--needs") ? args[args.indexOf("--needs") + 1] : null;
const noServer = args.includes("--no-server");
// Which .env file the checks read. The check project's, in CI; the
// laptop's, by default. Passed down as ENV_FILE, which every script
// honours.
const envFile = args.includes("--env") ? args[args.indexOf("--env") + 1] : process.env.ENV_FILE ?? ".env.local";
process.env.ENV_FILE = envFile;
let envKeys = new Set();
try {
  envKeys = new Set(
    readFileSync(new URL(`../${envFile}`, here), "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => l.slice(0, l.indexOf("=")).trim())
  );
} catch {
  // No file at all: the pure tier does not need one.
}

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
  // Read from the env FILE means the check cannot run without it.
  // Read from process.env means it degrades on its own —
  // check-operator-parity runs its JavaScript half and says it is
  // skipping the Postgres half — and calling that "live" took it out
  // of CI altogether, which is a check lost to a rule about checks.
  const needsDb =
    /createClient\(|api\.supabase\.com|owner-session|client-session/.test(src) ||
    /env\.(ADAPTIVE_OS_SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN|OWNER_PASSWORD)|env\["(ADAPTIVE_OS_SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN)"\]/.test(
      src.replace(/process\.env\.\w+/g, "")
    );
  const needsServer = /APP_URL|localhost:3100/.test(src);
  const tier = MODEL.has(name) ? "model" : needsDb || needsServer ? "live" : "pure";
  // Checks that import from src/ run TypeScript through the hook the
  // rest of the scripts already use.
  const hook = /from "\.\.\/src\//.test(src);
  // The management PAT is account-wide — it reaches production from
  // anywhere it is held — so it never goes to CI. A check that needs
  // it is skipped there, by name, rather than failing on a missing
  // variable that looks like a bug.
  const needsPat = /api\.supabase\.com|env\.SUPABASE_ACCESS_TOKEN|env\["SUPABASE_ACCESS_TOKEN"\]/.test(
    src.replace(/process\.env\.\w+/g, "")
  );
  // A check that wants a token handed to it on the command line is a
  // harness somebody drives by hand, not something a runner can start.
  const needsJwt = /process\.env\.ABO_JWT/.test(src);
  return { name, tier, hook, needsServer, needsPat, needsJwt };
};

const checks = readdirSync(here)
  .filter((f) => /^check-.*\.mjs$/.test(f))
  .map((f) => classify(f.replace(/\.mjs$/, "")))
  .sort((a, b) => a.name.localeCompare(b.name));

const order = { pure: 0, live: 1, model: 2 };
const chosen = checks
  .filter((c) => tierWanted === "all" || c.tier === tierWanted)
  .filter((c) => !needsFilter || (needsFilter === "pat" ? c.needsPat : true))
  .sort((a, b) => order[a.tier] - order[b.tier] || a.name.localeCompare(b.name));

if (listOnly) {
  for (const c of chosen) console.log(`${c.tier.padEnd(6)} ${c.name}${c.hook ? "  (ts)" : ""}`);
  console.log(`\n${checks.length} checks: ${["pure", "live", "model"].map((t) => `${checks.filter((c) => c.tier === t).length} ${t}`).join(", ")}`);
  process.exit(0);
}

// Live checks need the server; say so once rather than fail forty times.
const APP = process.env.APP_URL ?? "http://localhost:3100";
let serverUp = true;
let serverWhy = `needs a server at ${APP}; none is up`;
if (chosen.some((c) => c.needsServer)) {
  serverUp = await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false);
  // Up is not enough: the build on 3100 is inlined with one project's
  // keys, and the env file names one project. When they differ, every
  // check that talks to the server through the env file's session is
  // talking to the wrong database — as-client's OAuth consent went to
  // production's auth server with a session minted on the check
  // project, and failed with "authorization not found". Compare the
  // project the server names in its resource document with the one
  // the env file names, and treat a mismatch as no server for this
  // env, said out loud.
  if (serverUp) {
    const ref = (u) => {
      try {
        return new URL(u).hostname.split(".")[0];
      } catch {
        return null;
      }
    };
    const served = await fetch(`${APP}/.well-known/oauth-protected-resource`)
      .then((r) => r.json())
      .then((d) => ref(d.authorization_servers?.[0]))
      .catch(() => null);
    let mine = null;
    try {
      const line = readFileSync(new URL(`../${envFile}`, here), "utf8")
        .split("\n")
        .find((l) => l.startsWith("NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL="));
      mine = ref(line?.slice(line.indexOf("=") + 1).trim());
    } catch {
      // No env file; the pure tier does not have one.
    }
    if (served && mine && served !== mine) {
      serverUp = false;
      serverWhy = `the server at ${APP} is built for ${served}, but ${envFile} names ${mine}`;
    }
  }
  if (!serverUp && !noServer) {
    console.log(`the live checks that need a server cannot run: ${serverWhy} — start the right one, or pass --no-server`);
    process.exit(2);
  }
}

// One after another, never at once: the live ones share one check
// user, whose hourly request budget they would otherwise spend on each
// other.
const failed = [];
const skipped = [];
for (const c of chosen) {
  if (c.needsPat && c.tier !== "pure" && envKeys.size > 0 && !envKeys.has("SUPABASE_ACCESS_TOKEN")) {
    console.log(`skip  ${c.tier.padEnd(6)} ${c.name.padEnd(26)} (needs SUPABASE_ACCESS_TOKEN, not in ${envFile})`);
    skipped.push(c.name);
    continue;
  }
  if (c.needsServer && !serverUp) {
    console.log(`skip  ${c.tier.padEnd(6)} ${c.name.padEnd(26)} (${serverWhy})`);
    skipped.push(c.name);
    continue;
  }
  if (c.needsJwt && !process.env.ABO_JWT) {
    console.log(`skip  ${c.tier.padEnd(6)} ${c.name.padEnd(26)} (driven by hand: set ABO_JWT to run it)`);
    skipped.push(c.name);
    continue;
  }
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
    ? `\n${chosen.length - skipped.length} ${tierWanted === "all" ? "" : tierWanted + " "}checks, all green${skipped.length ? ` (${skipped.length} skipped — each said why above)` : ""}`
    : `\n${failed.length} of ${chosen.length} FAILED: ${failed.join(", ")}`
);
process.exit(failed.length === 0 ? 0 : 1);
