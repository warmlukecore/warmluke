// When a merchant removes the app, and when Shopify asks us to erase.
//
// app/uninstalled has to be believed only from Shopify — the anon key
// is public, and so is PostgREST — and then has to let go of the dead
// token without deleting anything. shop/redact has to erase a store,
// but not one that was connected again inside the forty-eight hours
// Shopify waits before sending it: that store is not the one it means.
//
// Every scenario runs in a transaction that is rolled back, with its
// own secret, account, project and store, so the check project keeps
// no webhook secret and nothing a real run could trip over.
//
//   ENV_FILE=.env.check.local node scripts/check-uninstall.mjs

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
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const last = (res, key) => {
  const rows = Array.isArray(res.body) ? res.body : [];
  return rows.length ? rows[rows.length - 1][key] : undefined;
};
const refusedWith = (res, pattern) => res.status >= 400 && pattern.test(JSON.stringify(res.body ?? ""));

const tag = Date.now().toString(36);
const USER = "'33333333-0000-0000-0000-000000000001'::uuid";
const PROJECT = "'33333333-0000-0000-0000-000000000002'::uuid";
const STORE = "'33333333-0000-0000-0000-000000000003'::uuid";
const SHOP = `'wl-uninstall-${tag}.myshopify.com'`;
const SECRET = `'check-secret-${tag}'`;
const RAW = `'{"id":${Date.now()}}'`;

/** One store, connected at `connectedAt`, holding a token and a live lease. */
const scenario = (body, { connectedAt = "now() - interval '3 days'", status = "connected" } = {}) => `
begin;
delete from public.app_secrets where name = 'shopify_client_secret';
insert into public.app_secrets (name, value) values ('shopify_client_secret', ${SECRET});
insert into auth.users (id, instance_id, aud, role, email)
  values (${USER}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'uninstall-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name) values (${PROJECT}, ${USER}, 'check uninstall');
insert into public.stores (id, project_id, provider, shop_domain, status, access_token, refresh_token, connected_at)
  values (${STORE}, ${PROJECT}, 'shopify', ${SHOP}, '${status}', 'dead-token', 'dead-refresh', ${connectedAt});
insert into public.import_leases (store_id, ticket_hash, expires_at)
  values (${STORE}, sha256(convert_to('a-worker-ticket-${tag}-padding-to-length', 'UTF8')), now() + interval '5 minutes');
${body}
rollback;
`;
// What Shopify would send: the body signed with the app secret, at the
// store's own address.
const HMAC = `encode(extensions.hmac(${RAW}, ${SECRET}, 'sha256'), 'base64')`;
const ADDRESS = `encode(extensions.hmac(lower(${SHOP}), ${SECRET}, 'sha256'), 'hex')`;

console.log("app/uninstalled, as Shopify sends it");
const done = await sql(
  scenario(`
    set local role anon;
    select public.abo_shopify_uninstalled(${ADDRESS}, ${RAW}, ${HMAC});
    reset role;
    select s.status, s.access_token is null as token_gone, s.refresh_token is null as refresh_gone,
           (select count(*) from public.import_leases where store_id = ${STORE}) as leases,
           (select count(*) from public.stores where id = ${STORE}) as still_there
      from public.stores s where s.id = ${STORE};`)
);
check("a signed delivery at the store's address is accepted", done.status < 400);
check("the store is marked uninstalled", last(done, "status") === "uninstalled");
check("its dead token is dropped", last(done, "token_gone") === true && last(done, "refresh_gone") === true);
check("a worker mid-import is let go", Number(last(done, "leases")) === 0);
check("and nothing is deleted", Number(last(done, "still_there")) === 1);

console.log("\nand nobody else can say it");
const forged = await sql(
  scenario(`
    set local role anon;
    select public.abo_shopify_uninstalled(${ADDRESS}, ${RAW}, encode(extensions.hmac(${RAW}, 'not-the-secret', 'sha256'), 'base64'));`)
);
check("a body signed with another secret is refused", refusedWith(forged, /did not come from Shopify/));
const tampered = await sql(
  scenario(`
    set local role anon;
    select public.abo_shopify_uninstalled(${ADDRESS}, '{"id":0}', ${HMAC});`)
);
check("a body changed after signing is refused", refusedWith(tampered, /did not come from Shopify/));
const elsewhere = await sql(
  scenario(`
    set local role anon;
    select public.abo_shopify_uninstalled(encode(extensions.hmac('someone-else.myshopify.com', ${SECRET}, 'sha256'), 'hex'), ${RAW}, ${HMAC});`)
);
check("a real delivery at another store's address is refused", refusedWith(elsewhere, /Unsigned/));
const unsigned = await sql(
  scenario(`
    set local role anon;
    select public.abo_shopify_uninstalled(${ADDRESS}, ${RAW}, null);`)
);
check("an unsigned one is refused", refusedWith(unsigned, /Unsigned/));

console.log("\nshop/redact erases the store it is about");
const erased = await sql(
  scenario(`
    select public.abo_shopify_shop_redact(${SHOP}) as n;
    select (select count(*) from public.stores where id = ${STORE}) as left_behind;`)
);
check("a store connected before the uninstall is erased", Number(last(erased, "left_behind")) === 0);
const erasedUninstalled = await sql(
  scenario(
    `select public.abo_shopify_shop_redact(${SHOP}) as n;
     select (select count(*) from public.stores where id = ${STORE}) as left_behind;`,
    { status: "uninstalled", connectedAt: "now() - interval '1 hour'" }
  )
);
check(
  "so is one Shopify said was uninstalled, however recently connected",
  Number(last(erasedUninstalled, "left_behind")) === 0
);

console.log("\nand not a store connected again since");
const spared = await sql(
  scenario(
    `select public.abo_shopify_shop_redact(${SHOP}) as n;
     select (select count(*) from public.stores where id = ${STORE}) as left_behind;`,
    { connectedAt: "now() - interval '2 hours'" }
  )
);
check("a store connected inside the last 48 hours is kept", Number(last(spared, "left_behind")) === 1);
const asNobody = await sql(
  scenario(`
    set local role anon;
    select public.abo_shopify_shop_redact(${SHOP});`)
);
check("and nobody outside can ask for an erasure directly", refusedWith(asNobody, /permission denied/));

console.log(
  fails.length === 0 ? "\nremoved means removed, and erased means the right store" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
