// How far back a store's orders and customers go (0154), against the
// check database, in one transaction that is rolled back.
//
// Choosing, choosing again further back and further forward, letting go
// of what a shorter window leaves outside it in batches, and forgetting
// only inside the window: the rules a merchant cannot see but would feel
// the day one of them broke — a year of orders removed for being "not
// found", or a removal that timed out half way through a big store.
//
//   ENV_FILE=.env.check.local node scripts/check-history.mjs

import { randomBytes } from "node:crypto";
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
const OWNER = "55555555-0000-0000-0000-00000000000a";
const OUTSIDER = "55555555-0000-0000-0000-00000000000b";
const ADMIN = "55555555-0000-0000-0000-00000000000c";
const PROJECT = "55555555-0000-0000-0000-0000000000d1";
const STORE = "55555555-0000-0000-0000-0000000000e1";

const sql = `
begin;
create function pg_temp.try(t text) returns text language plpgsql as $f$
declare v text;
begin execute t into v; return coalesce(v, 'ok'); exception when others then return 'ERR ' || sqlerrm; end $f$;
create function pg_temp.as(uid uuid, client text default null) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    (json_build_object('sub', uid, 'role', 'authenticated') :: jsonb
      || case when client is null then '{}'::jsonb else jsonb_build_object('client_id', client) end)::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;
create temp table out (k text, v text);
grant all on out to public;
create function pg_temp.say(k text, v text) returns void language sql as $f$ insert into out values (k, v) $f$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'history-owner-${tag}@warmluke.test'),
  ('${OUTSIDER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'history-out-${tag}@warmluke.test'),
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'history-admin-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN}', true)
  on conflict (user_id) do update set is_superadmin = true;
-- What is offered, as the defaults leave it, whatever the check database was left with.
update public.history_settings set enabled = true, choices = '{30,60,90,180,365}', default_days = 60 where id;
insert into public.projects (id, owner_id, name) values ('${PROJECT}', '${OWNER}', 'check history');
-- Not chosen yet, as a store connected after 0154 is.
insert into public.stores (id, project_id, provider, shop_domain, status, access_token, connected_at, timezone, granted_scopes, history_set_at)
values ('${STORE}', '${PROJECT}', 'shopify', 'zz-history-${tag}.myshopify.com', 'connected', 'tok', now(), 'Asia/Kolkata',
        array['read_orders', 'read_all_orders', 'read_customers'], null);
select pg_temp.say('unchosen', (select (history_set_at is null)::text from public.stores where id = '${STORE}'));

-- Who may choose.
select pg_temp.as('${OUTSIDER}');
select pg_temp.say('outsider', pg_temp.try($t$select public.abo_store_set_history('${STORE}', 30)::text$t$));
select pg_temp.say('outsider_trim', pg_temp.try($t$select public.abo_store_trim_history('${STORE}')::text$t$));
reset role;
select pg_temp.as('${OWNER}', 'some-ai-client');
select pg_temp.say('ai_client', pg_temp.try($t$select public.abo_store_set_history('${STORE}', 30)::text$t$));
reset role;
select pg_temp.as('${OWNER}');
select pg_temp.say('odd_days', pg_temp.try($t$select public.abo_store_set_history('${STORE}', 45)::text$t$));

-- The first choice, before anything was imported.
select pg_temp.say('first', public.abo_store_set_history('${STORE}', 30)::text);
reset role;
select pg_temp.say('first_row', (select concat_ws('|', history_days, history_from = (public.abo_days_ago('Asia/Kolkata', array[30]))[1], history_set_at is not null)
  from public.stores where id = '${STORE}'));

-- Orders on either side of a 30-day window, one with a line, and a pass
-- of the windowed lists already walked. Written with the row triggers
-- off, so they keep the "last seen" they are given: every ordinary
-- write stamps a row seen now (0123), and these are rows a pass missed.
set local session_replication_role = replica;
insert into public.orders (id, store_id, external_id, placed_at, created_at, seen_at) values
  ('55555555-0000-0000-0000-0000000000f1', '${STORE}', 'o-recent', now() - interval '5 days', now() - interval '3 hours', now() - interval '3 hours'),
  ('55555555-0000-0000-0000-0000000000f2', '${STORE}', 'o-old-1', now() - interval '100 days', now() - interval '3 hours', now() - interval '3 hours'),
  ('55555555-0000-0000-0000-0000000000f3', '${STORE}', 'o-old-2', now() - interval '120 days', now() - interval '3 hours', now() - interval '3 hours'),
  ('55555555-0000-0000-0000-0000000000f4', '${STORE}', 'o-old-3', now() - interval '140 days', now() - interval '3 hours', now() - interval '3 hours');
insert into public.order_line_items (store_id, order_id) values ('${STORE}', '55555555-0000-0000-0000-0000000000f2');
insert into public.customers (store_id, external_id, created_at, seen_at)
values ('${STORE}', 'c-unseen', now() - interval '3 hours', now() - interval '3 hours');
set local session_replication_role = origin;
insert into public.import_runs (store_id, resource, status, started_at, finished_at)
select '${STORE}', r, 'done', now() - interval '2 hours', now() - interval '1 hour'
  from unnest(array['products', 'customers', 'returns', 'orders', 'refunds', 'fulfillments']) r;

-- Further back: the windowed lists are read again; the catalogue is not.
select pg_temp.as('${OWNER}');
select pg_temp.say('longer', public.abo_store_set_history('${STORE}', 365)::text);
reset role;
select pg_temp.say('longer_runs', (select string_agg(resource || '=' || status, ',' order by resource) from public.import_runs where store_id = '${STORE}'));

-- Further forward again: nothing to read, three orders now outside.
update public.import_runs set status = 'done', started_at = now() - interval '2 hours', finished_at = now() - interval '1 hour'
 where store_id = '${STORE}';
select pg_temp.as('${OWNER}');
select pg_temp.say('shorter', public.abo_store_set_history('${STORE}', 30)::text);
reset role;
select pg_temp.say('shorter_runs', (select count(*) filter (where status = 'done')::text from public.import_runs where store_id = '${STORE}'));

-- Forgetting what a pass did not see: only inside the window, and no
-- customers at all while there is one.
update public.import_runs set prev_started_at = now() - interval '2 hours' where store_id = '${STORE}';
select pg_temp.as('${OWNER}');
select pg_temp.say('forgot', public.abo_store_forget_unseen('${STORE}')::text);
reset role;
select pg_temp.say('orders_left', (select string_agg(external_id, ',' order by external_id) from public.orders where store_id = '${STORE}'));
select pg_temp.say('customers_left', (select count(*)::text from public.customers where store_id = '${STORE}'));

-- Letting go of the old ones, two at a time, as a big store would.
select pg_temp.as('${OWNER}');
select pg_temp.say('trim1', public.abo_store_trim_history('${STORE}', 2)::text);
select pg_temp.say('trim2', public.abo_store_trim_history('${STORE}', 2)::text);
select pg_temp.say('trim3', public.abo_store_trim_history('${STORE}', 2)::text);
reset role;
select pg_temp.say('after_trim', (select string_agg(external_id, ',' order by external_id) from public.orders where store_id = '${STORE}'));
select pg_temp.say('lines_after', (select count(*)::text from public.order_line_items where store_id = '${STORE}'));

-- Asked on a store's first connection only. A row written any other way
-- has chosen everything, as stores did before the question.
insert into public.projects (id, owner_id, name) values ('55555555-0000-0000-0000-0000000000d2', '${OWNER}', 'check history 2');
insert into public.stores (id, project_id, provider, shop_domain, status, oauth_state, oauth_state_expires_at)
values ('55555555-0000-0000-0000-0000000000e2', '55555555-0000-0000-0000-0000000000d2', 'shopify',
        'zz-first-${tag}.myshopify.com', 'pending', 'state-1-${tag}', now() + interval '10 minutes');
select pg_temp.say('written', (select (history_set_at is not null)::text from public.stores where id = '55555555-0000-0000-0000-0000000000e2'));
select public.abo_shopify_connect('state-1-${tag}', 'zz-first-${tag}.myshopify.com', 'tok', 'Asia/Kolkata', 'INR', 'IN', null, null, null, null);
select pg_temp.say('first_connect', (select (history_set_at is null)::text from public.stores where id = '55555555-0000-0000-0000-0000000000e2'));
select pg_temp.as('${OWNER}');
select public.abo_store_set_history('55555555-0000-0000-0000-0000000000e2', 90);
reset role;
update public.stores set oauth_state = 'state-2-${tag}', oauth_state_expires_at = now() + interval '10 minutes'
 where id = '55555555-0000-0000-0000-0000000000e2';
select public.abo_shopify_connect('state-2-${tag}', 'zz-first-${tag}.myshopify.com', 'tok2', 'Asia/Kolkata', 'INR', 'IN', null, null, null, null);
select pg_temp.say('reconnect', (select concat_ws('|', history_days, history_set_at is not null) from public.stores where id = '55555555-0000-0000-0000-0000000000e2'));

-- What an administrator offers, and what that lets a merchant choose.
select pg_temp.as('${OWNER}');
select pg_temp.say('offer_not_admin', pg_temp.try($t$select public.abo_admin_set_history_settings(true, '{7,30}', 7)::text$t$));
reset role;
select pg_temp.as('${ADMIN}');
select pg_temp.say('offer_empty', pg_temp.try($t$select public.abo_admin_set_history_settings(true, '{}', 7)::text$t$));
select pg_temp.say('offer_long', pg_temp.try($t$select public.abo_admin_set_history_settings(true, '{7,5000}', 7)::text$t$));
select pg_temp.say('offer_default', pg_temp.try($t$select public.abo_admin_set_history_settings(true, '{7,30}', 14)::text$t$));
select pg_temp.say('offer', public.abo_admin_set_history_settings(true, '{30,7,30}', 7)::text);
reset role;
select pg_temp.as('${OWNER}');
select pg_temp.say('pick_unoffered', pg_temp.try($t$select public.abo_store_set_history('${STORE}', 60)::text$t$));
select pg_temp.say('pick_offered', pg_temp.try($t$select (public.abo_store_set_history('${STORE}', 7) ->> 'days')$t$));
reset role;
select pg_temp.as('${ADMIN}');
select public.abo_admin_set_history_settings(false, '{7,30}', 7);
reset role;
select pg_temp.as('${OWNER}');
select pg_temp.say('pick_off', pg_temp.try($t$select public.abo_store_set_history('${STORE}', 7)::text$t$));
reset role;
insert into public.projects (id, owner_id, name) values ('55555555-0000-0000-0000-0000000000d3', '${OWNER}', 'check history 3');
insert into public.stores (id, project_id, provider, shop_domain, status, oauth_state, oauth_state_expires_at)
values ('55555555-0000-0000-0000-0000000000e3', '55555555-0000-0000-0000-0000000000d3', 'shopify',
        'zz-off-${tag}.myshopify.com', 'pending', 'state-3-${tag}', now() + interval '10 minutes');
select public.abo_shopify_connect('state-3-${tag}', 'zz-off-${tag}.myshopify.com', 'tok', 'UTC', 'INR', 'IN', null, null, null, null);
select pg_temp.say('first_connect_off', (select (history_set_at is not null)::text from public.stores where id = '55555555-0000-0000-0000-0000000000e3'));

select k, v from out;
rollback;
`;

const r = psql(sql);
const json = (k) => {
  try {
    return JSON.parse(r[k] ?? "null");
  } catch {
    return null;
  }
};

console.log("a store connected now is asked");
check("a row made with no choice starts without one", r.unchosen === "true");
check("a row written any other way has chosen everything", r.written === "true");
check("its first connection leaves it to be asked", r.first_connect === "true");
check("a reconnect keeps what was chosen", r.reconnect === "90|t");

console.log("\nonly its owner, in Warmluke, chooses");
check("someone else is refused", (r.outsider ?? "").includes("not a store of yours"));
check("and cannot remove its orders", (r.outsider_trim ?? "").includes("not a store of yours"));
check("their own AI is refused", (r.ai_client ?? "").includes("in Warmluke itself"));
check(
  "a window that is not offered is refused",
  (r.odd_days ?? "").includes("Choose one of: 30, 60, 90, 180, 365 days")
);

console.log("\nchoosing");
const first = json("first");
check("the first choice reads nothing again: there was nothing yet", first?.extended === false && first?.older === 0);
check("it is kept as the days, the store's own midnight, and when", r.first_row === "30|t|t");

console.log("\nchoosing further back");
check("says it will read again", json("longer")?.extended === true);
check(
  "and sets the windowed lists going, leaving the catalogue alone",
  r.longer_runs ===
    "customers=pending,fulfillments=pending,orders=pending,products=done,refunds=pending,returns=pending"
);

console.log("\nchoosing further forward");
const shorter = json("shorter");
check("reads nothing again", shorter?.extended === false && r.shorter_runs === "6");
check("and counts the orders it leaves outside", shorter?.older === 3);

console.log("\nforgetting only what the window asked about");
check("an order inside the window that a pass missed is forgotten", !(r.orders_left ?? "").includes("o-recent"));
check("orders from before it are kept", r.orders_left === "o-old-1,o-old-2,o-old-3");
check("customers are not forgotten while there is a window", r.customers_left === "1");

console.log("\nletting go of what is outside it, a batch at a time");
check("each batch is at most what was asked", r.trim1 === "2" && r.trim2 === "1" && r.trim3 === "0");
check("until none from before it are left", (r.after_trim ?? "") === "");
check("their lines go with them", r.lines_after === "0");

// A store's columns are granted to a signed-in reader one by one, so a
// column added without its grant fails every read that names it — the
// picker, Settings, the import, and Luke's own view of the store — with
// a 403 and nothing in the build to say so. Every column the app reads
// from stores, directly or inside another table's select, is held to
// what the database actually grants.
console.log("\nevery store column the app reads is one it may read");
{
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(new URL("../src", import.meta.url), { recursive: true }).filter((f) =>
    /\.(ts|tsx)$/.test(f)
  );
  const read = new Set();
  for (const f of files) {
    const s = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    for (const m of s.matchAll(/\.from\("stores"\)\s*\.select\(\s*"([^"]+)"/g)) {
      // Another table embedded in the select, projects(name), is that table's.
      for (const c of m[1].replace(/[a-z_!]+\([^)]*\)/g, "").split(",")) read.add(c.trim());
    }
    for (const m of s.matchAll(/\bstores\(([a-z_, ]+)\)/g)) for (const c of m[1].split(",")) read.add(c.trim());
  }
  read.delete("");
  const granted = new Set(
    Object.keys(
      psql(`select column_name, 1 from information_schema.column_privileges
             where table_schema = 'public' and table_name = 'stores'
               and grantee = 'authenticated' and privilege_type = 'SELECT';`)
    )
  );
  const ungranted = [...read].filter((c) => !granted.has(c));
  check(
    `${read.size} columns read, all granted${ungranted.length ? `: not ${ungranted}` : ""}`,
    ungranted.length === 0
  );
  check("and never the token", !granted.has("access_token") && !granted.has("refresh_token"));
}

console.log("\nwhat is offered is an administrator's");
check("nobody else may change it", (r.offer_not_admin ?? "").includes("Not an administrator"));
check("at least one window", (r.offer_empty ?? "").includes("at least one window"));
check("each within ten years", (r.offer_long ?? "").includes("between 1 and 3650"));
check("and a default among them", (r.offer_default ?? "").includes("one of the windows offered"));
check("kept in order, once each", JSON.parse(r.offer ?? "{}").choices?.join() === "7,30");
check("a merchant may choose only what is offered", (r.pick_unoffered ?? "").includes("Choose one of: 7, 30 days"));
check("and gets it", r.pick_offered === "7");
check("switched off, nobody chooses", (r.pick_off ?? "").includes("switched off"));
check("and a first connection is not asked", r.first_connect_off === "true");

console.log(fails.length ? `\n${fails.length} FAILED` : "\nhistory holds");
process.exit(fails.length ? 1 : 0);
