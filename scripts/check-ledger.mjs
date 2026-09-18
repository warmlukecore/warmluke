// The repo and the database agree about which migrations exist.
//
// apply-migrations keeps a ledger, public.abo_migrations, on every
// project it touches. This asks whether that ledger and the files in
// supabase/migrations are the same list — in both directions. A file
// nobody applied, or a row for a file nobody committed, is how two
// environments quietly stop being the same thing. Needs only the
// service-role key, so it runs in CI against the check project and on
// a laptop against production.
//
//   node scripts/check-ledger.mjs

import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const { data, error } = await admin.from("abo_migrations").select("version, name");
const ledger = new Map((data ?? []).map((r) => [r.version, r.name]));
const repo = new Map([
  ["0001", "0001_schema.sql"],
  ...readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => [/^(\d{4})_/.exec(f)?.[1], f]),
]);

console.log("the ledger and the repo");
check("the ledger can be read", !error);
if (error) console.log("     →", error.message);
const unapplied = [...repo.keys()].filter((v) => !ledger.has(v));
check("every migration in the repo has been applied here", unapplied.length === 0);
if (unapplied.length) console.log("     →", unapplied.map((v) => repo.get(v)).join(", "));
const unknown = [...ledger.keys()].filter((v) => !repo.has(v));
check("and nothing was applied that the repo does not have", unknown.length === 0);
if (unknown.length) console.log("     →", unknown.map((v) => ledger.get(v)).join(", "));
const renamed = [...repo].filter(([v, f]) => ledger.has(v) && ledger.get(v) !== f).map(([, f]) => f);
check("and every one is the file it was applied as", renamed.length === 0);
if (renamed.length) console.log("     →", renamed.join(", "));

console.log(fails.length === 0 ? `\n${repo.size} migrations, here and in the repo` : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
