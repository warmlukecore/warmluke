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
if (!env.SUPABASE_ACCESS_TOKEN) {
  console.log("no SUPABASE_ACCESS_TOKEN in", envFile, "— migrations are applied through the management API");
  process.exit(2);
}

const sql = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body;
};

await sql(`
  create table if not exists public.abo_migrations (
    version       text primary key,
    name          text not null,
    applied_at    timestamptz not null default now(),
    -- true when the ledger was written after the fact, for a migration
    -- that had already run by hand
    recorded_only boolean not null default false
  );
  alter table public.abo_migrations enable row level security;
`);
const done = new Set((await sql("select version from public.abo_migrations")).map((r) => r.version));

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
      await sql(readFileSync(url, "utf8"));
    } catch (e) {
      console.log(`FAIL  ${f}\n      ${e.message}`);
      console.log(`\nstopped at ${f}; ${applied} applied this run. Fix and rerun — what landed is in the ledger.`);
      process.exit(1);
    }
    console.log(`ok    ${f}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } else {
    console.log(`noted ${f}`);
  }
  await sql(`insert into public.abo_migrations (version, name, recorded_only) values ('${version}', '${q(f)}', ${recordOnly})`);
  applied++;
}
console.log(`\n${applied} ${recordOnly ? "recorded" : "applied"}, ${files.length - applied - done.size} skipped (already in the ledger)`);
