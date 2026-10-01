// Stores that come through an app of their own (0150), proved.
//
// First in one transaction that is rolled back, so nothing is left: the
// administrator's functions, what they refuse, that a secret is never
// read back, one store to one app, and that every delivery (webhooks,
// erasure requests, uninstall) is taken only under the secret of the app
// its store comes through: not another app's, not the main app's, and
// not at all once the app is switched off. Then the app server's side,
// lib/shopify-apps, against an app that exists for a few seconds.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-shopify-apps.mjs

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])
);
if (env.CHECK_PROJECT !== "1") throw new Error(`${envFile} is not the check project's; this writes`);
if (!env.DATABASE_URL) throw new Error(`${envFile} has no DATABASE_URL`);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const psql = (sql) => {
  const r = spawnSync("psql", [env.DATABASE_URL, "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
  });
  if (r.status !== 0) throw new Error(r.stderr.slice(0, 600));
  return Object.fromEntries(
    r.stdout
      .split("\n")
      .filter((l) => l.includes("\t"))
      .map((l) => [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)])
  );
};

const tag = randomBytes(4).toString("hex");
const hex = (s) => createHash("md5").update(s).digest("hex");
const CLIENT = hex(`client-${tag}`);
const OTHER = hex(`other-${tag}`);
const SECRET = `shpss_${hex(`secret-${tag}`)}`;
const MAIN = `main-secret-${tag}`;
const KEY = randomBytes(32).toString("hex");
const SHOP = `zz-own-${tag}.myshopify.com`;
const MAIN_SHOP = `zz-main-${tag}.myshopify.com`;
const ADMIN = "44444444-0000-0000-0000-00000000000a";
const MERCHANT = "44444444-0000-0000-0000-00000000000b";
const OUTSIDER = "44444444-0000-0000-0000-00000000000c";
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const BODY = `{"shop_domain":"${SHOP}","customer":{"id":1,"email":"z@example.com"},"orders_requested":[]}`;
/** One delivery to abo_shopify_webhook: address made with one secret, body signed with another. */
const hook = (addressSecret, bodySecret, shop = SHOP) =>
  `pg_temp.try(format($t$select public.abo_shopify_webhook(%L, 'products/delete', '{"id":1}', %L)$t$,
     encode(extensions.hmac('${"${shop}"}', '${"${addressSecret}"}', 'sha256'), 'hex'),
     encode(extensions.hmac('{"id":1}', '${"${bodySecret}"}', 'sha256'), 'base64')))`
    .replace("${shop}", shop)
    .replace("${addressSecret}", addressSecret)
    .replace("${bodySecret}", bodySecret);

const sql = `
begin;
create function pg_temp.try(t text) returns text language plpgsql as $f$
begin execute t; return 'ok'; exception when others then return 'ERR ' || sqlerrm; end $f$;
create function pg_temp.as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;
create temp table out (k text, v text);
grant all on out to public;
create function pg_temp.say(k text, v text) returns void language sql as $f$ insert into out values (k, v) $f$;

delete from public.app_secrets where name in ('shopify_client_secret', 'shopify_apps_key_sha256');
insert into public.app_secrets (name, value) values
  ('shopify_client_secret', ${q(MAIN)}),
  ('shopify_apps_key_sha256', encode(extensions.digest(${q(KEY)}, 'sha256'), 'hex'));
insert into auth.users (id, instance_id, aud, role, email) values
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'apps-admin-${tag}@warmluke.test'),
  ('${MERCHANT}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'apps-merchant-${tag}@warmluke.test'),
  ('${OUTSIDER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'apps-out-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN}', true)
  on conflict (user_id) do update set is_superadmin = true;
insert into public.projects (id, owner_id, name) values
  ('44444444-0000-0000-0000-0000000000d1', '${MERCHANT}', 'check own app'),
  ('44444444-0000-0000-0000-0000000000d2', '${MERCHANT}', 'check main app');
insert into public.stores (project_id, provider, shop_domain, status, access_token, connected_at) values
  ('44444444-0000-0000-0000-0000000000d1', 'shopify', ${q(SHOP)}, 'connected', 'tok', now()),
  ('44444444-0000-0000-0000-0000000000d2', 'shopify', ${q(MAIN_SHOP)}, 'connected', 'tok', now());

-- Who may set an app up.
select pg_temp.as('${OUTSIDER}');
select pg_temp.say('outsider_list', pg_temp.try('select public.abo_admin_shopify_apps()'));
select pg_temp.say('outsider_save', pg_temp.try($t$select public.abo_admin_shopify_app_save(null, 'x', '${CLIENT}', '${SECRET}', array['${SHOP}'], null, false, true)$t$));
select pg_temp.say('outsider_internal', pg_temp.try('select public.abo_admin_set_shopify_internal(false)'));
reset role;

select pg_temp.as('${ADMIN}');
select pg_temp.say('bad_client', pg_temp.try($t$select public.abo_admin_shopify_app_save(null, 'x', 'not-an-id', '${SECRET}', array['${SHOP}'], null, false, true)$t$));
select pg_temp.say('bad_secret', pg_temp.try($t$select public.abo_admin_shopify_app_save(null, 'x', '${CLIENT}', 'not-a-secret', array['${SHOP}'], null, false, true)$t$));
select pg_temp.say('bad_shop', pg_temp.try($t$select public.abo_admin_shopify_app_save(null, 'x', '${CLIENT}', '${SECRET}', array['mystore.com'], null, false, true)$t$));
select pg_temp.say('no_secret', pg_temp.try($t$select public.abo_admin_shopify_app_save(null, 'x', '${CLIENT}', null, array['${SHOP}'], null, false, true)$t$));
select pg_temp.say('saved', pg_temp.try($t$select public.abo_admin_shopify_app_save(null, 'Tanish', '${CLIENT}', '${SECRET}', array['https://${SHOP.toUpperCase()}/admin'], 'apps-merchant-${tag}@warmluke.test', false, true)$t$));
select pg_temp.say('listed', (public.abo_admin_shopify_apps() -> 'apps')::text);
select pg_temp.say('taken', pg_temp.try($t$select public.abo_admin_shopify_app_save(null, 'Other', '${OTHER}', '${SECRET}', array['${SHOP}'], null, false, true)$t$));
select pg_temp.say('again', pg_temp.try($t$select public.abo_admin_shopify_app_save(null, 'Dup', '${CLIENT}', '${SECRET}', array['zz-dup-${tag}.myshopify.com'], null, false, true)$t$));
reset role;
-- Its id, read as the database's owner: nobody signed in can read the table itself.
select pg_temp.say('app_id', (select id::text from public.shopify_apps where client_id = '${CLIENT}'));

select pg_temp.as('${MERCHANT}');
select pg_temp.say('merchant_app', coalesce(public.abo_my_shopify_app(), 'none'));
reset role;
select pg_temp.as('${OUTSIDER}');
select pg_temp.say('outsider_app', coalesce(public.abo_my_shopify_app(), 'none'));
reset role;

-- What the app server can read, and only with its key.
set local role anon;
select pg_temp.say('wrong_key', (select count(*)::text from public.abo_shopify_app_for(${q(SHOP)}, 'not-the-key-not-the-key-not-the-key')));
select pg_temp.say('right_key', coalesce((select client_secret from public.abo_shopify_app_for(${q(SHOP)}, ${q(KEY)})), 'none'));
select pg_temp.say('all_with_key', (select count(*)::text from public.abo_shopify_app_secrets(${q(KEY)}) where client_id = '${CLIENT}'));
select pg_temp.say('anon_secret_for', pg_temp.try($t$select public.abo_shopify_secret_for('${SHOP}')$t$));
select pg_temp.say('anon_table', pg_temp.try('select count(*) from public.shopify_apps'));

-- Deliveries: only under the store's own app's secret.
select pg_temp.say('hook_own', ${hook(SECRET, SECRET)});
select pg_temp.say('hook_body_main', ${hook(SECRET, MAIN)});
select pg_temp.say('hook_address_main', ${hook(MAIN, MAIN)});
select pg_temp.say('hook_main_store', ${hook(MAIN, MAIN, MAIN_SHOP)});
select pg_temp.say('law_own', pg_temp.try(format($t$select public.abo_shopify_compliance('customers/data_request', %L, %L)$t$,
  ${q(BODY)}, encode(extensions.hmac(${q(BODY)}, '${SECRET}', 'sha256'), 'base64'))));
select pg_temp.say('law_main', pg_temp.try(format($t$select public.abo_shopify_compliance('customers/data_request', %L, %L)$t$,
  ${q(BODY)}, encode(extensions.hmac(${q(BODY)}, '${MAIN}', 'sha256'), 'base64'))));
reset role;

-- Switched off: nothing of its store's is taken, and the server is told it is off.
select pg_temp.as('${ADMIN}');
select pg_temp.say('off', pg_temp.try($t$select public.abo_admin_shopify_app_save((select v::uuid from out where k = 'app_id'), 'Tanish', '${CLIENT}', null, array['${SHOP}'], null, false, false)$t$));
reset role;
set local role anon;
select pg_temp.say('hook_off', ${hook(SECRET, SECRET)});
select pg_temp.say('server_off', coalesce((select enabled::text || '/' || coalesce(client_secret, 'no secret') from public.abo_shopify_app_for(${q(SHOP)}, ${q(KEY)})), 'none'));
reset role;
select pg_temp.as('${ADMIN}');
select pg_temp.say('on_again', pg_temp.try($t$select public.abo_admin_shopify_app_save((select v::uuid from out where k = 'app_id'), 'Tanish', '${CLIENT}', null, array['${SHOP}'], null, false, true)$t$));
select pg_temp.say('delete_connected', pg_temp.try($t$select public.abo_admin_shopify_app_delete((select v::uuid from out where k = 'app_id'))$t$));
reset role;

-- Uninstalled through its own app, then it can go, its secret with it.
set local role anon;
select pg_temp.say('uninstall_own', pg_temp.try(format($t$select public.abo_shopify_uninstalled(%L, '{"id":1}', %L)$t$,
  encode(extensions.hmac('${SHOP}', '${SECRET}', 'sha256'), 'hex'),
  encode(extensions.hmac('{"id":1}', '${SECRET}', 'sha256'), 'base64'))));
reset role;
select pg_temp.say('store_after', (select status from public.stores where shop_domain = '${SHOP}'));
select pg_temp.as('${ADMIN}');
select pg_temp.say('deleted', pg_temp.try($t$select public.abo_admin_shopify_app_delete((select v::uuid from out where k = 'app_id'))$t$));
select pg_temp.say('internal_off', pg_temp.try('select public.abo_admin_set_shopify_internal(false)'));
select pg_temp.say('internal_now', public.abo_shopify_internal()::text);
reset role;
select pg_temp.say('vault_after', (select count(*)::text from vault.secrets where name = 'shopify_app_secret:${CLIENT}'));

select k, v from out;
rollback;
`;

const r = psql(sql);
console.log("who may set an app up");
check(
  "someone who is not an administrator cannot list them",
  (r.outsider_list ?? "").startsWith("ERR Not an administrator")
);
check("nor add one", (r.outsider_save ?? "").startsWith("ERR Not an administrator"));
check("nor switch internal mode", (r.outsider_internal ?? "").startsWith("ERR Not an administrator"));

console.log("\nwhat is refused, and why");
check("a client ID that is not one", /client ID/.test(r.bad_client));
check("a secret that is not one", /secret is not one/.test(r.bad_secret));
check("a store address that is not Shopify's", /myshopify\.com/.test(r.bad_shop));
check("a new app with no secret", /needs its secret/.test(r.no_secret));
check("an app saved, its store read from an admin link", r.saved === "ok" && (r.listed ?? "").includes(SHOP));
check("its secret is never read back", !(r.listed ?? "").includes(SECRET));
check("a store already under another app", /already comes through/.test(r.taken));
check("the same app twice", /already here/.test(r.again));

console.log("\nwho it is for");
check("its merchant's Connect opens it", r.merchant_app === CLIENT);
check("nobody else's does", r.outsider_app === "none");

console.log("\nwhat the app server can read");
check("nothing without its key", r.wrong_key === "0");
check("the store's own secret with it", r.right_key === SECRET);
check("and every app that is on", r.all_with_key === "1");
check(
  "the public key cannot ask the database for a secret",
  (r.anon_secret_for ?? "").startsWith("ERR permission denied")
);
check("nor read the apps at the table", (r.anon_table ?? "").startsWith("ERR permission denied"));

console.log("\ndeliveries, only under the store's own app");
check("a webhook signed by its own app is taken", r.hook_own === "ok");
check("its body signed with the main app's secret is not", /did not come from Shopify/.test(r.hook_body_main));
check("nor its address made with the main app's", /Unsigned/.test(r.hook_address_main));
check("a store of the main app's is taken as before", r.hook_main_store === "ok");
check("an erasure request signed by its own app is taken", r.law_own === "ok");
check("one naming it, signed with the main app's secret, is not", /did not come from Shopify/.test(r.law_main));

console.log("\nswitched off, and taken away");
check(
  "switched off, its store's webhooks are refused",
  r.off === "ok" && /^ERR (Unsigned|Webhooks are not configured)/.test(r.hook_off)
);
check("and the server is told it is off, with no secret", r.server_off === "false/no secret");
check(
  "it cannot be deleted while its store is connected",
  r.on_again === "ok" && /still connected/.test(r.delete_connected)
);
check("its uninstall arrives under its own secret", r.uninstall_own === "ok" && r.store_after === "uninstalled");
check("then it goes, and its secret with it", r.deleted === "ok" && r.vault_after === "0");
check("internal mode is the administrator's to switch", r.internal_off === "ok" && r.internal_now === "false");

// ── The app server's side, against an app that lives a few seconds ──
console.log("\nlib/shopify-apps, as the routes use it");
const { appForShop, allApps, firstThatSigned, AppSwitchedOff } = await import("../src/lib/shopify-apps.ts");
const was = psql(
  `select 'hash', coalesce((select value from public.app_secrets where name = 'shopify_apps_key_sha256'), '');`
).hash;
const ADMIN_LIVE = "44444444-0000-0000-0000-0000000000aa";
const asAdmin = `select set_config('request.jwt.claims', json_build_object('sub', '${ADMIN_LIVE}', 'role', 'authenticated')::text, false);`;
const setup = `
insert into public.app_secrets (name, value) values ('shopify_apps_key_sha256', encode(extensions.digest(${q(KEY)}, 'sha256'), 'hex'))
  on conflict (name) do update set value = excluded.value;
insert into auth.users (id, instance_id, aud, role, email) values ('${ADMIN_LIVE}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'apps-live-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN_LIVE}', true) on conflict (user_id) do update set is_superadmin = true;
${asAdmin}
select 'id', public.abo_admin_shopify_app_save(null, 'Live check', '${CLIENT}', '${SECRET}', array['${SHOP}'], null, true, true);
`;
const teardown = `
delete from vault.secrets where name = 'shopify_app_secret:${CLIENT}';
delete from public.shopify_apps where client_id = '${CLIENT}';
delete from public.account_settings where user_id = '${ADMIN_LIVE}';
delete from auth.users where id = '${ADMIN_LIVE}';
${
  was
    ? `update public.app_secrets set value = ${q(was)} where name = 'shopify_apps_key_sha256';`
    : "delete from public.app_secrets where name = 'shopify_apps_key_sha256';"
}
`;
const libEnv = {
  NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL: env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY,
  SHOPIFY_CLIENT_ID: hex(`main-${tag}`),
  SHOPIFY_CLIENT_SECRET: MAIN,
  SHOPIFY_APPS_KEY: KEY,
};
try {
  psql(setup);
  const own = await appForShop(SHOP, libEnv);
  check(
    "a store with its own app gets that app",
    own?.clientId === CLIENT && own?.clientSecret === SECRET && own?.own === true
  );
  check("with what it was given", own?.allOrders === true);
  const main = await appForShop(MAIN_SHOP, libEnv);
  check("a store without one gets the main app", main?.clientId === libEnv.SHOPIFY_CLIENT_ID && main?.own === false);
  const keyless = await appForShop(SHOP, { ...libEnv, SHOPIFY_APPS_KEY: undefined });
  check("without the server key there are no apps of a store's own", keyless?.own === false);
  const every = await allApps(libEnv);
  check(
    "a delivery may be signed by the main app or its own",
    every.some((a) => !a.own) && every.some((a) => a.clientId === CLIENT)
  );
  const signed = await firstThatSigned((s) => {
    if (s !== SECRET) throw new Error("no");
  }, libEnv);
  check("and the one that signed it is found", signed?.clientId === CLIENT);
  psql(`${asAdmin}
    select 'off', public.abo_admin_shopify_app_save((select id from public.shopify_apps where client_id = '${CLIENT}'), 'Live check', '${CLIENT}', null, array['${SHOP}'], null, true, false);`);
  const off = await appForShop(SHOP, libEnv).then(
    () => "taken",
    (e) => (e instanceof AppSwitchedOff ? "switched off" : String(e))
  );
  check("a store whose app is off is never sent through the main app instead", off === "switched off");
} finally {
  psql(teardown);
}
const left = psql(`select 'n', (select count(*) from public.shopify_apps where client_id = '${CLIENT}')::text;`).n;
check("nothing of it is left behind", left === "0");

if (fails.length) {
  console.log(`\n${fails.length} FAILED`);
  process.exit(1);
}
console.log("\na store comes through its own app, and only its own");
