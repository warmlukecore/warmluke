// How long stock lasts (0226, the sprint's Days 9–11), on the check
// project, inside one transaction that is rolled back.
//
// Every order line in the window, cancelled ones left out, against the
// stock on hand now, soonest out first; beside the owner's restock time,
// whether a variant runs out before a restock could arrive and the day to
// reorder by; one out of stock now, or quiet in its last week after
// selling earlier, has its pace said to be a floor; archived products and
// untracked variants are not counted; a stranger reads nothing.
//
//   ENV_FILE=.env.check.local node scripts/check-stock-cover.mjs
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
const id = (n) => `7a777777-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [OWNER, STRANGER, P, S] = [id(1), id(2), id(10), id(20)];
const [P1, P2, P3, P4, P5] = [id(31), id(32), id(33), id(34), id(35)];
const [V1, V2, V3, V4, V5, V6] = [id(41), id(42), id(43), id(44), id(45), id(46)];
const [O1, O2, O3] = [id(51), id(52), id(53)];
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
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sc-owner-${tag}@warmluke.test'),
  ('${STRANGER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sc-stranger-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name, restock_days) values ('${P}', '${OWNER}', 'stock cover ${tag}', 10);
insert into public.stores (id, project_id, shop_domain, status, timezone, currency)
  values ('${S}', '${P}', 'sc-${tag}.myshopify.com', 'connected', 'Asia/Kolkata', 'INR');
insert into public.products (id, store_id, external_id, title, status) values
  ('${P1}', '${S}', 'sc-p1-${tag}', 'Linen shirt', 'ACTIVE'),
  ('${P2}', '${S}', 'sc-p2-${tag}', 'Cotton tee', 'ACTIVE'),
  ('${P3}', '${S}', 'sc-p3-${tag}', 'Kurta', 'ACTIVE'),
  ('${P4}', '${S}', 'sc-p4-${tag}', 'Scarf', 'ACTIVE'),
  ('${P5}', '${S}', 'sc-p5-${tag}', 'Old mug', 'ARCHIVED');
insert into public.variants (id, store_id, product_id, external_id, title, sku, tracked) values
  ('${V1}', '${S}', '${P1}', 'sc-v1-${tag}', 'M', 'LIN-M', true),
  ('${V2}', '${S}', '${P2}', 'sc-v2-${tag}', 'S', 'TEE-S', true),
  ('${V3}', '${S}', '${P3}', 'sc-v3-${tag}', 'L', 'KUR-L', true),
  ('${V4}', '${S}', '${P4}', 'sc-v4-${tag}', 'Default Title', 'SCARF', true),
  ('${V5}', '${S}', '${P5}', 'sc-v5-${tag}', 'Default Title', 'MUG', true),
  ('${V6}', '${S}', '${P1}', 'sc-v6-${tag}', 'Gift wrap', 'WRAP', false);
insert into public.inventory_levels (store_id, variant_id, available) values
  ('${S}', '${V1}', 14), ('${S}', '${V2}', 5), ('${S}', '${V3}', 0), ('${S}', '${V4}', 20), ('${S}', '${V5}', 1), ('${S}', '${V6}', 0);
insert into public.orders (id, store_id, external_id, order_number, placed_at, total, currency, cancelled_at) values
  ('${O1}', '${S}', 'sc-o1-${tag}', '#S1', now() - interval '3 days', 100, 'INR', null),
  ('${O2}', '${S}', 'sc-o2-${tag}', '#S2', now() - interval '20 days', 100, 'INR', null),
  ('${O3}', '${S}', 'sc-o3-${tag}', '#S3', now() - interval '5 days', 100, 'INR', now() - interval '4 days');
insert into public.order_line_items (store_id, order_id, product_id, variant_id, title, quantity) values
  ('${S}', '${O1}', '${P1}', '${V1}', 'Linen shirt', 14),
  ('${S}', '${O1}', '${P2}', '${V2}', 'Cotton tee', 14),
  ('${S}', '${O2}', '${P1}', '${V1}', 'Linen shirt', 14),
  ('${S}', '${O2}', '${P2}', '${V2}', 'Cotton tee', 14),
  ('${S}', '${O2}', '${P3}', '${V3}', 'Kurta', 7),
  ('${S}', '${O2}', '${P4}', '${V4}', 'Scarf', 10),
  ('${S}', '${O2}', '${P5}', '${V5}', 'Old mug', 10),
  ('${S}', '${O2}', '${P1}', '${V6}', 'Gift wrap', 10),
  ('${S}', '${O3}', '${P1}', '${V1}', 'Linen shirt', 100);

select pg_temp.say('today_plus_4', (current_date + 4)::text);
select pg_temp.say('today', current_date::text);
select pg_temp.say('cover', ${as(OWNER, `public.abo_stock_cover('${S}', 28, 50)::text`)});
reset role;
select pg_temp.say('stranger', ${as(STRANGER, `public.abo_stock_cover('${S}', 28, 50)::text`)});
reset role;
update public.projects set restock_days = null where id = '${P}';
select pg_temp.say('no_lead', ${as(OWNER, `public.abo_stock_cover('${S}', 28, 50)::text`)});
reset role;

select k, v from out;
rollback;
`);

const cover = JSON.parse(r.cover);
const row = (o, sku) => o.variants.find((v) => v.sku === sku);
console.log("every line in the window, against the stock on hand");
check("the window and the restock time said", cover.days === 28 && cover.lead_days === 10);
const lin = row(cover, "LIN-M");
check("a cancelled order is not a sale", lin.sold === 28 && lin.per_day === 1);
check("the days it lasts", lin.available === 14 && lin.days_left === 14);
check("soonest out first", cover.variants.map((v) => v.sku).join() === "KUR-L,TEE-S,LIN-M,SCARF");
check(
  "an archived product and an untracked variant are not counted",
  !row(cover, "MUG") && !row(cover, "WRAP") && cover.selling === 4
);

console.log("\nbeside the restock time");
check(
  "one that outlasts a restock: reorder by the day it must",
  lin.runs_out_before_restock === false && lin.reorder_by === r.today_plus_4
);
const tee = row(cover, "TEE-S");
check("one that runs out first: reorder today", tee.runs_out_before_restock === true && tee.reorder_by === r.today);

console.log("\nno stock history, said");
const kurta = row(cover, "KUR-L");
check(
  "out of stock now: its pace is a floor",
  kurta.pace_is_a_floor === true && /out of stock now/.test(kurta.why_a_floor)
);
const scarf = row(cover, "SCARF");
check(
  "quiet in its last week after selling earlier: a floor too",
  scarf.pace_is_a_floor === true && /nothing in its last week/.test(scarf.why_a_floor)
);
check("one selling steadily is not", lin.pace_is_a_floor === false && !lin.why_a_floor);

console.log("\nunder the caller's own rights, and without a restock time");
check("a stranger reads nothing of it", JSON.parse(r.stranger).variants.length === 0);
const noLead = JSON.parse(r.no_lead);
check(
  "no restock time: no reorder day guessed",
  noLead.lead_days === null &&
    row(noLead, "TEE-S").reorder_by === null &&
    row(noLead, "TEE-S").runs_out_before_restock === null
);

console.log(
  fails.length
    ? `\n${fails.length} FAILED`
    : "\nhow long stock lasts is counted over every sale, and says what it cannot know"
);
process.exit(fails.length ? 1 : 0);
