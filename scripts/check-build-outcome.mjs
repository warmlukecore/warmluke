// What the database is told a build did.
//
// Every caller marked a request 'built' the moment one plan landed.
// "partly built" lived only in the reply sent back to whoever was
// watching, so a request that made a section and then failed to give
// it fields is, on the record, finished. Everything read off that
// record inherits it: a history would say done, and an undo would not
// know which steps to reverse.
//
// The status is decided by the outcome now, in the one operation all
// three callers go through, and the outcome is kept.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-build-outcome.mjs

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const ref = new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0];

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const sql = async (query) => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// A project of its own, not the oldest one lying about.
//
// This used to take `order by created_at limit 1` — whatever project
// happened to be in the database. On an empty one it skipped
// silently; during a full run it borrowed another check's project,
// mid-use, and failed on state that check had left behind. Twice in
// one day it reported six red assertions about the build door while
// the door was fine.
//
// The owner is the check user, so the claims below are a real
// person's. Removed at the end either way.
const mine = await sql(`
  with who as (
    select id as user_id from auth.users where email = 'check@warmluke.test' limit 1
  ), made as (
    insert into public.projects (owner_id, name)
    select user_id, 'check build-outcome ' || floor(extract(epoch from now()))::text from who
    returning id, owner_id
  )
  select id as project_id, owner_id from made
`);
const row = mine.body?.[0];
if (!row) {
  console.log("could not make a project to test against — is the check user there?");
  process.exit(1);
}
const dropProject = () =>
  sql(`delete from public.projects where id = '${row.project_id}'`);

const stamp = Date.now().toString(36);
const made = [];

/** A fresh approved request, ready to be finished one way or another. */
const raise = async (label) => {
  const r = await sql(`
    insert into public.build_requests
      (project_id, requested_by, request, plans, status, approved_at, approved_by)
    values ('${row.project_id}', '${row.owner_id}', 'outcome check ${label} ${stamp}',
            '[]'::jsonb, 'pending', now(), '${row.owner_id}')
    returning id
  `);
  const id = r.body?.[0]?.id;
  if (id) made.push(id);
  return id;
};

/** Finishes it as the owner, through the door every caller now uses. */
const finish = (id, payload) =>
  sql(`
    select set_config('request.jwt.claims', $c$${JSON.stringify({
      sub: row.owner_id,
      role: "authenticated",
    })}$c$, false);
    set role authenticated;
    select public.abo_build('${row.project_id}'::uuid, '${id}'::uuid, 'request_built',
      '${JSON.stringify(payload)}'::jsonb) as said;
  `);

const readBack = async (id) =>
  (await sql(`select status, outcome from public.build_requests where id = '${id}'`)).body?.[0];

try {
  console.log("a build where everything worked");
  const whole = await raise("whole");
  await finish(whole, { applied: [{ changeType: "NEW_MODULE", navLabel: "X" }], errors: [] });
  const done = await readBack(whole);
  check("is written down as built", done?.status === "built");
  check("with what it built kept", (done?.outcome?.applied ?? []).length === 1);

  console.log("\nand one where half of it did not");
  const half = await raise("half");
  await finish(half, {
    applied: [{ changeType: "NEW_MODULE", navLabel: "X" }],
    errors: ["schema_insert failed"],
  });
  const partial = await readBack(half);
  // The whole point. This used to read 'built'.
  check("is not written down as built", partial?.status !== "built");
  check("it is written down as partly built", partial?.status === "partly_built");
  check("the part that worked is named", (partial?.outcome?.applied ?? []).length === 1);
  check("and so is the part that did not", (partial?.outcome?.errors ?? []).length === 1);

  console.log("\nand the caller does not get to decide which it was");
  // The old callers passed {} and the row said built regardless. A
  // caller handing over errors while claiming success is the case that
  // caused all of this: believe the errors.
  const lying = await raise("lying");
  await finish(lying, { applied: [], errors: ["nothing worked at all"] });
  const refused = await readBack(lying);
  check("errors alone still mean partly built", refused?.status === "partly_built");

  console.log("\nand a request already finished stays finished");
  const again = await finish(half, { applied: [], errors: [] });
  check(
    "a second attempt changes nothing",
    /"count"\s*:\s*0/.test(JSON.stringify(again.body ?? ""))
  );
  const still = await readBack(half);
  check("and the record of the half build survives", still?.status === "partly_built");
  check("with its errors intact", (still?.outcome?.errors ?? []).length === 1);
} finally {
  for (const id of made) await sql(`delete from public.build_requests where id = '${id}'`);
  const left = await sql(
    `select count(*)::int as n from public.build_requests where request like '%outcome check%${stamp}'`
  );
  check("nothing this check raised is left behind", left.body?.[0]?.n === 0);
}

await dropProject();

console.log(
  fails.length === 0 ? "\nthe record says what really happened" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
