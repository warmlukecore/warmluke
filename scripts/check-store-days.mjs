// A store's days are the shop's days (0162), against the check database,
// in one transaction that is rolled back.
//
// The database keeps UTC. A shop in Mumbai saw an order placed at half
// past one in the morning dated the day before, and "today" in a rule or
// a counter was UTC's until half past five. Now each store list writes
// its dates in the shop's zone, "today" and days_since are the shop's
// wherever they are worked out on the server, and a zone the database
// cannot read is never kept.
//
//   ENV_FILE=.env.check.local node scripts/check-store-days.mjs

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
const OWNER = "7a999999-0000-0000-0000-00000000000a";
const [MUMBAI, NEWYORK, NOZONE] = [
  "7a999999-0000-0000-0000-0000000000a1",
  "7a999999-0000-0000-0000-0000000000a2",
  "7a999999-0000-0000-0000-0000000000a3",
];
const [S_MUMBAI, S_NEWYORK, S_NOZONE] = [
  "7a999999-0000-0000-0000-0000000000b1",
  "7a999999-0000-0000-0000-0000000000b2",
  "7a999999-0000-0000-0000-0000000000b3",
];
const ORDERS = "7a999999-0000-0000-0000-0000000000c1";
const OWN = "7a999999-0000-0000-0000-0000000000c2";
const order = (id, store, at) =>
  `('${id}', '${store}', 'chk-${tag}-${id.slice(-2)}', '#${id.slice(-2)}', '${at}', 100, 'INR', 'PAID')`;

const r = psql(`
begin;
create function pg_temp.as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;
create temp table out (k text, v text);
grant all on out to public;
create function pg_temp.say(k text, v text) returns void language sql as $f$ insert into out values (k, v) $f$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'days-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name) values
  ('${MUMBAI}', '${OWNER}', 'days mumbai ${tag}'), ('${NEWYORK}', '${OWNER}', 'days ny ${tag}'), ('${NOZONE}', '${OWNER}', 'days none ${tag}');
insert into public.stores (id, project_id, shop_domain, status, timezone, currency) values
  ('${S_MUMBAI}', '${MUMBAI}', 'days-mum-${tag}.myshopify.com', 'connected', 'Asia/Kolkata', 'INR'),
  ('${S_NEWYORK}', '${NEWYORK}', 'days-ny-${tag}.myshopify.com', 'connected', 'America/New_York', 'USD'),
  ('${S_NOZONE}', '${NOZONE}', 'days-none-${tag}.myshopify.com', 'connected', 'UTC', 'INR');

-- The same instants in three shops: 01:30 on 2 Oct in Mumbai; 22:00 on 1 Oct in New York.
insert into public.orders (id, store_id, external_id, order_number, placed_at, total, currency, financial_status) values
  ${order("7a999999-0000-0000-0000-0000000000d1", S_MUMBAI, "2026-10-01T20:00:00Z")},
  ${order("7a999999-0000-0000-0000-0000000000d2", S_NEWYORK, "2026-10-02T02:00:00Z")},
  ${order("7a999999-0000-0000-0000-0000000000d3", S_NOZONE, "2026-10-01T20:00:00Z")},
  ${order("7a999999-0000-0000-0000-0000000000d4", S_MUMBAI, new Date().toISOString())};
select pg_temp.say('mumbai_day', (select placed_at from public.store_orders where id = '7a999999-0000-0000-0000-0000000000d1'));
select pg_temp.say('ny_day', (select placed_at from public.store_orders where id = '7a999999-0000-0000-0000-0000000000d2'));
select pg_temp.say('nozone_day', (select placed_at from public.store_orders where id = '7a999999-0000-0000-0000-0000000000d3'));

-- A return asked for yesterday, by the shop's clock, is a day open.
insert into public.returns (store_id, order_id, external_id, status, requested_at) values
  ('${S_MUMBAI}', '7a999999-0000-0000-0000-0000000000d1', 'chk-ret-${tag}', 'REQUESTED', now() - interval '1 day');
select pg_temp.say('days_open', (select days_open::text from public.store_returns where store_id = '${S_MUMBAI}'));

-- A zone nobody can read is never kept.
insert into public.stores (project_id, shop_domain, timezone) values ('${NOZONE}', 'days-bad-${tag}.myshopify.com', 'Mars/Olympus');
select pg_temp.say('bad_zone', (select timezone from public.stores where shop_domain = 'days-bad-${tag}.myshopify.com'));
update public.stores set timezone = 'Asia/Kolkata' where shop_domain = 'days-bad-${tag}.myshopify.com';
select pg_temp.say('good_zone', (select timezone from public.stores where shop_domain = 'days-bad-${tag}.myshopify.com'));

-- Today, the shop's.
select pg_temp.say('shop_today', (public.abo_shop_today('${MUMBAI}') = to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'))::text);
select pg_temp.say('utc_today', (public.abo_shop_today('${NOZONE}') = to_char(now() at time zone 'UTC', 'YYYY-MM-DD'))::text);
select pg_temp.say('unset', ((public.abo_eval('{"op":"today"}', '{}', '{}', '{}', '{}') #>> '{}') = to_char(current_date, 'YYYY-MM-DD'))::text);
select set_config('abo.today', '2026-10-03', true);
select pg_temp.say('set', public.abo_eval('{"op":"today"}', '{}', '{}', '{}', '{}') #>> '{}');
select pg_temp.say('days_since', public.abo_eval('{"op":"days_since","args":[{"const":"2026-10-01"}]}', '{}', '{}', '{}', '{}') #>> '{}');
select set_config('abo.today', '', true);

-- A counter of today's orders, over the store: the one placed a moment ago is today's.
insert into public.modules (id, project_id, name, nav_label, route, source_table) values
  ('${ORDERS}', '${MUMBAI}', 'orders-${tag}', 'Orders', '/modules/orders-${tag}', 'orders');
insert into public.ui_schemas (module_id, schema_json, version) values ('${ORDERS}', '{"columns":[]}', 1);
select pg_temp.as('${OWNER}');
select pg_temp.say('stat_today', (public.abo_section_stats('${ORDERS}',
  '[{"label":"Today","op":"count","where":{"op":"=","args":[{"op":"days_since","args":[{"field":"placed_at"}]},{"const":0}]}}]'::jsonb) -> 0 ->> 'count'));
reset role;
select set_config('abo.today', '', true);

-- A rule that stamps today on a new row of their own: the shop's today.
insert into public.modules (id, project_id, name, nav_label, route) values
  ('${OWN}', '${MUMBAI}', 'notes-${tag}', 'Notes', '/modules/notes-${tag}');
insert into public.ui_schemas (module_id, schema_json, version) values
  ('${OWN}', '{"columns":[{"field":"note","label":"Note","type":"text"},{"field":"stamped","label":"Stamped","type":"date"}]}', 1);
insert into public.automations (project_id, module_id, name, definition, enabled) values
  ('${MUMBAI}', '${OWN}', 'Stamp today', '{"trigger":{"type":"record_created"},"actions":[{"type":"set_fields","target":{"self":true},"set":{"stamped":{"op":"today"}}}]}', true);
insert into public.records (module_id, data) values ('${OWN}', '{"note":"hello"}');
select pg_temp.say('rule_today', ((select data->>'stamped' from public.records where module_id = '${OWN}') = to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'))::text);

select k, v from out;
rollback;
`);

console.log("a store list's dates are the shop's days");
check("01:30 on 2 October in Mumbai is the 2nd, not UTC's 1st", r.mumbai_day === "2026-10-02");
check("22:00 on 1 October in New York is the 1st, not UTC's 2nd", r.ny_day === "2026-10-01");
check("a shop in UTC keeps UTC's day", r.nozone_day === "2026-10-01");
check("a return asked for yesterday is a day open, by the shop's clock", r.days_open === "1");

console.log("\na zone the database cannot read is never kept");
check("one it cannot read becomes UTC", r.bad_zone === "UTC");
check("a real one is kept", r.good_zone === "Asia/Kolkata");

console.log("\ntoday is the shop's");
check("a project's today is its shop's", r.shop_today === "true");
check("and a UTC shop's is UTC's", r.utc_today === "true");
check("left unset, today is the database's, as before", r.unset === "true");
check("set, today and days_since read it", r.set === "2026-10-03" && r.days_since === "2");
check("a counter of today's orders counts the one placed a moment ago", r.stat_today === "1");
check("a rule that stamps today stamps the shop's today", r.rule_today === "true");

console.log(fails.length ? `\n${fails.length} FAILED` : "\na store's days are the shop's days");
process.exit(fails.length ? 1 : 0);
