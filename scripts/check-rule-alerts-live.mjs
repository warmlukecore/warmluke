// A rule that tells (0164), against the check database, in one
// transaction that is rolled back.
//
// A row of theirs added is told once; a row the store brings in is told
// the moment it arrives, never during the first import; a schedule keeps
// its alerts open while their rows match and closes them once they do
// not. Whoever sees the rule's section sees its alerts, nobody else; a
// rule turned off hides them, a rule deleted takes them; at most 50 open.
//
//   ENV_FILE=.env.check.local node scripts/check-rule-alerts-live.mjs
//
// now() holds still inside a transaction, so where a schedule asks what
// it did not raise again, the earlier run's time is put back first.

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
const [OWNER, MEMBER, FRIEND] = [id(1), id(2), id(3)];
const [P, S, OWN, ORD] = [id(10), id(20), id(30), id(31)];
const [R_LOW, R_BIG, R_UNPAID, R_ALL] = [id(40), id(41), id(42), id(43)];
const [SEAT_MEMBER, SEAT_FRIEND] = [id(50), id(51)];
const order = (n, total, pay = "PAID") =>
  `insert into public.orders (id, store_id, external_id, order_number, placed_at, total, currency, financial_status)
   values ('${id(100 + n)}', '${S}', 'ra-${tag}-${n}', '#R${n}', now() - interval '1 hour', ${total}, 'INR', '${pay}');`;
const rule = (rid, module, name, definition) =>
  `insert into public.automations (id, project_id, module_id, name, definition, enabled)
   values ('${rid}', '${P}', '${module}', '${name}', '${JSON.stringify(definition)}', true);`;
const open = (rid) => `(select count(*)::text from public.alerts where automation_id = '${rid}' and status = 'open')`;
const ruleAlerts = `jsonb_array_elements(public.abo_alerts('${P}')) a where a ->> 'kind' = 'rule'`;
const sees = `(select count(*)::text from ${ruleAlerts})`;

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
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ra-owner-${tag}@warmluke.test'),
  ('${MEMBER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ra-member-${tag}@warmluke.test'),
  ('${FRIEND}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ra-friend-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name) values ('${P}', '${OWNER}', 'rule alerts ${tag}');
-- The member reads the store but has no section shared; the friend has
-- the suppliers shared, and not the store.
insert into public.project_members (id, project_id, user_id, email, joined_at, can_see_store) values
  ('${SEAT_MEMBER}', '${P}', '${MEMBER}', 'ra-member-${tag}@warmluke.test', now(), true),
  ('${SEAT_FRIEND}', '${P}', '${FRIEND}', 'ra-friend-${tag}@warmluke.test', now(), false);
insert into public.stores (id, project_id, shop_domain, status, timezone, currency, last_synced_at)
  values ('${S}', '${P}', 'ra-${tag}.myshopify.com', 'connected', 'Asia/Kolkata', 'INR', now());
insert into public.modules (id, project_id, name, nav_label, route, source_table, created_by) values
  ('${OWN}', '${P}', 'suppliers-${tag}', 'Suppliers', '/modules/suppliers-${tag}', null, '${OWNER}'),
  ('${ORD}', '${P}', 'orders-${tag}', 'Orders', '/modules/orders-${tag}', 'orders', '${OWNER}');
insert into public.ui_schemas (module_id, schema_json, version) values
  ('${OWN}', '{"columns":[{"field":"name","label":"Name","type":"text"},{"field":"qty","label":"Qty","type":"number"}]}', 1),
  ('${ORD}', '{"columns":[]}', 1);
insert into public.module_shares (module_id, member_id) values ('${OWN}', '${SEAT_FRIEND}');

${rule(R_LOW, OWN, "Tell me when a supplier runs low", {
  trigger: { type: "record_created", when: { op: "<", args: [{ field: "qty" }, { const: 5 }] } },
  actions: [{ type: "alert", title: "Running out", show: ["name", "qty"] }],
})}
${rule(R_BIG, ORD, "Tell me about big orders", {
  trigger: { type: "store_row_added", when: { op: ">", args: [{ field: "total" }, { const: 5000 }] } },
  actions: [{ type: "alert", title: "Big order", show: ["order_number", "total"], severity: "critical" }],
})}
${rule(R_UNPAID, ORD, "Tell me what is not paid", {
  trigger: {
    type: "schedule",
    every: "hourly",
    when: { op: "=", args: [{ field: "financial_status" }, { const: "PENDING" }] },
  },
  actions: [{ type: "alert", title: "Not paid yet", show: ["order_number"] }],
})}

-- A row of theirs added: told once, with what it shows; one that is fine is not told.
insert into public.records (project_id, module_id, data) values
  ('${P}', '${OWN}', '{"name":"Cotton","qty":3}'), ('${P}', '${OWN}', '{"name":"Linen","qty":10}');
select pg_temp.say('low', ${open(R_LOW)});
select pg_temp.say('low_says', (select (facts->>'title') || '|' || (facts->'values')::text from public.alerts where automation_id = '${R_LOW}'));

-- A row the store brings in: a big one told at once, critical; a small one not.
${order(1, 6200)}
${order(2, 100)}
select pg_temp.say('big', ${open(R_BIG)} || '|' || (select severity || '|' || subject from public.alerts where automation_id = '${R_BIG}'));
-- During the store's first import, nothing is news.
update public.stores set last_synced_at = null where id = '${S}';
${order(3, 9000)}
update public.stores set last_synced_at = now() where id = '${S}';
select pg_temp.say('importing', ${open(R_BIG)});

-- A schedule: open while the row matches, closed once it does not; no empty records laid beside the rows.
${order(4, 500, "PENDING")}
${order(5, 700, "PENDING")}
select public.run_scheduled_automations();
select pg_temp.say('unpaid', ${open(R_UNPAID)});
select pg_temp.say('no_records', (select count(*)::text from public.records where module_id = '${ORD}'));
update public.alerts set raised_at = now() - interval '1 hour' where automation_id = '${R_UNPAID}';
update public.orders set financial_status = 'PAID' where id = '${id(104)}';
update public.automations set scheduled_at = null where id = '${R_UNPAID}';
select public.run_scheduled_automations();
select pg_temp.say('paid_closes', ${open(R_UNPAID)} || '|' || (select status from public.alerts where automation_id = '${R_UNPAID}' and subject = '${id(104)}'));

-- Who sees what.
select pg_temp.as('${OWNER}');
select pg_temp.say('owner', ${sees});
select pg_temp.as('${MEMBER}');
select pg_temp.say('member_none', ${sees});
select pg_temp.say('member_rows', (select count(*)::text from public.alerts where project_id = '${P}' and automation_id is not null));
select public.abo_alerts_seen(array(select id from public.alerts where automation_id = '${R_LOW}'), true);
reset role;
select pg_temp.say('member_marked', (select count(*)::text from public.alert_reads where user_id = '${MEMBER}'));
update public.modules set shared_with_team = true where id = '${ORD}';
select pg_temp.as('${MEMBER}');
select pg_temp.say('member_orders', ${sees});
select pg_temp.as('${FRIEND}');
select pg_temp.say('friend', (select count(*)::text || '|' || coalesce(bool_and(a ->> 'rule_id' = '${R_LOW}')::text, '') from ${ruleAlerts}));
reset role;

-- Turned off, hidden; deleted, gone.
update public.automations set enabled = false where id = '${R_BIG}';
select pg_temp.as('${OWNER}');
select pg_temp.say('off', ${sees});
reset role;
delete from public.automations where id = '${R_LOW}';
select pg_temp.say('deleted', (select count(*)::text from public.alerts where automation_id = '${R_LOW}'));

-- A rule that matches every row says so 50 times.
${rule(R_ALL, OWN, "Tell me about every supplier", {
  trigger: { type: "schedule", every: "hourly" },
  actions: [{ type: "alert", title: "A supplier" }],
})}
insert into public.records (project_id, module_id, data)
  select '${P}', '${OWN}', jsonb_build_object('name', 'S' || g, 'qty', 100) from generate_series(1, 60) g;
select public.run_scheduled_automations();
select pg_temp.say('capped', ${open(R_ALL)});

-- Their own alerts are switched with their rule, not in the list of what Luke watches.
select pg_temp.as('${OWNER}');
select pg_temp.say('settings', (select string_agg(s ->> 'kind', ',') from jsonb_array_elements(public.abo_alert_settings('${P}')) s));
select pg_temp.say('set_rule', pg_temp.try($q$select public.abo_set_alert_setting('${P}', 'rule', false, '{}')::text$q$));
reset role;

-- Luke's own still run beside them, and leave theirs alone.
select public.abo_alerts_run('${S}');
select pg_temp.say('after_run', ${open(R_UNPAID)});

select k, v from out;
rollback;
`);

console.log("a rule tells");
check("a row of theirs added, told once; one that is fine, not", r.low === "1");
check(
  "with its title and the fields it shows",
  r.low_says === 'Running out|[{"field": "name", "value": "Cotton"}, {"field": "qty", "value": "3"}]'
);
check("a big order the store brings in, told at once, critical, about that order", r.big === `1|critical|${id(101)}`);
check("not during the store's first import", r.importing === "1");
check("a schedule tells about each row that matches", r.unpaid === "2");
check("and lays no empty records beside the store's rows", r.no_records === "0");
check("paid, it closes; the other stays", r.paid_closes === "1|resolved");

console.log("\nwho sees it");
check("the owner sees all three rules' alerts", r.owner === "3");
check("a teammate without the sections sees none of them", r.member_none === "0" && r.member_rows === "0");
check("and cannot mark one", r.member_marked === "0");
check("shared with the team, they see the store's", r.member_orders === "2");
check("the suppliers, shared with one person, are that person's alone", r.friend === "1|true");

console.log("\nthe rule decides");
check("turned off, its alerts are hidden", r.off === "2");
check("deleted, they go with it", r.deleted === "0");
check("50 open a rule, however many rows match", r.capped === "50");
check("not in the list of what Luke watches", r.settings === "low_stock,dispatch_late,returns_spike,return_reason");
check("and not switched there", r.set_rule?.includes("No such kind"));
check("Luke's own look leaves them alone", r.after_run === "1");

console.log(fails.length ? `\n${fails.length} FAILED` : "\na rule tells whoever sees its section, and only them");
process.exit(fails.length ? 1 : 0);
