// Ads on stock running out (0229, the sprint's Days 9–11), on the check
// project, inside one transaction that is rolled back.
//
// What a campaign sells is what its own orders bought in the window (the
// order's UTM campaign is its name or id, any case), cancelled ones and
// older ones left out; each variant's stock and pace beside the owner's
// restock time; a campaign no order names sells nothing known. The watch
// is off until turned on, rings once for a campaign spending on stock
// running out, critical while one is out, quiet under the owner's spend,
// and closes once the stock is back. A stranger reads nothing.
//
//   ENV_FILE=.env.check.local node scripts/check-ads-stock.mjs
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
const id = (n) => `7a888888-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [OWNER, STRANGER, P, S, ADS] = [id(1), id(2), id(10), id(20), id(21)];
const [P1, P2, P3] = [id(31), id(32), id(33)];
const [V1, V2, V3, V4] = [id(41), id(42), id(43), id(44)];
const [O1, O2, O3, O4, O5, O6] = [id(51), id(52), id(53), id(54), id(55), id(56)];
const as = (who, sql) => `(select ${sql} from (select pg_temp.as('${who}')) x)`;
const run = `select public.abo_alerts_run('${S}');`;
const open = `coalesce((select string_agg(subject || ':' || severity, ',' order by subject) from public.alerts where store_id = '${S}' and kind = 'ads_low_stock' and status = 'open'), 'none')`;
const order = (o, ago, utm, cancelled = false) =>
  `('${o}', '${S}', 'as-${o.slice(-2)}-${tag}', '#A${o.slice(-2)}', now() - interval '${ago} days', 100, 'INR', ${
    utm ? `'${utm}'` : "null"
  }, ${cancelled ? "now()" : "null"})`;

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
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'as-owner-${tag}@warmluke.test'),
  ('${STRANGER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'as-stranger-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name, restock_days) values ('${P}', '${OWNER}', 'ads stock ${tag}', 10);
insert into public.stores (id, project_id, shop_domain, status, timezone, currency)
  values ('${S}', '${P}', 'as-${tag}.myshopify.com', 'connected', 'Asia/Kolkata', 'INR');
insert into public.store_connections (id, project_id, store_id, provider, account_ref, status, connected_by)
  values ('${ADS}', '${P}', '${S}', 'meta_ads', 'act-${tag}', 'connected', '${OWNER}');
insert into public.import_runs (store_id, resource, status) values ('${S}', 'orders', 'done'), ('${S}', 'inventory', 'done');

insert into public.products (id, store_id, external_id, title, status) values
  ('${P1}', '${S}', 'as-p1-${tag}', 'Linen shirt', 'ACTIVE'),
  ('${P2}', '${S}', 'as-p2-${tag}', 'Cotton tee', 'ACTIVE'),
  ('${P3}', '${S}', 'as-p3-${tag}', 'Gift wrap', 'ACTIVE');
insert into public.variants (id, store_id, product_id, external_id, title, sku, tracked) values
  ('${V1}', '${S}', '${P1}', 'as-v1-${tag}', 'M', 'LIN-M', true),
  ('${V2}', '${S}', '${P1}', 'as-v2-${tag}', 'L', 'LIN-L', true),
  ('${V3}', '${S}', '${P2}', 'as-v3-${tag}', 'S', 'TEE-S', true),
  ('${V4}', '${S}', '${P3}', 'as-v4-${tag}', 'Default Title', 'WRAP', false);
insert into public.inventory_levels (store_id, variant_id, available) values
  ('${S}', '${V1}', 3), ('${S}', '${V2}', 0), ('${S}', '${V3}', 200), ('${S}', '${V4}', 0);

-- Diwali spent 4,500 over three days, Retarget 900, Brand 600 with no
-- order naming it; Old sale spent ten days ago, outside the window.
insert into public.ad_spend (project_id, store_id, connection_id, provider, campaign_id, campaign_name, day, spend, currency)
select '${P}', '${S}', '${ADS}', 'meta_ads', c.id, c.name, (now() at time zone 'Asia/Kolkata')::date - d - c.ago, c.spend, 'INR'
  from (values ('111', 'Diwali', 1500, 0), ('222', 'Retarget', 300, 0), ('333', 'Brand awareness', 200, 0), ('444', 'Old sale', 900, 10))
       c(id, name, spend, ago), generate_series(0, 2) d;

-- Diwali's own orders, by name in any case and by id; one cancelled and
-- one older than the window are not its; one with no campaign sets the pace.
insert into public.orders (id, store_id, external_id, order_number, placed_at, total, currency, utm_campaign, cancelled_at) values
  ${order(O1, 2, " diwali")}, ${order(O2, 1, "111")}, ${order(O3, 3, "Diwali", true)},
  ${order(O4, 4, "retarget")}, ${order(O5, 20, null)}, ${order(O6, 10, "Diwali")};
insert into public.order_line_items (store_id, order_id, product_id, variant_id, title, quantity) values
  ('${S}', '${O1}', '${P1}', '${V1}', 'Linen shirt', 2),
  ('${S}', '${O1}', '${P1}', '${V2}', 'Linen shirt', 1),
  ('${S}', '${O1}', '${P3}', '${V4}', 'Gift wrap', 1),
  ('${S}', '${O2}', '${P1}', '${V1}', 'Linen shirt', 1),
  ('${S}', '${O2}', '${P2}', '${V3}', 'Cotton tee', 1),
  ('${S}', '${O3}', '${P2}', '${V3}', 'Cotton tee', 50),
  ('${S}', '${O4}', '${P2}', '${V3}', 'Cotton tee', 4),
  ('${S}', '${O5}', '${P1}', '${V1}', 'Linen shirt', 11),
  ('${S}', '${O6}', '${P2}', '${V3}', 'Cotton tee', 10);

select pg_temp.say('read', ${as(OWNER, `public.abo_ads_stock('${S}', 7, 28, null)::text`)});
reset role;
select pg_temp.say('stranger', coalesce(${as(STRANGER, `public.abo_ads_stock('${S}', 7, 28, null)::text`)}, 'nothing'));
reset role;

-- The watch: off until turned on with its numbers (0199).
${run}
select pg_temp.say('off', ${open});
select pg_temp.as('${OWNER}');
select public.abo_set_alert_setting('${P}', 'ads_low_stock', true, '{"days": 7, "spend": 1000, "days_left": 10}');
reset role;
${run}
${run}
select pg_temp.say('on', ${open});
select pg_temp.say('rows', (select count(*)::text from public.alerts where store_id = '${S}' and kind = 'ads_low_stock'));
select pg_temp.say('facts', (select facts::text from public.alerts where store_id = '${S}' and kind = 'ads_low_stock' and status = 'open'));

-- The large size back in stock: still spending on the medium, no longer critical.
update public.inventory_levels set available = 100 where variant_id = '${V2}';
${run}
select pg_temp.say('one_back', ${open});

-- Over the owner's spend only: Diwali's 4,500 is under 5,000, quiet.
select pg_temp.as('${OWNER}');
select public.abo_set_alert_setting('${P}', 'ads_low_stock', true, '{"days": 7, "spend": 5000, "days_left": 10}');
reset role;
${run}
select pg_temp.say('under_spend', ${open});

-- Restocked: what was open closes.
select pg_temp.as('${OWNER}');
select public.abo_set_alert_setting('${P}', 'ads_low_stock', true, '{"days": 7, "spend": 1000, "days_left": 10}');
reset role;
${run}
update public.inventory_levels set available = 500 where variant_id = '${V1}';
${run}
select pg_temp.say('restocked', ${open});
select pg_temp.say('resolved', (select count(*)::text from public.alerts where store_id = '${S}' and kind = 'ads_low_stock' and status = 'resolved'));

select k, v from out;
rollback;
`);

const read = JSON.parse(r.read);
const camp = (name) => read.campaigns.find((c) => c.campaign === name);
const diwali = camp("Diwali");
const sku = (c, s) => (c.products ?? []).find((p) => p.sku === s);

console.log("what a campaign sells is what its own orders bought");
check(
  "the windows and the cover said",
  read.days === 7 && read.sales_days === 28 && read.cover_days === 10 && read.cover_from === "restock time"
);
check("its orders named by its name in any case, or by its id", diwali.orders === 2);
check(
  "a cancelled order, or one before the window, is not its",
  diwali.units === 6 && sku(diwali, "TEE-S").units === 1
);
check("its spend over the window only", diwali.spend === 4500 && !camp("Old sale"));
check(
  "each variant's stock, pace and days left, beside the restock time",
  sku(diwali, "LIN-M").available === 3 &&
    sku(diwali, "LIN-M").per_day === 0.5 &&
    sku(diwali, "LIN-M").days_left === 6 &&
    sku(diwali, "LIN-M").runs_out_soon === true
);
check(
  "one out of stock now is running out, and said so",
  sku(diwali, "LIN-L").runs_out_soon === true && sku(diwali, "LIN-L").said === "out of stock now"
);
check(
  "untracked stock does not run out",
  sku(diwali, "WRAP").runs_out_soon === false && /not tracked/.test(sku(diwali, "WRAP").said)
);
check(
  "the share running out and the spend on it",
  diwali.units_running_out === 4 && diwali.share_running_out === 0.67 && diwali.spend_on_it === 3000
);
check(
  "running out first",
  diwali.products
    .slice(0, 2)
    .map((p) => p.sku)
    .join() === "LIN-M,LIN-L"
);
const brand = camp("Brand awareness");
check(
  "a campaign no order names sells nothing known",
  brand.orders === 0 && brand.products === null && /not known/.test(brand.said)
);
check(
  "the most spent on stock running out first",
  read.campaigns.map((c) => c.campaign).join() === "Diwali,Retarget,Brand awareness"
);
check("one selling stock that lasts is not running out", camp("Retarget").share_running_out === 0);

console.log("\nunder the caller's own rights");
check("a stranger reads nothing of it", r.stranger === "nothing" || JSON.parse(r.stranger).campaigns.length === 0);

console.log("\nthe watch");
check("off until the owner turns it on", r.off === "none");
check("a campaign spending on stock running out rings, critical while one is out", r.on === "meta_ads:111:critical");
check("run twice, one alert", r.rows === "1");
const facts = JSON.parse(r.facts);
check(
  "its facts say the spend, the share and what is short",
  facts.campaign === "Diwali" &&
    facts.spend === 4500 &&
    facts.share === 0.67 &&
    facts.lead_days === 10 &&
    facts.products.map((p) => p.sku).join() === "LIN-M,LIN-L"
);
check("one back in stock, no longer critical", r.one_back === "meta_ads:111:attention");
check("under the owner's spend, quiet", r.under_spend === "none");
check("restocked, it closes", r.restocked === "none" && Number(r.resolved) >= 1);

console.log(fails.length ? `\n${fails.length} FAILED` : "\nads are read beside the stock their own orders bought");
process.exit(fails.length ? 1 : 0);
