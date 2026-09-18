// Taking an assistant's access away, and meaning it.
//
// The mistake this guards against is subtle enough to ship: marking a
// consent revoked feels like revoking, and stops nothing. The client
// already holds a token good for ninety days, and it keeps working.
// So what is checked here is the session count, not the consent flag.
//
// Every scenario runs inside a transaction that is rolled back, with
// its own synthetic user, client and session — a real merchant's live
// connection is never touched.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-revoke.mjs

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

const MERCHANT = "'11111111-0000-0000-0000-000000000001'";
const STRANGER = "'11111111-0000-0000-0000-000000000002'";
const CLIENT = "'22222222-0000-0000-0000-000000000001'";

/** Two accounts, each with the same assistant connected. */
const setup = `
  insert into auth.users (id, instance_id, aud, role, email) values
    (${MERCHANT}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'merchant-${Date.now()}@warmluke.test'),
    (${STRANGER}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger-${Date.now()}@warmluke.test');

  insert into auth.oauth_clients (id, client_name, registration_type, redirect_uris, grant_types, client_type, token_endpoint_auth_method)
  values (${CLIENT}::uuid, 'Claude', 'dynamic', '{https://claude.ai/cb}', '{authorization_code}', 'public', 'none');

  -- oauth_consents has no default for its key, so it is given one.
  insert into auth.oauth_consents (id, user_id, client_id, scopes) values
    (gen_random_uuid(), ${MERCHANT}::uuid, ${CLIENT}::uuid, 'openid'),
    (gen_random_uuid(), ${STRANGER}::uuid, ${CLIENT}::uuid, 'openid');

  -- The token that outlives a consent flag.
  insert into auth.sessions (id, user_id, oauth_client_id, created_at, updated_at) values
    (gen_random_uuid(), ${MERCHANT}::uuid, ${CLIENT}::uuid, now(), now()),
    (gen_random_uuid(), ${STRANGER}::uuid, ${CLIENT}::uuid, now(), now());
`;

const asMerchant = (body) => `
begin;
${setup}
select set_config('request.jwt.claims', $claims$${JSON.stringify({
  sub: "11111111-0000-0000-0000-000000000001",
  role: "authenticated",
})}$claims$, true);
set local role authenticated;
${body}
rollback;
`;

const value = (res, key) => {
  const rows = Array.isArray(res.body) ? res.body : [];
  return rows.length ? rows[rows.length - 1][key] : undefined;
};

console.log("what the merchant sees");
const listed = await sql(asMerchant(`select count(*) as n from public.abo_oauth_clients();`));
check("their connected assistant is listed", Number(value(listed, "n")) === 1);

const named = await sql(asMerchant(`select name, sessions from public.abo_oauth_clients();`));
check("by name", value(named, "name") === "Claude");
check("with the session it holds", Number(value(named, "sessions")) === 1);

console.log("\ndisconnecting it");
const revoked = await sql(asMerchant(`select public.abo_oauth_revoke(${CLIENT}::uuid) as r;`));
const r = value(revoked, "r");
check("the consent is marked revoked", r?.consents === 1);
// The whole point: a consent flag alone leaves the token working.
check("and the session it was using is gone", r?.sessions === 1);

const after = await sql(
  asMerchant(`
    select public.abo_oauth_revoke(${CLIENT}::uuid);
    select count(*) as n from public.abo_oauth_clients();`)
);
check("it disappears from the list", Number(value(after, "n")) === 0);

const twice = await sql(
  asMerchant(`
    select public.abo_oauth_revoke(${CLIENT}::uuid);
    select public.abo_oauth_revoke(${CLIENT}::uuid) as r;`)
);
check("disconnecting twice changes nothing further", value(twice, "r")?.sessions === 0);

console.log("\nand nobody else's");
// The reading is done with the role put back: `authenticated` cannot
// see auth.sessions at all, so asking as the merchant would answer
// "no sessions" whether or not the stranger still had one — a check
// that passes for the wrong reason.
const others = await sql(
  asMerchant(`
    select public.abo_oauth_revoke(${CLIENT}::uuid);
    reset role;
    select count(*) as n from auth.sessions where user_id = ${STRANGER}::uuid;`)
);
check("another account keeps its session", Number(value(others, "n")) === 1);
const theirConsent = await sql(
  asMerchant(`
    select public.abo_oauth_revoke(${CLIENT}::uuid);
    reset role;
    select count(*) as n from auth.oauth_consents
     where user_id = ${STRANGER}::uuid and revoked_at is null;`)
);
check("and its consent", Number(value(theirConsent, "n")) === 1);

console.log(fails.length === 0 ? "\nrevoking revokes" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
