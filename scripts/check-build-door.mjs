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
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
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

/**
 * The same request, after somebody said yes.
 *
 * Pending is the word for nobody having answered yet, and 0047 stopped
 * treating it as permission. A stamp is what a client now has to find
 * already there — it cannot make its own unless the merchant left
 * auto-build on.
 */
const approved = (clientId) => `
  ${pending(clientId)}
  update public.build_requests
     set approved_at = now(), approved_by = '${row.owner_id}'
   where id = '11111111-1111-1111-1111-111111111111';
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
  "cannot build against a pending request it raised",
  failed(await scenario("claude-test", pending("claude-test"), mk(REQ)))
);
check(
  "can build against one the merchant approved",
  !failed(await scenario("claude-test", approved("claude-test"), mk(REQ)))
);
check(
  "cannot build against another client's request",
  failed(await scenario("claude-test", approved("some-other-client"), mk(REQ)))
);
check(
  "cannot build against a request already built",
  failed(
    await scenario(
      "claude-test",
      approved("claude-test") +
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
      approved("claude-test") +
        `update public.build_requests set status = 'dismissed' where id = ${REQ};`,
      mk(REQ)
    )
  )
);

console.log("\nbut it never opens onto removal");
check(
  "a client cannot remove a section, approved request or not",
  failed(
    await scenario(
      "claude-test",
      approved("claude-test"),
      mk(REQ, "module_delete", `'{"module_id":"${row.project_id}"}'::jsonb`)
    )
  )
);
check(
  "while the app still can",
  !failed(
    await scenario(
      null,
      "",
      mk("null::uuid", "module_delete", `'{"module_id":"${row.project_id}"}'::jsonb`)
    )
  )
);

console.log("\na section over the store is the store's");
check(
  "a table nobody has is refused",
  failed(
    await scenario(
      null,
      "",
      mk(
        "null::uuid",
        "module_insert",
        `'{"name":"s","nav_label":"S","route":"/modules/s","source_table":"invoices"}'::jsonb`
      )
    )
  )
);
// A section over the store needs a store. The scenario brings its
// own, inside the transaction that is rolled back: this used to lean
// on whichever project happened to be oldest having one left behind
// by an earlier run, and passed or failed by what a crash had left.
const withStore = `
  insert into public.stores (project_id, shop_domain, status, currency, timezone)
  values ('${row.project_id}', 'door-${Date.now().toString(36)}.myshopify.com', 'connected', 'INR', 'Asia/Kolkata');
`;
check(
  "one of the four is built",
  !failed(
    await scenario(
      null,
      withStore,
      mk(
        "null::uuid",
        "module_insert",
        `'{"name":"s","nav_label":"S","route":"/modules/s","source_table":"products"}'::jsonb`
      )
    )
  )
);
check(
  "and nothing can be seeded into it",
  failed(
    await scenario(
      null,
      `insert into public.modules (id, project_id, name, nav_label, route, source_table)
       values ('55555555-5555-5555-5555-555555555555', '${row.project_id}', 'from-store', 'From Store', '/modules/from-store', 'products');`,
      mk(
        "null::uuid",
        "records_insert",
        `'{"module_id":"55555555-5555-5555-5555-555555555555","rows":[{"a":1}]}'::jsonb`
      )
    )
  )
);

console.log("\nan approval is spent once");
const twice = await scenario(
  "claude-test",
  approved("claude-test"),
  `select public.abo_build('${row.project_id}'::uuid, ${REQ}, 'request_claim', '{}'::jsonb) as first;
   select public.abo_build('${row.project_id}'::uuid, ${REQ}, 'request_claim', '{}'::jsonb) as second;`
);
check("a second claim on the same request builds nothing", said(twice, '"count":0'));
const spent = await scenario(
  "claude-test",
  approved("claude-test"),
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

// The stamp itself, which nothing in this suite ever ran as a client.
//
// Every check that exercised auto-build signed in as the owner, and
// this function's whole client branch is skipped when there is no
// client_id claim. So a five-a-day ceiling sat in it, unseen, while a
// check called "the sixth automatic build of the day still goes in"
// passed — because the sixth build in that check was never made by a
// client. The blind spot mattered more than the ceiling did.
console.log("\nand the stamp a client asks for");
const OK = (res) => /"approved"\s*:\s*true/.test(JSON.stringify(res.body ?? ""));
const nod = (req = REQ) => `select public.abo_approve_request(${req});`;
const autoOff = `update public.projects set auto_build = false where id = '${row.project_id}';`;
const autoOn = `update public.projects set auto_build = true where id = '${row.project_id}';`;
/** n automatic builds already made today, as the ceiling used to count them. */
const alreadyBuilt = (n) => `
  insert into public.build_requests (project_id, requested_by, client_id, request, plans, status, auto_built, built_at)
  select '${row.project_id}', '${row.owner_id}', 'claude-test', 'earlier ' || g, '[]'::jsonb, 'built', true, now()
    from generate_series(1, ${n}) g;
`;

check(
  "with the setting off, a client cannot stamp its own",
  !OK(await scenario("claude-test", autoOff + pending("claude-test"), nod()))
);
check(
  "with it on, it can",
  OK(await scenario("claude-test", autoOn + pending("claude-test"), nod()))
);
// The one 0076 exists for. Six already built today used to make this
// a no, while the screen said nothing waits.
check(
  "and the sixth of the day is not refused",
  OK(await scenario("claude-test", autoOn + alreadyBuilt(6) + pending("claude-test"), nod()))
);
check(
  "nor the fiftieth",
  OK(await scenario("claude-test", autoOn + alreadyBuilt(50) + pending("claude-test"), nod()))
);
// What the cap was standing in for is still here.
check(
  "but not another client's request",
  !OK(await scenario("claude-test", autoOn + pending("some-other-client"), nod()))
);
check(
  "nor one that does not exist",
  !OK(await scenario("claude-test", autoOn, nod()))
);
// The merchant tapping Build in Warmluke is not automation and was
// never capped — it must not start being.
check(
  "and the merchant's own yes is never refused",
  OK(await scenario(null, autoOff + alreadyBuilt(50) + pending(null), nod()))
);

console.log(fails.length === 0 ? "\nthe one door holds" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
