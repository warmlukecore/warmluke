// RTO by comparable cohorts (0225, the sprint's Days 9–11), on the check
// project, inside one transaction that is rolled back.
//
// The last 14 days beside the 14 before, each rate over the shipments that
// settled, what is still moving and what went quiet said apart; broken
// down by courier, payment and the order's state; a group with too few
// settled shipments gets counts and no rate; read under the caller's own
// rights, so a stranger reads nothing.
//
//   ENV_FILE=.env.check.local node scripts/check-rto-cohorts.mjs
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
const [OWNER, STRANGER, P, S, SHIP, ORDER] = [id(1), id(2), id(10), id(20), id(30), id(40)];
// n shipments by one courier and payment, sent `ago` days back: `rto` returned, `moving` not settled, the rest delivered.
const ships = (from, n, courier, pay, ago, rto, moving = 0) =>
  `insert into public.courier_shipments (project_id, store_id, connection_id, provider, shipment_ref, courier, payment_mode, rto, shipped_at, delivered_at, status_at)
   select '${P}', '${S}', '${SHIP}', 'shiprocket', 'rc-${tag}-' || g, '${courier}', '${pay}', g < ${from + rto},
          now() - interval '${ago} days',
          case when g >= ${from + rto} and g < ${from + n - moving} then now() - interval '${Math.max(0, ago - 2)} days' end,
          now() - interval '${Math.max(0, ago - 1)} days'
     from generate_series(${from}, ${from + n - 1}) g;`;
const as = (who, sql) => `(select ${sql} from (select pg_temp.as('${who}')) x)`;

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
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rc-owner-${tag}@warmluke.test'),
  ('${STRANGER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rc-stranger-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name) values ('${P}', '${OWNER}', 'rto cohorts ${tag}');
insert into public.stores (id, project_id, shop_domain, status, timezone, currency)
  values ('${S}', '${P}', 'rc-${tag}.myshopify.com', 'connected', 'Asia/Kolkata', 'INR');
insert into public.store_connections (id, project_id, store_id, provider, account_ref, status, connected_by) values
  ('${SHIP}', '${P}', '${S}', 'shiprocket', 'ship-${tag}', 'connected', '${OWNER}');
insert into public.orders (id, store_id, external_id, order_number, placed_at, total, currency, ship_state)
  values ('${ORDER}', '${S}', 'rc-o-${tag}', '#RC1', now() - interval '6 days', 900, 'INR', 'Bihar');

-- The last 14 days: Delhivery (COD) 25 sent, 10 back, 5 still moving; Bluedart (prepaid) 20 sent, 2 back.
${ships(1, 25, "Delhivery", "COD", 5, 10, 5)}
${ships(100, 20, "Bluedart", "Prepaid", 6, 2)}
-- The 14 before: Delhivery 40 settled, 4 back; and 2 that went quiet, no word in three weeks.
${ships(200, 40, "Delhivery", "COD", 20, 4)}
insert into public.courier_shipments (project_id, store_id, connection_id, provider, shipment_ref, courier, rto, shipped_at, status_at, updated_at)
  select '${P}', '${S}', '${SHIP}', 'shiprocket', 'rc-q-${tag}-' || g, 'Delhivery', false, now() - interval '25 days', now() - interval '25 days', now() - interval '25 days'
    from generate_series(1, 2) g;
-- One returned parcel from an order in Bihar.
update public.courier_shipments set order_id = '${ORDER}' where shipment_ref = 'rc-${tag}-1';

select pg_temp.say('courier', ${as(OWNER, `public.abo_rto_cohorts('${S}', 14, 'courier', 20)::text`)});
reset role;
select pg_temp.say('strict', ${as(OWNER, `public.abo_rto_cohorts('${S}', 14, 'courier', 25)::text`)});
reset role;
select pg_temp.say('payment', ${as(OWNER, `public.abo_rto_cohorts('${S}', 14, 'payment', 20)::text`)});
reset role;
select pg_temp.say('state', ${as(OWNER, `public.abo_rto_cohorts('${S}', 14, 'state', 5)::text`)});
reset role;
select pg_temp.say('stranger', ${as(STRANGER, `public.abo_rto_cohorts('${S}', 14, 'courier', 20)::text`)});
reset role;

select k, v from out;
rollback;
`);

const courier = JSON.parse(r.courier);
const group = (o, name) => o.groups.find((g) => g.name === name);
console.log("the last 14 days beside the 14 before");
check(
  "each rate over the shipments that settled, said so",
  courier.now.rate === 30 && courier.now.settled === 40 && courier.now.rto === 12 && /settled/.test(courier.denominator)
);
check("what is still moving is counted apart", courier.now.moving === 5 && courier.now.shipped === 45);
check(
  "the cohort before, its quiet ones said apart and out of the rate",
  courier.before.rate === 10 && courier.before.settled === 40 && courier.before.quiet === 2
);

console.log("\nbroken down, worst first, only where there are enough");
const del = group(courier, "Delhivery");
check(
  "the worst courier first, with its change",
  courier.groups[0].name === "Delhivery" && del.rate === 50 && del.rate_before === 10 && del.change === 40
);
check(
  "a group with nothing before gets no change",
  group(courier, "Bluedart").rate === 10 && group(courier, "Bluedart").change === null
);
const strict = JSON.parse(r.strict);
check(
  "with too few settled, counts and no rate",
  group(strict, "Delhivery").too_few === true && group(strict, "Delhivery").rate === null
);
const payment = JSON.parse(r.payment);
check("by payment: COD apart from prepaid", group(payment, "COD").rto === 10 && group(payment, "Prepaid").rto === 2);
const state = JSON.parse(r.state);
check(
  "by the order's state, through the order",
  group(state, "Bihar")?.rto === 1 && group(state, "Unknown state").shipped === 44
);

console.log("\nunder the caller's own rights");
const stranger = JSON.parse(r.stranger);
check("a stranger reads nothing of it", !stranger.now.shipped && stranger.groups.length === 0);

console.log(
  fails.length
    ? `\n${fails.length} FAILED`
    : "\nRTO is compared like with like, over every shipment, and says what it cannot know"
);
process.exit(fails.length ? 1 : 0);
