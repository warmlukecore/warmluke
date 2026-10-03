// A store list, a page at a time, from the server (0167), against the
// check database, in one transaction that is rolled back.
//
// A section over the store read its first rows and stopped at 500;
// search, filters and sorting worked on what was loaded. Now each page
// comes from the whole list: searched, filtered and sorted there, the
// merchant's own fields joined where asked for, and the dates picked a
// range on the indexed moment. Timed on 20,000 orders.
//
//   ENV_FILE=.env.check.local node scripts/check-store-page.mjs

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
    maxBuffer: 64 * 1024 * 1024,
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
const id = (n) => `7a444444-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [OWNER, MEMBER, STRANGER, P, S, ORD, CUST, SEAT] = [id(1), id(2), id(3), id(10), id(20), id(30), id(40), id(50)];
const BIG = 20000;
const page = (q) => `public.abo_store_page('${ORD}', '${JSON.stringify(q)}'::jsonb)`;
const order = { order: { field: "placed_ts", dir: "desc" } };
const numbers = (q) =>
  `(select string_agg(r->'data'->>'order_number', ',') from jsonb_array_elements(${page(q)}->'rows') r)`;
const tried = (q) => `pg_temp.try('select ${page(q).replace(/'/g, "''")}::text')`;

const r = psql(`
begin;
create function pg_temp.try(t text) returns text language plpgsql as $f$
declare v text;
begin execute t into v; return coalesce(v, 'ok'); exception when others then return 'ERR ' || sqlerrm; end $f$;
create function pg_temp.as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;
create temp table out (k text, v text);
grant all on out to public;
create function pg_temp.say(k text, v text) returns void language sql as $f$ insert into out values (k, v) $f$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sp-owner-${tag}@warmluke.test'),
  ('${MEMBER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sp-member-${tag}@warmluke.test'),
  ('${STRANGER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sp-stranger-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name) values ('${P}', '${OWNER}', 'store page ${tag}');
-- A teammate the orders are shared with, who may not open the store.
insert into public.project_members (id, project_id, user_id, email, joined_at, can_see_store)
  values ('${SEAT}', '${P}', '${MEMBER}', 'sp-member-${tag}@warmluke.test', now(), false);
insert into public.stores (id, project_id, shop_domain, status, timezone, currency, last_synced_at)
  values ('${S}', '${P}', 'sp-${tag}.myshopify.com', 'connected', 'Asia/Kolkata', 'INR', now());
insert into public.modules (id, project_id, name, nav_label, route, source_table, created_by, shared_with_team) values
  ('${ORD}', '${P}', 'orders-${tag}', 'Orders', '/modules/orders-${tag}', 'orders', '${OWNER}', true);
insert into public.ui_schemas (module_id, schema_json, version) values ('${ORD}', '{"columns":[]}', 1);
insert into public.customers (id, store_id, external_id, name, email, phone)
  values ('${CUST}', '${S}', 'sp-c-${tag}', 'Priya Sharma', 'priya@example.com', '+91 98765 43210');

-- 20,000 orders, an hour apart, newest #SP20000; every fifth unpaid; a phone on the first.
insert into public.orders (store_id, external_id, order_number, placed_at, total, currency, financial_status, customer_id)
  select '${S}', 'sp-${tag}-' || g, '#SP' || g, now() - make_interval(hours => ${BIG} - g), g, 'INR',
         case when g % 5 = 0 then 'PENDING' else 'PAID' end, case when g = 1 then '${CUST}'::uuid end
    from generate_series(1, ${BIG}) g;
-- The merchant's own tick beside three of them (0128).
insert into public.records (project_id, module_id, store_row_id, data)
  select '${P}', '${ORD}', o.id, '{"rto": true, "note": "came back"}'::jsonb
    from public.orders o where o.store_id = '${S}' and o.order_number in ('#SP100', '#SP200', '#SP300');
analyze public.orders;

select pg_temp.as('${OWNER}');
select pg_temp.say('first', (select (${page({ limit: 3, ...order })}->>'total') || '|' || ${numbers({ limit: 3, ...order })}));
select pg_temp.say('later', ${numbers({ offset: 50, limit: 2, ...order })});
select pg_temp.say('search', ${page({ limit: 5, search: "#SP1999", search_fields: ["order_number"], ...order })}->>'total');
select pg_temp.say('phone', ${numbers({ limit: 5, search: "98765 43210", search_fields: ["order_number"], ...order })});
select pg_temp.say('unpaid', ${page({ limit: 1, filters: { financial_status: "pending" }, ...order })}->>'total');
select pg_temp.say('own_filter', (select (${page({ limit: 5, filters: { rto: "true" }, ...order })}->>'total') || '|' || ${numbers({ limit: 5, filters: { rto: "true" }, ...order })}));
select pg_temp.say('own_data', (${page({ limit: 1, filters: { rto: "true" }, ...order })}->'rows'->0->'data'->>'note'));
select pg_temp.say('sorted', ${numbers({ limit: 2, sort: { field: "total", dir: "asc", kind: "number" }, ...order })});
select pg_temp.say('own_sorted', ${numbers({ limit: 1, sort: { field: "rto", dir: "desc" }, ...order })});
select pg_temp.say('period', ${page({
  limit: 1,
  period: {
    field: "placed_at",
    from: new Date(Date.now() - 48.5 * 3600e3).toISOString(),
    to: new Date(Date.now() + 3600e3).toISOString(),
  },
  ...order,
})}->>'total');
select pg_temp.say('facets', (${page({ limit: 1, facets: ["financial_status", "rto"], ...order })}->'facets')::text);

-- Fast on twenty thousand: the first page, a later one, and a filtered one.
create temp table took (k text, ms numeric);
grant all on took to public;
do $$
declare t timestamptz;
begin
  t := clock_timestamp(); perform ${page({ limit: 50, ...order })};
  insert into took values ('first', extract(epoch from clock_timestamp() - t) * 1000);
  t := clock_timestamp(); perform ${page({ offset: 5000, limit: 50, ...order })};
  insert into took values ('deep', extract(epoch from clock_timestamp() - t) * 1000);
  t := clock_timestamp(); perform ${page({ limit: 50, filters: { financial_status: "PENDING" }, ...order })};
  insert into took values ('filtered', extract(epoch from clock_timestamp() - t) * 1000);
end $$;
select pg_temp.say('took', (select string_agg(k || '=' || round(ms)::text, ' ' order by k) from took));
select pg_temp.say('took_max', (select max(ms)::text from took));

select pg_temp.as('${MEMBER}');
select pg_temp.say('member', ${tried({ limit: 1 })});
select pg_temp.as('${STRANGER}');
select pg_temp.say('stranger', ${tried({ limit: 1 })});
reset role;

select k, v from out;
rollback;
`);

console.log("a page of the whole list");
check("the newest first, and how many there are in all", r.first === `${BIG}|#SP20000,#SP19999,#SP19998`);
check("a later page is the rows after it", r.later === "#SP19950,#SP19949");
check("searched over the whole list", r.search === "11");
check("a phone however it is typed", r.phone === "#SP1");
check("filtered over the whole list, by the counters' rule", r.unpaid === String(BIG / 5));
check("by a field of the merchant's beside the store's", r.own_filter === "3|#SP300,#SP200,#SP100");
check("and their fields come with the row", r.own_data === "came back");
check("sorted by a store column over every row", r.sorted === "#SP1,#SP2");
check("and by a field of theirs", r.own_sorted === "#SP300");
check("the dates picked, on the moment", r.period === "49");
check(
  "what each filter can offer, from the whole list",
  r.facets?.includes('"financial_status": ["PAID", "PENDING"]') && r.facets?.includes('"rto": ["true"]')
);

console.log("\nfast on twenty thousand orders");
console.log(`        ${r.took} (ms)`);
check("the first page, a deep one and a filtered one, each under 200 ms", Number(r.took_max) < 200);

console.log("\nwho may read it");
check("a teammate the store is not open to may not", r.member?.startsWith("ERR"));
check("nor anyone outside the project", r.stranger?.startsWith("ERR"));

console.log(fails.length ? `\n${fails.length} FAILED` : "\na store list is a page of the whole list");
process.exit(fails.length ? 1 : 0);
