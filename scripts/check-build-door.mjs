// abo_build is the only way a write reaches the builder's tables, and
// the only hole in the wall 0028 put up. So this is the file that has
// to be right: a token handed to somebody's AI may build exactly what
// the merchant approved, once, and nothing else.
//
// Everything runs as the database evaluates it — real claims, the
// authenticated role — inside transactions that are rolled back.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-build-door.mjs

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

const who = await sql(`
  select p.id as project_id, p.owner_id
    from public.projects p order by p.created_at limit 1
`);
const row = who.body?.[0];
if (!row) {
  console.log("no project to test against — nothing to check");
  process.exit(0);
}

const claims = (clientId) =>
  JSON.stringify({
    sub: row.owner_id,
    role: "authenticated",
    ...(clientId ? { client_id: clientId } : {}),
  });

/**
 * Runs one scenario in a rolled-back transaction. `setup` runs as the
 * owner of the database (so a request row can exist before the caller
 * is downgraded); `body` runs as the authenticated role.
 */
const scenario = (clientId, setup, body) =>
  sql(`
begin;
${setup}
select set_config('request.jwt.claims', $claims$${claims(clientId)}$claims$, true);
set local role authenticated;
${body}
rollback;
`);

/** A pending request, as propose_change would have left it. */
const pending = (clientId) => `
  insert into public.build_requests (id, project_id, requested_by, client_id, request, plans, status)
  values ('11111111-1111-1111-1111-111111111111', '${row.project_id}', '${row.owner_id}',
          ${clientId ? `'${clientId}'` : "null"}, 'a test request', '[]'::jsonb, 'pending');
`;

const REQ = "'11111111-1111-1111-1111-111111111111'::uuid";
const mk = (req, op = "module_insert", payload = `'{"name":"door-test","nav_label":"Door","route":"/modules/door-test"}'::jsonb`) =>
  `select public.abo_build('${row.project_id}'::uuid, ${req}, '${op}', ${payload});`;

const failed = (res) => res.status !== 201;
const said = (res, needle) => JSON.stringify(res.body ?? "").includes(needle);

console.log("the app itself, signed in as the owner");
check("can build without naming a request", !failed(await scenario(null, "", mk("null::uuid"))));

console.log("\na token given to an AI client");
check("cannot build with no request", failed(await scenario("claude-test", "", mk("null::uuid"))));
check(
  "cannot build against a request that does not exist",
  failed(await scenario("claude-test", "", mk(REQ)))
);
check(
  "can build against a pending request it raised",
  !failed(await scenario("claude-test", pending("claude-test"), mk(REQ)))
);
check(
  "cannot build against another client's request",
  failed(await scenario("claude-test", pending("some-other-client"), mk(REQ)))
);
check(
  "cannot build against a request already built",
  failed(
    await scenario(
      "claude-test",
      pending("claude-test") +
        `update public.build_requests set status = 'built' where id = ${REQ};`,
      mk(REQ)
    )
  )
);
check(
  "cannot build against a dismissed request",
  failed(
    await scenario(
      "claude-test",
      pending("claude-test") +
        `update public.build_requests set status = 'dismissed' where id = ${REQ};`,
      mk(REQ)
    )
  )
);

console.log("\nan approval is spent once");
const twice = await scenario(
  "claude-test",
  pending("claude-test"),
  `select public.abo_build('${row.project_id}'::uuid, ${REQ}, 'request_claim', '{}'::jsonb) as first;
   select public.abo_build('${row.project_id}'::uuid, ${REQ}, 'request_claim', '{}'::jsonb) as second;`
);
check("a second claim on the same request builds nothing", said(twice, '"count":0'));
const spent = await scenario(
  "claude-test",
  pending("claude-test"),
  `select public.abo_build('${row.project_id}'::uuid, ${REQ}, 'request_built', '{}'::jsonb);
   ${mk(REQ)}`
);
check("writing after the request is marked built is refused", failed(spent));

console.log("\nand the door only opens onto this project");
check(
  "an op nobody wrote is refused",
  failed(await scenario(null, "", mk("null::uuid", "drop_everything", "'{}'::jsonb")))
);
// A stranger's app, made here rather than hoped for: a check that
// quietly skips itself is a check that was never run.
const STRANGER = "'22222222-2222-2222-2222-222222222222'";
const OTHER_PROJECT = "'33333333-3333-3333-3333-333333333333'";
const OTHER_MODULE = "'44444444-4444-4444-4444-444444444444'";
const stranger = `
  insert into auth.users (id, instance_id, aud, role, email)
  values (${STRANGER}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'stranger-${Date.now()}@warmluke.test');
  insert into public.projects (id, owner_id, name)
  values (${OTHER_PROJECT}::uuid, ${STRANGER}::uuid, 'someone else');
  insert into public.modules (id, project_id, name, nav_label, route)
  values (${OTHER_MODULE}::uuid, ${OTHER_PROJECT}::uuid, 'theirs', 'Theirs', '/modules/theirs');
`;

check(
  "cannot build inside somebody else's project",
  failed(
    await sql(`
begin;
${stranger}
select set_config('request.jwt.claims', $claims$${claims(null)}$claims$, true);
set local role authenticated;
select public.abo_build(${OTHER_PROJECT}::uuid, null::uuid, 'module_insert', '{"name":"x","nav_label":"X","route":"/modules/x"}'::jsonb);
rollback;`)
  )
);
check(
  "cannot write a schema onto another app's section",
  failed(
    await scenario(
      null,
      stranger,
      mk(
        "null::uuid",
        "schema_insert",
        `'{"module_id":${OTHER_MODULE},"schema_json":{"columns":[]},"version":1}'::jsonb`
      )
    )
  )
);
check(
  "cannot seed rows into another app's section",
  failed(
    await scenario(
      null,
      stranger,
      mk("null::uuid", "records_insert", `'{"module_id":${OTHER_MODULE},"rows":[{"a":1}]}'::jsonb`)
    )
  )
);

console.log(fails.length === 0 ? "\nthe one door holds" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
