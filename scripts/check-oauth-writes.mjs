// A token handed to somebody's AI must not be able to change anything.
//
// Supabase's OAuth server issues an ordinary user session token — the
// only difference is a client_id claim. So a connected client does not
// have to go through /api/mcp: it can call the database directly. The
// consent screen promises it cannot change anything, and this is what
// makes that promise true rather than decorative.
//
// Run the way the database evaluates it: set the JWT claims, become
// the authenticated role, try to write. Every statement happens inside
// a transaction that is rolled back, so nothing here survives.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-oauth-writes.mjs

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const REF = new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0];

const sql = (query) =>
  fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// A real owner and a real project, so the ordinary policies pass and
// the only thing that can refuse is the OAuth restriction.
const who = await sql(`
  select p.id as project_id, p.owner_id, m.id as module_id
    from public.projects p
    left join public.modules m on m.project_id = p.id
   order by p.created_at limit 1
`);
const row = who.body?.[0];
if (!row) {
  console.log("no project to test against — nothing to check");
  process.exit(0);
}

/** Runs `body` as the authenticated role, with or without a client_id. */
const asUser = (clientId, body) => `
begin;
-- Dollar-quoted: JSON is full of double quotes, and in SQL those mean
-- an identifier rather than a string.
select set_config('request.jwt.claims', $claims$${JSON.stringify({
  sub: row.owner_id,
  role: "authenticated",
  ...(clientId ? { client_id: clientId } : {}),
})}$claims$, true);
set local role authenticated;
${body}
rollback;
`;

/** How many rows a write touched, surfaced through a deliberate abort. */
const rowsTouched = async (clientId, statement) => {
  const res = await sql(
    asUser(
      clientId,
      `do $$
       declare n integer;
       begin
         ${statement}
         get diagnostics n = row_count;
         raise exception 'rows=%', n;
       end $$;`
    )
  );
  const m = JSON.stringify(res.body).match(/rows=(\d+)/);
  return m ? Number(m[1]) : null;
};

console.log("the same account, signed in to the app");
const appInsert = await sql(
  asUser(null, `insert into public.projects (name) values ('written by the app');`)
);
// If this fails the restriction is too wide and the app itself is
// broken — the more dangerous of the two mistakes.
check("can still create a project", appInsert.status === 201);

console.log("\nthe same account, through a token given to an AI client");
const oauthInsert = await sql(
  asUser("claude-test", `insert into public.projects (name) values ('written by a client');`)
);
check("cannot create a project", oauthInsert.status !== 201);

// A write refused by a policy affects no rows rather than raising, so
// the count is what has to be checked — not the status.
check(
  "cannot rename one",
  (await rowsTouched(
    "claude-test",
    `update public.projects set name = 'renamed' where id = '${row.project_id}';`
  )) === 0
);
check(
  "cannot delete one",
  (await rowsTouched(
    "claude-test",
    `delete from public.projects where id = '${row.project_id}';`
  )) === 0
);
check(
  "cannot disconnect the store",
  (await rowsTouched(
    "claude-test",
    `delete from public.stores where project_id = '${row.project_id}';`
  )) === 0
);

if (row.module_id) {
  const rec = await sql(
    asUser(
      "claude-test",
      `insert into public.records (module_id, project_id, data)
       values ('${row.module_id}', '${row.project_id}', '{}'::jsonb);`
    )
  );
  check("cannot add a row to a section", rec.status !== 201);
}

console.log("\nbut reading is the whole point");
const read = await sql(asUser("claude-test", `select count(*) as n from public.orders;`));
check("can still read orders", read.status === 201);
check("and sees them", JSON.stringify(read.body).includes('"n"'));

console.log("\nand the app itself is untouched");
check(
  "a signed-in owner can still rename their project",
  (await rowsTouched(
    null,
    `update public.projects set name = name where id = '${row.project_id}';`
  )) === 1
);

console.log(
  fails.length === 0 ? "\na client's token can read and cannot write" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
