// What Luke noticed (0163), against the check database, in one
// transaction that is rolled back.
//
// The landing promised that Luke watches the store: stock running out,
// orders not sent, returns rising, a return reason coming back. Each is
// found from the store's own rows, only once the import it needs is
// done; it opens once, its numbers move without ringing the bell again,
// it rings again when it gets worse, closes when the problem goes and
// opens fresh if it comes back. Only the store's people see it, and
// only a builder changes what is watched.
//
//   ENV_FILE=.env.check.local node scripts/check-alerts.mjs
//
// now() holds still inside a transaction, so where a check asks whether
// a run moved a time, the time is put back first.

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
const [OWNER, MEMBER, STRANGER] = [id(1), id(2), id(3)];
const [P, OTHER, S] = [id(10), id(11), id(20)];
const [P1, P2, P3, V1, V2, V3] = [id(30), id(31), id(32), id(40), id(41), id(42)];
const [C1, C2, C3] = [id(50), id(51), id(52)];
const order = (n, placed, cancelled = "null") =>
  `insert into public.orders (id, store_id, external_id, order_number, placed_at, total, currency, financial_status, fulfilment_status, cancelled_at)
   values ('${id(100 + n)}', '${S}', 'al-${tag}-${n}', '#A${n}', ${placed}, 100, 'INR', 'PAID', '${n === 1 ? "FULFILLED" : "UNFULFILLED"}', ${cancelled});`;
const open = `(select string_agg(kind || ':' || severity, ',' order by kind) from public.alerts where store_id = '${S}' and status = 'open')`;
const run = `select public.abo_alerts_run('${S}');`;
const lowStock = `(select id from public.alerts where subject = '${V1}')`;

const r = psql(`
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

insert into auth.users (id, instance_id, aud, role, email) values
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'al-owner-${tag}@warmluke.test'),
  ('${MEMBER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'al-member-${tag}@warmluke.test'),
  ('${STRANGER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'al-stranger-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name) values ('${P}', '${OWNER}', 'alerts ${tag}'), ('${OTHER}', '${STRANGER}', 'other ${tag}');
insert into public.project_members (project_id, user_id, email, joined_at, can_see_store)
  values ('${P}', '${MEMBER}', 'al-member-${tag}@warmluke.test', now(), true);
insert into public.stores (id, project_id, shop_domain, status, timezone, currency)
  values ('${S}', '${P}', 'al-${tag}.myshopify.com', 'connected', 'Asia/Kolkata', 'INR');
insert into public.conversations (id, project_id, title) values
  ('${C1}', '${P}', 'one'), ('${C2}', '${OTHER}', 'theirs'), ('${C3}', '${P}', 'two');

-- A shirt that sells a unit a day with five left; a mug that sold as
-- well but is archived; a gift card nobody counts.
insert into public.products (id, store_id, external_id, title, status) values
  ('${P1}', '${S}', 'al-p1-${tag}', 'Linen shirt', 'ACTIVE'),
  ('${P2}', '${S}', 'al-p2-${tag}', 'Old mug', 'ARCHIVED'),
  ('${P3}', '${S}', 'al-p3-${tag}', 'Gift card', 'ACTIVE');
insert into public.variants (id, store_id, product_id, external_id, title, sku, tracked) values
  ('${V1}', '${S}', '${P1}', 'al-v1-${tag}', 'M', 'LIN-M', true),
  ('${V2}', '${S}', '${P2}', 'al-v2-${tag}', 'Default Title', 'MUG', true),
  ('${V3}', '${S}', '${P3}', 'al-v3-${tag}', 'Default Title', 'GIFT', false);
insert into public.inventory_levels (store_id, variant_id, available) values ('${S}', '${V1}', 5), ('${S}', '${V2}', 1), ('${S}', '${V3}', 0);
${order(1, "now() - interval '3 days'")}
insert into public.order_line_items (store_id, order_id, product_id, variant_id, title, quantity) values
  ('${S}', '${id(101)}', '${P1}', '${V1}', 'Linen shirt', 14),
  ('${S}', '${id(101)}', '${P2}', '${V2}', 'Old mug', 14),
  ('${S}', '${id(101)}', '${P3}', '${V3}', 'Gift card', 14);
-- Not sent after 60 hours: late. Sent, months old, cancelled, or 10 hours old: not.
${order(2, "now() - interval '60 hours'")}
${order(3, "now() - interval '60 hours'")}
${order(4, "now() - interval '40 days'")}
${order(5, "now() - interval '60 hours'", "now()")}
${order(6, "now() - interval '10 hours'")}
insert into public.fulfillments (store_id, order_id, external_id, shipped_at) values ('${S}', '${id(103)}', 'al-f-${tag}', now() - interval '1 day');
-- The shirt: four back this week, none before. The mug: five back this
-- week, but it always comes back that much. "Too small" three times.
insert into public.returns (id, store_id, order_id, external_id, status, requested_at) values
  ('${id(200)}', '${S}', '${id(101)}', 'al-r1-${tag}', 'REQUESTED', now() - interval '2 days'),
  ('${id(201)}', '${S}', '${id(101)}', 'al-r2-${tag}', 'CLOSED', now() - interval '25 days');
insert into public.return_line_items (store_id, return_id, product_id, title, quantity, reason, reason_note) values
  ('${S}', '${id(200)}', '${P1}', 'Linen shirt', 4, 'Too small', 'Runs a size small'),
  ('${S}', '${id(200)}', '${P3}', 'Gift card', 1, 'Too small', null),
  ('${S}', '${id(200)}', '${P3}', 'Gift card', 1, ' too small ', null),
  ('${S}', '${id(200)}', '${P2}', 'Old mug', 5, 'Other', null),
  ('${S}', '${id(201)}', '${P2}', 'Old mug', 12, 'Other', null);

-- Nothing is noticed before the imports it needs are done.
${run}
select pg_temp.say('before_ready', coalesce(${open}, 'none'));
delete from public.alert_dirty where store_id = '${S}';
insert into public.import_runs (store_id, resource, status) values
  ('${S}', 'orders', 'done'), ('${S}', 'inventory', 'done'), ('${S}', 'fulfillments', 'done'), ('${S}', 'returns', 'done');
select pg_temp.say('dirty_after_import', (select count(*)::text from public.alert_dirty where store_id = '${S}'));

-- Nothing is watched until the merchant turns it on and gives its numbers (0199).
${run}
select pg_temp.say('off_by_default', coalesce(${open}, 'none'));
select pg_temp.as('${OWNER}');
select pg_temp.say('listed_off', (select string_agg((s ->> 'kind') || ':' || (s ->> 'enabled') || ':' || (s ->> 'set') || ':' || (s ->> 'settings'), ',')
  from jsonb_array_elements(public.abo_alert_settings('${P}')) s));
select public.abo_set_alert_setting('${P}', 'low_stock', true, '{}');
reset role;
select pg_temp.say('on_without_numbers', coalesce(${open}, 'none'));
-- Their numbers given, each watches: the ones this check was written for.
select pg_temp.as('${OWNER}');
select public.abo_set_alert_setting('${P}', 'low_stock', true, '{"days_left": 7, "sales_days": 14}');
select public.abo_set_alert_setting('${P}', 'dispatch_late', true, '{"hours": 48, "since_days": 30}');
select public.abo_set_alert_setting('${P}', 'returns_spike', true, '{"min": 3, "times": 2}');
select public.abo_set_alert_setting('${P}', 'return_reason', true, '{"min": 3, "days": 14}');
reset role;
${run}
select pg_temp.say('found', ${open});
select pg_temp.say('dirty_after_run', (select count(*)::text from public.alert_dirty where store_id = '${S}'));
select pg_temp.say('stock', (select subject || '|' || (facts->>'days_left') || '|' || (facts->>'product') || '|' || (facts->>'variant')
  from public.alerts where store_id = '${S}' and kind = 'low_stock'));
select pg_temp.say('late', (select (facts->>'count') || '|' || (facts->'orders')::text from public.alerts where store_id = '${S}' and kind = 'dispatch_late'));
select pg_temp.say('spike', (select facts->>'product' from public.alerts where store_id = '${S}' and kind = 'returns_spike'));
select pg_temp.say('reason', (select (facts->>'count') || '|' || (facts->'products')::text || '|' || (facts->'notes')::text
  from public.alerts where store_id = '${S}' and kind = 'return_reason'));

-- Run again with nothing new: nothing moves. Two units sold: the
-- numbers move, the bell does not.
update public.alerts set changed_at = now() - interval '1 hour' where store_id = '${S}';
${run}
select pg_temp.say('still', (select count(*)::text from public.alerts where store_id = '${S}' and changed_at = now()));
update public.inventory_levels set available = 3 where variant_id = '${V1}';
${run}
select pg_temp.say('numbers_moved', (select (facts->>'available') || '|' || (changed_at < now())::text from public.alerts where subject = '${V1}'));

-- The people of the store see it; nobody else does.
select pg_temp.as('${OWNER}');
select pg_temp.say('owner_sees', (select jsonb_array_length(public.abo_alerts('${P}'))::text));
select pg_temp.say('owner_rows', (select count(*)::text from public.alerts where project_id = '${P}'));
select pg_temp.say('reads_closed', pg_temp.try('select count(*)::text from public.alert_reads'));
select pg_temp.say('first_unread', (select (public.abo_alerts('${P}') -> 0 ->> 'read')));
select public.abo_alerts_seen(array(select id from public.alerts where store_id = '${S}'));
select pg_temp.say('seen', (select string_agg(a ->> 'read', ',') from jsonb_array_elements(public.abo_alerts('${P}')) a));
select public.abo_alerts_seen(array[${lowStock}], true);
select pg_temp.say('put_away', (select count(*)::text from jsonb_array_elements(public.abo_alerts('${P}')) a where a ->> 'kind' = 'low_stock'));
select pg_temp.as('${OWNER}', 'mcp-client');
select pg_temp.say('mcp_seen', pg_temp.try($q$select public.abo_alerts_seen('{}'::uuid[])::text$q$));
select pg_temp.say('mcp_reads', (select jsonb_array_length(public.abo_alerts('${P}'))::text));
select pg_temp.as('${MEMBER}');
select pg_temp.say('member_sees', (select jsonb_array_length(public.abo_alerts('${P}'))::text));
select pg_temp.say('member_sets', pg_temp.try($q$select public.abo_set_alert_setting('${P}', 'low_stock', false, '{}')::text$q$));
select pg_temp.as('${STRANGER}');
select pg_temp.say('stranger_list', pg_temp.try($q$select public.abo_alerts('${P}')::text$q$));
select pg_temp.say('stranger_rows', (select count(*)::text from public.alerts where project_id = '${P}'));
select public.abo_alerts_seen(array(select id from public.alerts where store_id = '${S}'));
reset role;
select pg_temp.say('stranger_wrote', (select count(*)::text from public.alert_reads where user_id = '${STRANGER}'));

-- Down to a day's worth: worse, so it rings, and comes back from where it was put away, unread.
update public.alert_reads set read_at = now() - interval '30 minutes', dismissed_at = now() - interval '30 minutes';
update public.inventory_levels set available = 1 where variant_id = '${V1}';
${run}
select pg_temp.say('worse', (select severity || '|' || (changed_at = now())::text from public.alerts where subject = '${V1}'));
select pg_temp.as('${OWNER}');
select pg_temp.say('back_unread', (select a ->> 'read' from jsonb_array_elements(public.abo_alerts('${P}')) a where a ->> 'kind' = 'low_stock'));

-- Asked of Luke: the thread is kept on it, the first one only, and only one of this project.
select pg_temp.say('link', (select public.abo_alert_link(${lowStock}, '${C1}')::text));
select pg_temp.say('link_again', (select public.abo_alert_link(${lowStock}, '${C3}')::text));
select pg_temp.say('link_theirs', pg_temp.try($q$select public.abo_alert_link(${lowStock}, '${C2}')::text$q$));
select pg_temp.say('linked', (select a ->> 'conversation_id' from jsonb_array_elements(public.abo_alerts('${P}')) a where a ->> 'kind' = 'low_stock'));
reset role;

-- Restocked: it closes. Out again: it opens fresh, with no thread.
update public.alerts set opened_at = now() - interval '1 hour' where subject = '${V1}';
update public.inventory_levels set available = 100 where variant_id = '${V1}';
${run}
select pg_temp.say('closed', (select status || '|' || (resolved_at is not null)::text from public.alerts where subject = '${V1}'));
update public.inventory_levels set available = 1 where variant_id = '${V1}';
${run}
select pg_temp.say('reopened', (select status || '|' || (opened_at = now())::text || '|' || coalesce(conversation_id::text, 'none') from public.alerts where subject = '${V1}'));

-- An inventory walked again: half a list proves nothing, so it stays as it was.
update public.import_runs set status = 'running' where store_id = '${S}' and resource = 'inventory';
update public.inventory_levels set available = 100 where variant_id = '${V1}';
${run}
select pg_temp.say('mid_recheck', (select status from public.alerts where subject = '${V1}'));
update public.import_runs set status = 'done' where store_id = '${S}' and resource = 'inventory';
update public.inventory_levels set available = 1 where variant_id = '${V1}';

-- A check that breaks leaves its own alerts as they were, and the rest run.
update public.alert_kinds set check_fn = 'abo_alert_missing' where kind = 'return_reason';
update public.orders set cancelled_at = now() where id = '${id(102)}';
${run}
select pg_temp.say('broken_kept', (select status from public.alerts where store_id = '${S}' and kind = 'return_reason'));
select pg_temp.say('others_ran', (select status from public.alerts where store_id = '${S}' and kind = 'dispatch_late'));
update public.alert_kinds set check_fn = 'abo_alert_return_reason' where kind = 'return_reason';

-- What is watched: a builder's to change, only the settings there are, as numbers.
select pg_temp.as('${OWNER}');
select pg_temp.say('unknown_setting', pg_temp.try($q$select public.abo_set_alert_setting('${P}', 'low_stock', true, '{"colour": 1}')::text$q$));
select pg_temp.say('not_number', pg_temp.try($q$select public.abo_set_alert_setting('${P}', 'low_stock', true, '{"days_left": "7"}')::text$q$));
select pg_temp.say('no_kind', pg_temp.try($q$select public.abo_set_alert_setting('${P}', 'weather', true, '{}')::text$q$));
select pg_temp.say('one_left_out', (select (s ->> 'set') || '|' || (s ->> 'settings') from jsonb_array_elements(
  public.abo_set_alert_setting('${P}', 'return_reason', true, '{"min": 4}')) s where s ->> 'kind' = 'return_reason'));
select pg_temp.say('left_out_closed', (select status from public.alerts where store_id = '${S}' and kind = 'return_reason'));
select pg_temp.say('threshold', (select s ->> 'settings' from jsonb_array_elements(
  public.abo_set_alert_setting('${P}', 'return_reason', true, '{"min": 4, "days": 14}')) s where s ->> 'kind' = 'return_reason'));
select pg_temp.say('threshold_closed', (select status from public.alerts where store_id = '${S}' and kind = 'return_reason'));
select public.abo_set_alert_setting('${P}', 'returns_spike', false, '{}');
select pg_temp.say('switched_off', (select status from public.alerts where store_id = '${S}' and kind = 'returns_spike'));
select pg_temp.say('settings', (select string_agg((s ->> 'kind') || ':' || (s ->> 'enabled') || ':' || (s ->> 'ready'), ',')
  from jsonb_array_elements(public.abo_alert_settings('${P}')) s));
reset role;

-- Rows written by the store: looked at again soon.
${order(7, "now() - interval '1 hour'")}
select pg_temp.say('dirty_on_write', (select count(*)::text from public.alert_dirty where store_id = '${S}'));

-- Taken off Shopify, the store is looked at no more, and what it had open goes from the list.
update public.stores set status = 'uninstalled' where id = '${S}';
select pg_temp.as('${OWNER}');
select pg_temp.say('uninstalled', (select jsonb_array_length(public.abo_alerts('${P}'))::text));
reset role;

select k, v from out;
rollback;
`);

console.log("found from the store's own rows, once the import is done");
check("nothing before the imports it needs are done", r.before_ready === "none");
check("an import finishing asks for a look", r.dirty_after_import === "1");
check(
  "the four kinds, each found",
  r.found === "dispatch_late:attention,low_stock:attention,return_reason:attention,returns_spike:attention"
);
check("a run clears the store's ask", r.dirty_after_run === "0");
check(
  "low stock: the shirt with five days left, not the archived mug or the uncounted gift card",
  r.stock === `${V1}|5|Linen shirt|M`
);
check("late: the one not sent, not the sent, old, cancelled or fresh", r.late === '1|["#A2"]');
check("a spike: the shirt, not the mug that always comes back", r.spike === "Linen shirt");
check(
  "a reason: three times, whatever its case, with what came back and what they said",
  r.reason === '3|["Gift card", "Linen shirt"]|["Runs a size small"]'
);

console.log("\nit rings once, and again only when it gets worse");
check("a run with nothing new moves nothing", r.still === "0");
check("units sold move its numbers, not the bell", r.numbers_moved === "3|true");
check("down to a day's worth it is critical, and rings", r.worse === "critical|true");
check("put away, it comes back when it gets worse, unread", r.back_unread === "false");

console.log("\nthe store's people, and nobody else");
check("the owner sees all four", r.owner_sees === "4" && r.owner_rows === "4");
check("who read what is nobody's to read", r.reads_closed?.startsWith("ERR"));
check("new is unread; seen, it is read", r.first_unread === "false" && r.seen === "true,true,true,true");
check("put away, it leaves the list", r.put_away === "0");
check("a client through an MCP grant reads, and marks nothing", r.mcp_seen?.startsWith("ERR") && r.mcp_reads === "3");
check("a teammate who sees the store sees them", r.member_sees === "4");
check("and cannot change what is watched without building rights", r.member_sets?.startsWith("ERR"));
check(
  "a stranger sees none and marks none",
  r.stranger_list?.startsWith("ERR") && r.stranger_rows === "0" && r.stranger_wrote === "0"
);

console.log("\nasked of Luke");
check("the thread is kept on it", r.link === "true" && r.linked === C1);
check("a second thread does not replace the first", r.link_again === "false");
check("another project's thread is refused", r.link_theirs?.startsWith("ERR"));

console.log("\nit closes, and opens fresh");
check("restocked, it closes", r.closed === "resolved|true");
check("out again, it is a new episode with no thread", r.reopened === "open|true|none");
check("while the inventory is walked again it stays as it was", r.mid_recheck === "open");
check("a check that breaks leaves its alerts as they were", r.broken_kept === "open");
check("and the others still run", r.others_ran === "resolved");

console.log("\nwhat is watched");
check("nothing is watched until the merchant turns it on", r.off_by_default === "none");
check(
  "each kind listed off, with no numbers of its own",
  r.listed_off ===
    "low_stock:false:false:{},dispatch_late:false:false:{},returns_spike:false:false:{},return_reason:false:false:{}"
);
check("turned on without its numbers, it waits", r.on_without_numbers === "none");
check(
  "a number left out is not filled in: it waits, and closes what it had",
  r.one_left_out === 'false|{"min": 4}' && r.left_out_closed === "resolved"
);
check("a setting it does not have is refused", r.unknown_setting?.includes("not a setting"));
check("a setting is a number", r.not_number?.includes("is a number"));
check("a kind that does not exist is refused", r.no_kind?.includes("No such kind"));
check("a threshold raised is kept and looked at again at once", r.threshold === '{"min": 4, "days": 14}');
check("so three no longer counts", r.threshold_closed === "resolved");
check("switched off, it closes", r.switched_off === "resolved");
check(
  "each kind says whether it is on and whether its data is here",
  r.settings === "low_stock:true:true,dispatch_late:true:true,returns_spike:false:true,return_reason:true:true"
);
check("rows written by the store ask for a look", r.dirty_on_write === "1");
check("a store taken off Shopify has nothing on the list", r.uninstalled === "0");

console.log(
  fails.length ? `\n${fails.length} FAILED` : "\nLuke notices from the store's rows, and tells only its people"
);
process.exit(fails.length ? 1 : 0);
