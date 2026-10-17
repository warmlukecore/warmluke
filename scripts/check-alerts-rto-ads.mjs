// Luke watches RTO and ads spending without sales (0221), on the check
// project, inside one transaction that is rolled back.
//
// RTO: counted only over shipments delivered or returned, against the
// weeks before, with those still on their way and the worst couriers said;
// a rise under the owner's points stays quiet, and one that falls back
// closes. Ads: a campaign that spent with no store orders from it is
// noticed; one whose orders paid for it is not. Data a connection writes
// marks the store to be looked at again.
//
//   ENV_FILE=.env.check.local node scripts/check-alerts-rto-ads.mjs
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
const id = (n) => `7a999999-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [OWNER, P, S, SHIP, ADS] = [id(1), id(10), id(20), id(30), id(31)];
const run = `select public.abo_alerts_run('${S}');`;
const open = (kind) =>
  `coalesce((select string_agg(subject || ':' || severity, ',' order by subject) from public.alerts where store_id = '${S}' and kind = '${kind}' and status = 'open'), 'none')`;
const facts = (kind) =>
  `coalesce((select facts::text from public.alerts where store_id = '${S}' and kind = '${kind}' and status = 'open' limit 1), '{}')`;
// n shipments by one courier, sent `ago` days back, `rto` of them returned, `moving` not yet settled.
const ships = (from, n, courier, ago, rto, moving = 0) =>
  `insert into public.courier_shipments (project_id, store_id, connection_id, provider, shipment_ref, courier, rto, shipped_at, delivered_at)
   select '${P}', '${S}', '${SHIP}', 'shiprocket', 'rr-${tag}-' || g, '${courier}', g < ${from + rto},
          now() - interval '${ago} days',
          case when g >= ${from + rto} and g < ${from + n - moving} then now() - interval '${Math.max(0, ago - 2)} days' end
     from generate_series(${from}, ${from + n - 1}) g;`;

const r = psql(`
begin;
create temp table out (k text, v text);
grant all on out to public;
create function pg_temp.say(k text, v text) returns void language sql as $f$ insert into out values (k, v) $f$;
create function pg_temp.as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rr-owner-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name) values ('${P}', '${OWNER}', 'rto ads ${tag}');
insert into public.stores (id, project_id, shop_domain, status, timezone, currency)
  values ('${S}', '${P}', 'rr-${tag}.myshopify.com', 'connected', 'Asia/Kolkata', 'INR');
insert into public.store_connections (id, project_id, store_id, provider, account_ref, status, connected_by) values
  ('${SHIP}', '${P}', '${S}', 'shiprocket', 'ship-${tag}', 'connected', '${OWNER}'),
  ('${ADS}', '${P}', '${S}', 'meta_ads', 'act-${tag}', 'connected', '${OWNER}');
insert into public.import_runs (store_id, resource, status) values ('${S}', 'orders', 'done');

-- The last 14 days: 45 sent, 40 settled, 12 back (30%); Delhivery worst.
${ships(1, 25, "Delhivery", 5, 10, 5)}
${ships(100, 20, "Bluedart", 6, 2)}
-- The weeks before: 40 settled, 4 back (10%).
${ships(200, 40, "Delhivery", 30, 4)}

-- Ads: Diwali spent 3,000 over three days with no orders tagged to it;
-- Retarget spent 1,500 and its own orders brought back 6,000.
insert into public.ad_spend (project_id, store_id, connection_id, provider, campaign_id, campaign_name, day, spend, currency, purchases, purchase_value)
select '${P}', '${S}', '${ADS}', 'meta_ads', c.id, c.name, (now() at time zone 'Asia/Kolkata')::date - d, c.spend, 'INR', 2, c.spend * 3
  from (values ('111', 'Diwali', 1000), ('222', 'Retarget', 500)) c(id, name, spend), generate_series(0, 2) d;
insert into public.orders (store_id, external_id, order_number, placed_at, total, currency, utm_campaign)
select '${S}', 'rr-o-${tag}-' || d, '#R' || d, now() - make_interval(days => d), 2000, 'INR', 'retarget'
  from generate_series(0, 2) d;
select pg_temp.say('dirty_after_spend', (select count(*)::text from public.alert_dirty where store_id = '${S}'));

-- Off until turned on with its numbers (0199).
${run}
select pg_temp.say('off', ${open("rto_rising")} || '|' || ${open("ads_no_sales")});

select pg_temp.as('${OWNER}');
select public.abo_set_alert_setting('${P}', 'rto_rising', true, '{"days": 14, "min": 30, "points": 5}');
select public.abo_set_alert_setting('${P}', 'ads_no_sales', true, '{"days": 7, "spend": 1000, "roas": 1}');
reset role;
${run}
select pg_temp.say('rto', ${open("rto_rising")});
select pg_temp.say('rto_facts', ${facts("rto_rising")});
select pg_temp.say('ads', ${open("ads_no_sales")});
select pg_temp.say('ads_facts', ${facts("ads_no_sales")});

-- Under the owner's points: a routine move, quiet, and what was open closes.
select pg_temp.as('${OWNER}');
select public.abo_set_alert_setting('${P}', 'rto_rising', true, '{"days": 14, "min": 30, "points": 25}');
reset role;
${run}
select pg_temp.say('quiet', ${open("rto_rising")});

-- Too few settled to say: no alert either.
select pg_temp.as('${OWNER}');
select public.abo_set_alert_setting('${P}', 'rto_rising', true, '{"days": 14, "min": 60, "points": 5}');
reset role;
${run}
select pg_temp.say('few', ${open("rto_rising")});

-- Offered only where the store has the connection: the ad account gone, its watch is not listed.
select pg_temp.say('listed_with', (select string_agg(s ->> 'kind', ',') from jsonb_array_elements(
  (select public.abo_alert_settings('${P}') from (select pg_temp.as('${OWNER}')) x)) s where s ->> 'kind' in ('rto_rising', 'ads_no_sales')));
reset role;
update public.store_connections set status = 'disconnected' where id = '${ADS}';
select pg_temp.say('listed_without', (select string_agg(s ->> 'kind', ',') from jsonb_array_elements(
  (select public.abo_alert_settings('${P}') from (select pg_temp.as('${OWNER}')) x)) s where s ->> 'kind' in ('rto_rising', 'ads_no_sales')));
reset role;

select k, v from out;
rollback;
`);

console.log("\nwhat a connection writes is looked at again");
check("ad spend written marks the store", Number(r.dirty_after_spend) >= 1);

console.log("\noff until the owner turns it on");
check("nothing noticed before", r.off === "none|none");

console.log("\nRTO rising");
const rto = JSON.parse(r.rto_facts ?? "{}");
check("a rise from 10% to 30% is noticed, and critical", r.rto === "rto:critical");
check(
  "counted over settled shipments only, the ones on their way said apart",
  rto.rate === 30 && rto.rate_before === 10 && rto.rto === 12 && rto.settled === 40 && rto.moving === 5
);
check("the worst courier named first", rto.couriers?.[0]?.courier === "Delhivery" && rto.couriers[0].rto === 10);
check(
  "and what Luke found looking into it, by payment and by state, kept with it (0230)",
  Array.isArray(rto.by_payment?.groups) && rto.by_payment.groups.length > 0 && Array.isArray(rto.by_state?.groups)
);
check("a rise under the owner's points is quiet, and what was open closes", r.quiet === "none");
check("too few settled to compare says nothing", r.few === "none");

console.log("\noffered where the store has the connection");
check("both are listed while their connections are there", r.listed_with === "rto_rising,ads_no_sales");
check("and the ad watch is not, once the ad account is gone", r.listed_without === "rto_rising");

console.log("\nads spending without sales");
const ads = JSON.parse(r.ads_facts ?? "{}");
check("the campaign with no store orders is noticed, critical at twice the spend", r.ads === "meta_ads:111:critical");
check(
  "with what it spent and what the platform claims beside it",
  ads.spend === 3000 && ads.orders === 0 && ads.platform_roas === 3 && ads.currency === "INR"
);
check("the one whose own orders paid for it is not", !String(r.ads).includes("222"));

console.log(
  fails.length ? `\n${fails.length} FAILED` : "\nRTO and ads are watched on their evidence, quietly until they matter"
);
process.exit(fails.length ? 1 : 0);
