// Applies supabase/migrations/*.sql to a project, in order, and writes
// down which ones it applied.
//
// Seventy-eight migrations went onto production by hand, one at a
// time, through the management API. Nothing recorded it: production
// has no supabase_migrations schema and no table of ours, so "what is
// live" was answerable only by reading the functions. A second
// project could not be built from the repo at all.
//
// This keeps its own ledger, public.abo_migrations, on the project it
// runs against. Idempotent: what the ledger already lists is skipped.
// --record-only writes the ledger without running anything — for
// production, where every file has already run.
//
//   node scripts/apply-migrations.mjs --env .env.check.local
//   node scripts/apply-migrations.mjs --env .env.local --record-only

import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const envFile = args.includes("--env") ? args[args.indexOf("--env") + 1] : ".env.local";
const recordOnly = args.includes("--record-only");

const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const REF = new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0];

// Two ways in, and which one is a property of the env file, not of
// the code:
//
//   DATABASE_URL          a direct connection, per project. This is
//                         what CI has — the check project's password
//                         reaches that database and no other. Each
//                         file runs as one transaction, so a migration
//                         that fails halfway leaves nothing behind.
//   SUPABASE_ACCESS_TOKEN the management API. Account-wide, so it
//                         stays on a laptop; production is applied
//                         this way, by hand, as it always was.
//
// A third project tomorrow is a third env file. Nothing here changes.
const viaPsql = !!env.DATABASE_URL;
if (!viaPsql && !env.SUPABASE_ACCESS_TOKEN) {
  console.log(`neither DATABASE_URL nor SUPABASE_ACCESS_TOKEN in ${envFile} — no way to reach the database`);
  process.exit(2);
}

const api = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body;
};
const psql = (args, input) => {
  const r = spawnSync("psql", [env.DATABASE_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
  });
  if (r.error) throw new Error(`psql could not start: ${r.error.message}`);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 500));
  return r.stdout;
};
/** Runs statements. Through psql, as one transaction. */
const run = async (text) => (viaPsql ? psql(["-1", "-f", "-"], text) : api(text));
/** One column of one query, as strings. */
const column = async (query) =>
  viaPsql
    ? psql(["-At", "-c", query]).split("\n").filter(Boolean)
    : (await api(query)).map((r) => String(Object.values(r)[0]));

console.log(`${REF} via ${viaPsql ? "a direct connection" : "the management API"}`);
await run(`
  create table if not exists public.abo_migrations (
    version       text primary key,
    name          text not null,
    applied_at    timestamptz not null default now(),
    -- true when the ledger was written after the fact, for a migration
    -- that had already run by hand
    recorded_only boolean not null default false
  );
  alter table public.abo_migrations enable row level security;
  notify pgrst, 'reload schema';
`);
const done = new Set(await column("select version from public.abo_migrations"));

const dir = new URL("../supabase/migrations/", import.meta.url);
// The base is not a migration. supabase/schema.sql made the first three
// tables in the initial commit, and every migration from 0002 alters
// what it made — 0002 fails on a blank project with "relation
// public.modules does not exist". It is version 0001 here, read from
// where it lives; it is idempotent, so recording it on production is
// all that is needed there.
const BASE = { f: "0001_schema.sql", url: new URL("../supabase/schema.sql", import.meta.url) };
const files = [BASE, ...readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => ({ f, url: new URL(f, dir) }))];
console.log(`${REF}: ${files.length} migrations in the repo, ${done.size} already in the ledger${recordOnly ? " — recording only" : ""}`);

let applied = 0;
for (const { f, url } of files) {
  const version = /^(\d{4})_/.exec(f)?.[1];
  if (!version) throw new Error(`not a migration name: ${f}`);
  if (done.has(version)) continue;
  const q = (v) => v.replace(/'/g, "''");
  if (!recordOnly) {
    const started = Date.now();
    try {
      await run(readFileSync(url, "utf8"));
    } catch (e) {
      console.log(`FAIL  ${f}\n      ${e.message}`);
      console.log(`\nstopped at ${f}; ${applied} applied this run. Fix and rerun — what landed is in the ledger.`);
      process.exit(1);
    }
    console.log(`ok    ${f}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } else {
    console.log(`noted ${f}`);
  }
  await run(`insert into public.abo_migrations (version, name, recorded_only) values ('${version}', '${q(f)}', ${recordOnly});`);
  applied++;
}
const skipped = files.filter(({ f }) => done.has(/^(\d{4})_/.exec(f)?.[1])).length;
console.log(`\n${applied} ${recordOnly ? "recorded" : "applied"}, ${skipped} skipped (already in the ledger)`);
