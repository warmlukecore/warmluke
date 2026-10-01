// A merchant's own Shopify app (0156), against the check database, in one
// transaction that is rolled back.
//
// Anybody may set an app up for any store, and nobody is blocked by it:
// a claim decides only which app that person's connection goes through.
// Shopify's own completed install is what makes an app the one a store
// came through, and only the store owner's own app (or an administrator's)
// may complete it. These are the rules a stranger would try first.
//
//   ENV_FILE=.env.check.local node scripts/check-own-apps.mjs

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
const A = "66666666-0000-0000-0000-00000000000a";
const B = "66666666-0000-0000-0000-00000000000b";
const ADMIN = "66666666-0000-0000-0000-00000000000c";
const PA = "66666666-0000-0000-0000-0000000000d1";
const SHOP = `zz-own-${tag}.myshopify.com`;
const SHOP2 = `zz-own2-${tag}.myshopify.com`;
const CA = hex(`a-${tag}`);
const CB = hex(`b-${tag}`);
const CADMIN = hex(`admin-${tag}`);
const SA = `shpss_${hex(`sa-${tag}`)}`;
const SB = `shpss_${hex(`sb-${tag}`)}`;
const MAIN = `main-${tag}`;
const KEY = randomBytes(32).toString("hex");
const NOT_KEY = "not-the-key-not-the-key-not-the-key";

const sql = `
begin;
create function pg_temp.try(t text) returns text language plpgsql as $f$
declare v text;
begin execute t into v; return coalesce(v, 'ok'); exception when others then return 'ERR ' || sqlerrm; end $f$;
create function pg_temp.as(uid uuid, client text default null) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('sub', uid, 'role', 'authenticated')
      || case when client is null then '{}'::jsonb else jsonb_build_object('client_id', client) end)::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;
create temp table out (k text, v text);
grant all on out to public;
create function pg_temp.say(k text, v text) returns void language sql as $f$ insert into out values (k, v) $f$;

delete from public.app_secrets where name in ('shopify_client_secret', 'shopify_apps_key_sha256');
insert into public.app_secrets (name, value) values
  ('shopify_client_secret', '${MAIN}'),
  ('shopify_apps_key_sha256', encode(extensions.digest('${KEY}', 'sha256'), 'hex'));
insert into auth.users (id, instance_id, aud, role, email) values
  ('${A}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'own-a-${tag}@warmluke.test'),
  ('${B}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'own-b-${tag}@warmluke.test'),
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'own-admin-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN}', true)
  on conflict (user_id) do update set is_superadmin = true;
insert into public.projects (id, owner_id, name) values ('${PA}', '${A}', 'check own app');
-- A's connection of the store, part way: Shopify has not answered yet.
insert into public.stores (project_id, provider, shop_domain, status, oauth_state, oauth_state_expires_at)
values ('${PA}', 'shopify', '${SHOP}', 'pending', 'state-a-${tag}', now() + interval '10 minutes');

-- What a save refuses.
select pg_temp.as('${A}');
select pg_temp.say('bad_shop', pg_temp.try($t$select public.abo_my_shopify_app_save('${CA}', '${SA}', 'mystore.com', false)::text$t$));
select pg_temp.say('bad_client', pg_temp.try($t$select public.abo_my_shopify_app_save('not-an-id', '${SA}', '${SHOP}', false)::text$t$));
select pg_temp.say('bad_secret', pg_temp.try($t$select public.abo_my_shopify_app_save('${CA}', 'nope', '${SHOP}', false)::text$t$));
select pg_temp.say('no_secret', pg_temp.try($t$select public.abo_my_shopify_app_save('${CA}', null, '${SHOP}', false)::text$t$));
reset role;
select pg_temp.as('${A}', 'an-ai-client');
select pg_temp.say('ai_client', pg_temp.try($t$select public.abo_my_shopify_app_save('${CA}', '${SA}', '${SHOP}', false)::text$t$));
reset role;

-- A sets one up; B sets one up for the same store, and another; nobody is blocked.
select pg_temp.as('${A}');
select pg_temp.say('a_saved', pg_temp.try($t$select public.abo_my_shopify_app_save('${CA}', '${SA}', 'https://${SHOP.toUpperCase()}/admin', false) ->> 'shop'$t$));
select pg_temp.say('a_lists', (public.abo_my_shopify_apps())::text);
reset role;
select pg_temp.as('${B}');
select pg_temp.say('b_saved', pg_temp.try($t$select public.abo_my_shopify_app_save('${CB}', '${SB}', '${SHOP}', false) ->> 'shop'$t$));
select pg_temp.say('b_second', pg_temp.try($t$select public.abo_my_shopify_app_save('${CB}', null, '${SHOP2}', false) ->> 'shop'$t$));
select pg_temp.say('b_takes_a', pg_temp.try($t$select public.abo_my_shopify_app_save('${CA}', '${SB}', '${SHOP2}', false)::text$t$));
reset role;
select pg_temp.say('a_owner', (select (owner_id = '${A}')::text from public.shopify_apps where client_id = '${CA}'));
select pg_temp.say('a_vault', (select count(*)::text from vault.secrets where name = 'shopify_app_secret:${CA}'));

-- Whose connection goes through which app.
select pg_temp.as('${A}');
select pg_temp.say('a_goes', (select client_id from public.abo_my_shopify_app_for('${SHOP}')));
reset role;
select pg_temp.as('${B}');
select pg_temp.say('b_goes', (select client_id from public.abo_my_shopify_app_for('${SHOP}')));
reset role;

-- What the app server may read, with its key, and what it may do.
set local role anon;
select pg_temp.say('candidates', (select string_agg(client_id, ',' order by client_id) from public.abo_shopify_apps_for('${SHOP}', '${KEY}')));
select pg_temp.say('candidates_no_key', (select count(*)::text from public.abo_shopify_apps_for('${SHOP}', '${NOT_KEY}')));
select pg_temp.say('claim_a', public.abo_shopify_claim_ok('${SHOP}', '${CA}', 'state-a-${tag}', '${KEY}')::text);
select pg_temp.say('claim_b', public.abo_shopify_claim_ok('${SHOP}', '${CB}', 'state-a-${tag}', '${KEY}')::text);
select pg_temp.say('claim_main', public.abo_shopify_claim_ok('${SHOP}', null, 'state-a-${tag}', '${KEY}')::text);
select pg_temp.say('claim_no_key', public.abo_shopify_claim_ok('${SHOP}', '${CA}', 'state-a-${tag}', '${NOT_KEY}')::text);
reset role;

-- Before anything connected: the store answers to the main app.
select pg_temp.say('secret_before', public.abo_shopify_secret_for('${SHOP}'));
set local role anon;
select pg_temp.say('through_a', public.abo_shopify_came_through('${SHOP}', '${CA}', '${KEY}')::text);
reset role;
select pg_temp.say('secret_after_a', public.abo_shopify_secret_for('${SHOP}'));
select pg_temp.say('app_for_after_a', (select client_id from public.abo_shopify_app_for('${SHOP}', '${KEY}')));
set local role anon;
select pg_temp.say('through_main', public.abo_shopify_came_through('${SHOP}', null, '${KEY}')::text);
reset role;
select pg_temp.say('secret_after_main', public.abo_shopify_secret_for('${SHOP}'));
set local role anon;
select public.abo_shopify_came_through('${SHOP}', '${CA}', '${KEY}');
reset role;

-- An administrator is stopped by the app a store came through, not by a claim.
select pg_temp.as('${ADMIN}');
select pg_temp.say('admin_on_verified', pg_temp.try($t$select public.abo_admin_shopify_app_save(null, 'Admin', '${CADMIN}', '${SA}', array['${SHOP}'], 'own-a-${tag}@warmluke.test', false, true)::text$t$));
select pg_temp.say('admin_on_claimed', pg_temp.try($t$select (public.abo_admin_shopify_app_save(null, 'Admin', '${CADMIN}', '${SA}', array['${SHOP2}'], 'own-b-${tag}@warmluke.test', false, true) is not null)::text$t$));
reset role;

-- A store connected to A's account is not B's to claim.
update public.stores set status = 'connected', connected_at = now(), oauth_state = null where project_id = '${PA}';
select pg_temp.as('${B}');
select pg_temp.say('b_on_connected', pg_temp.try($t$select public.abo_my_shopify_app_save('${CB}', null, '${SHOP}', false)::text$t$));
reset role;

-- An app a connected store came through stays, until the store goes.
-- Its id, as the merchant's own list gives it them.
select set_config('own.a_app', (select id::text from public.shopify_apps where client_id = '${CA}'), true);
select pg_temp.as('${A}');
select pg_temp.say('delete_live', pg_temp.try($t$select public.abo_my_shopify_app_delete(current_setting('own.a_app')::uuid)::text$t$));
reset role;
select pg_temp.as('${B}');
select pg_temp.say('delete_not_mine', pg_temp.try($t$select public.abo_my_shopify_app_delete(current_setting('own.a_app')::uuid)::text$t$));
reset role;
update public.stores set status = 'uninstalled' where project_id = '${PA}';
select pg_temp.as('${A}');
select pg_temp.say('delete_gone', pg_temp.try($t$select public.abo_my_shopify_app_delete(current_setting('own.a_app')::uuid)::text$t$));
reset role;
select pg_temp.say('vault_after_delete', (select count(*)::text from vault.secrets where name = 'shopify_app_secret:${CA}'));

-- An account going takes its apps, and their secrets, with it.
delete from auth.users where id = '${B}';
select pg_temp.say('b_app_after', (select count(*)::text from public.shopify_apps where client_id = '${CB}'));
select pg_temp.say('b_vault_after', (select count(*)::text from vault.secrets where name = 'shopify_app_secret:${CB}'));

select k, v from out;
rollback;
`;

const r = psql(sql);
let listed = null;
try {
  listed = JSON.parse(r.a_lists ?? "null");
} catch {
  listed = null;
}

console.log("what a merchant's save refuses");
check("an address that is not a store's", (r.bad_shop ?? "").includes("not a store's Shopify address"));
check("a client ID that is not one", (r.bad_client ?? "").includes("client ID is not one"));
check("a secret that is not one", (r.bad_secret ?? "").includes("secret is not one"));
check("a new app without its secret", (r.no_secret ?? "").includes("client secret too"));
check("their own AI setting it up", (r.ai_client ?? "").includes("in Warmluke itself"));

console.log("\nanybody may set one up, and nobody is blocked by it");
check("a store's owner sets theirs up, however the address was pasted", r.a_saved === SHOP);
check("it is theirs", r.a_owner === "true");
check("its secret is in the vault", r.a_vault === "1");
check(
  "and what they see of it is never the secret",
  Array.isArray(listed) && listed.length === 1 && listed[0]?.client_id === CA && !(r.a_lists ?? "").includes(SA)
);
check("someone else may set one up for the same store", r.b_saved === SHOP);
check("and use it for another store, without pasting the secret again", r.b_second === SHOP2);
check("but never take another account's app", (r.b_takes_a ?? "").includes("for another account"));

console.log("\neach person's connection goes through their own");
check("the owner's through theirs", r.a_goes === CA);
check("the other's through theirs", r.b_goes === CB);

console.log("\nthe callback, with the app server's key");
check("either app may have signed what Shopify sent", r.candidates === [CA, CB].toSorted().join(","));
check("and without the key, none", r.candidates_no_key === "0");
check("the owner's own app may connect their store", r.claim_a === "true");
check("someone else's app may not, though it claims the store", r.claim_b === "false");
check("the main app may", r.claim_main === "true");
check("and nothing may without the key", r.claim_no_key === "false");

console.log("\nwhat a store came through is what it answers to");
check("before connecting, the main app's secret", r.secret_before === MAIN);
check("after, its own app's", r.through_a === "true" && r.secret_after_a === SA && r.app_for_after_a === CA);
check(
  "and connected again through the main app, the main's",
  r.through_main === "true" && r.secret_after_main === MAIN
);

console.log("\nan administrator, beside a merchant's apps");
check("is stopped by the app a store came through", (r.admin_on_verified ?? "").includes("already comes through"));
check("but not by a claim that never connected", r.admin_on_claimed === "true");
check(
  "a store connected to one account is not another's to claim",
  (r.b_on_connected ?? "").includes("another Warmluke account")
);

console.log("\ntaking one away");
check("not while a store is connected through it", (r.delete_live ?? "").includes("still connected through it"));
check("never someone else's", r.delete_not_mine === "false");
check("once the store is gone, it goes", r.delete_gone === "true");
check("and its secret with it", r.vault_after_delete === "0");
check("an account deleted takes its apps", r.b_app_after === "0" && r.b_vault_after === "0");

console.log(fails.length ? `\n${fails.length} FAILED` : "\na store's own app holds");
process.exit(fails.length ? 1 : 0);
