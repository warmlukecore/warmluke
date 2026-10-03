// An order keeps its phone, and the newest order comes first (0166),
// against the check database, in one transaction that is rolled back.
//
// On one store 198 of 2,487 orders showed a phone: the list read the
// customer's record only, and a buyer paying cash on delivery gives
// their number on the delivery address. And within a day the list ran
// oldest first, ordered by the day (an expression) on no index.
//
//   ENV_FILE=.env.check.local node scripts/check-order-phones.mjs

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
const id = (n) => `7a555555-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [OWNER, P, S, CUST, BARE] = [id(1), id(10), id(20), id(30), id(31)];
const SHOP = `ph-${tag}.myshopify.com`;
// A cash-on-delivery order as Shopify's webhook sends it: no phone on
// the customer, the buyer's on the delivery address.
const order = (n, extra) =>
  JSON.stringify({
    id: 91000 + n,
    name: `#P${n}`,
    created_at: "2026-10-03T09:00:00Z",
    currency: "INR",
    total_price: "999.00",
    financial_status: "pending",
    customer: { id: 7700 },
    line_items: [],
    ...extra,
  });
const view = (n, col) => `(select ${col} from public.store_orders where order_number = '#P${n}' and store_id = '${S}')`;

const r = psql(`
begin;
create temp table out (k text, v text);
create function pg_temp.say(k text, v text) returns void language sql as $f$ insert into out values (k, v) $f$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ph-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name) values ('${P}', '${OWNER}', 'phones ${tag}');
insert into public.stores (id, project_id, shop_domain, provider, status, timezone, currency, last_synced_at)
  values ('${S}', '${P}', '${SHOP}', 'shopify', 'connected', 'Asia/Kolkata', 'INR', now());
insert into public.customers (id, store_id, external_id, name, email) values
  ('${CUST}', '${S}', 'gid://shopify/Customer/7700', 'Priya', 'priya@example.com'),
  ('${BARE}', '${S}', 'gid://shopify/Customer/7701', 'Ravi', 'ravi@example.com');

-- Its phones, kept; the list shows the delivery's.
select public.abo_shopify_upsert_order('${SHOP}', '${order(1, {
  phone: "+91 90000 11111",
  shipping_address: { city: "Pune", phone: "+91 98765-43210" },
  billing_address: { phone: "+91 80000 22222" },
})}'::jsonb);
select pg_temp.say('kept', (select phone || '|' || ship_phone || '|' || bill_phone from public.orders where store_id = '${S}' and order_number = '#P1'));
select pg_temp.say('shown', ${view(1, "customer_phone")});
select pg_temp.say('digits', ${view(1, "phone_digits")});
select pg_temp.say('customer_list_first', (select phone from public.store_customers where id = '${CUST}'));

-- A later webhook that says nothing of phones leaves them be.
select public.abo_shopify_upsert_order('${SHOP}', '${order(1, { financial_status: "paid" })}'::jsonb);
select pg_temp.say('still', ${view(1, "customer_phone")});

-- No delivery phone: the order's own. It is the customer's newest order, an hour later.
select public.abo_shopify_upsert_order('${SHOP}', '${order(2, { phone: "+91 90000 33333", created_at: "2026-10-03T10:00:00Z" })}'::jsonb);
select pg_temp.say('order_own', ${view(2, "customer_phone")});
select pg_temp.say('customer_list_newest', (select phone from public.store_customers where id = '${CUST}'));
-- The older order written again does not bring its number back.
select public.abo_shopify_upsert_order('${SHOP}', '${order(1, { financial_status: "refunded" })}'::jsonb);
select pg_temp.say('customer_list_kept', (select phone from public.store_customers where id = '${CUST}'));

-- None on the order: the customer's own, which the customers list keeps too.
update public.customers set phone = '+91 70000 44444' where id = '${BARE}';
select public.abo_shopify_upsert_order('${SHOP}', '${order(3, { customer: { id: 7701 } })}'::jsonb);
select pg_temp.say('customer_own', ${view(3, "customer_phone")});
select pg_temp.say('customer_list_own', (select phone from public.store_customers where id = '${BARE}'));

-- Newest first within a day, by the moment.
insert into public.orders (store_id, external_id, order_number, placed_at, total, currency) values
  ('${S}', 'ph-${tag}-a', '#P8', '2026-10-03T04:00:00Z', 1, 'INR'),
  ('${S}', 'ph-${tag}-b', '#P9', '2026-10-03T08:00:00Z', 1, 'INR');
select pg_temp.say('newest', (select string_agg(order_number, ',' order by placed_ts desc)
  from public.store_orders where store_id = '${S}' and order_number in ('#P8', '#P9')));
select pg_temp.say('same_day', (select count(distinct placed_at)::text from public.store_orders where store_id = '${S}' and order_number in ('#P8', '#P9')));

-- And on the orders index, not a sort of the store's whole list. Asked
-- with sorting and full scans priced out: five rows may be cheaper to
-- sort, but the question is whether the order can come from the index
-- at all, which by the day (an expression) it never could.
set local enable_sort = off;
set local enable_seqscan = off;
create temp table plan (line text);
do $$
declare l text;
begin
  for l in execute 'explain select id, order_number from public.store_orders where store_id = ''${S}'' order by placed_ts desc limit 50' loop
    insert into plan values (l);
  end loop;
end $$;
select pg_temp.say('indexed', (select (bool_or(line like '%idx_orders_placed%') and not bool_or(line ~ '^\\s*(->\\s*)?Sort'))::text from plan));

select k, v from out;
rollback;
`);

console.log("an order keeps its phone");
check(
  "its own, the delivery's and the billing's, as Shopify sent them",
  r.kept === "+91 90000 11111|+91 98765-43210|+91 80000 22222"
);
check("the list shows the delivery's, where a COD buyer gives it", r.shown === "+91 98765-43210");
check("and its digits, to be found however it is typed", r.digits === "919876543210");
check("a webhook that says nothing of phones leaves them be", r.still === "+91 98765-43210");
check("no delivery phone: the order's own", r.order_own === "+91 90000 33333");
check("none on the order: the customer's", r.customer_own === "+91 70000 44444");

console.log("\nthe customers list");
check(
  "a customer with no phone of their own shows the one on their order",
  r.customer_list_first === "+91 98765-43210"
);
check("the newest order's, once there is a newer one", r.customer_list_newest === "+91 90000 33333");
check("an older order written again does not bring its number back", r.customer_list_kept === "+91 90000 33333");
check("one with their own keeps it", r.customer_list_own === "+91 70000 44444");

console.log("\nthe newest order first");
check("within a day, by the moment it was placed", r.newest === "#P9,#P8" && r.same_day === "1");
check("on the orders index", r.indexed === "true");

console.log(fails.length ? `\n${fails.length} FAILED` : "\nan order keeps its phone, and the newest comes first");
process.exit(fails.length ? 1 : 0);
