// The tour, shown once and counted (0157), against the check database, in
// one transaction that is rolled back.
//
// A person's row says the app has shown them the tour; only they read it
// and only the function writes it. An administrator switches it off,
// rewords a stop, reads who saw it, and shows it to someone again; nobody
// else can do any of that.
//
//   ENV_FILE=.env.check.local node scripts/check-tour.mjs

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
const A = "77777777-0000-0000-0000-00000000000a";
const B = "77777777-0000-0000-0000-00000000000b";
const ADMIN = "77777777-0000-0000-0000-00000000000c";
const row = `(select concat_ws('|', times, coalesce(outcome, '-'), reached, stops, coalesce(closed_on, '-')) from public.tour_views where user_id = '${A}')`;

const sql = `
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
  ('${A}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tour-a-${tag}@warmluke.test'),
  ('${B}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tour-b-${tag}@warmluke.test'),
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tour-admin-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN}', true)
  on conflict (user_id) do update set is_superadmin = true;
-- As a fresh database has it, whatever the check database was left with.
update public.tour_settings set enabled = true, copy = '{}' where id;
delete from public.tour_views where user_id in ('${A}', '${B}');

-- What anybody may read of the settings.
set local role anon;
select pg_temp.say('anon_settings', (select enabled::text from public.tour_settings));
reset role;

-- Who may mark it.
set local role anon;
select pg_temp.say('anon_seen', pg_temp.try($t$select public.abo_tour_seen('open', null, 1, 5)::text$t$));
reset role;
select pg_temp.as('${A}', 'an-ai-client');
select pg_temp.say('ai_seen', pg_temp.try($t$select public.abo_tour_seen('open', null, 1, 5)::text$t$));
reset role;
select pg_temp.as('${A}');
select pg_temp.say('bad_event', pg_temp.try($t$select public.abo_tour_seen('peeked', null, 1, 5)::text$t$));
select pg_temp.say('bad_stops', pg_temp.try($t$select public.abo_tour_seen('open', null, 1, 40)::text$t$));
select pg_temp.say('own_insert', pg_temp.try($t$insert into public.tour_views (user_id, stops) values ('${A}', 5) returning 'inserted'$t$));

-- A takes it: opens, closes at Ask Luke, opens again, goes to the end.
select pg_temp.say('unseen', (select count(*)::text from public.tour_views));
select public.abo_tour_seen('open', null, 1, 3);
select pg_temp.say('opened', ${row});
select public.abo_tour_seen('closed', 'luke', 4, 5);
select pg_temp.say('closed', ${row});
select public.abo_tour_seen('open', null, 1, 5);
select pg_temp.say('again', ${row});
select public.abo_tour_seen('finished', 'build', 9, 5);
select pg_temp.say('finished', ${row});
select public.abo_tour_seen('closed', 'Not A Key!', 2, 5);
select pg_temp.say('odd_stop', ${row});
select pg_temp.say('own_read', (select count(*)::text from public.tour_views));
reset role;

-- B is shown it too, and cannot see A's.
select pg_temp.as('${B}');
select public.abo_tour_seen('open', null, 1, 5);
select pg_temp.say('b_reads', (select string_agg(user_id::text, ',') from public.tour_views));
select pg_temp.say('b_report', pg_temp.try($t$select public.abo_admin_tour_report()::text$t$));
select pg_temp.say('b_set', pg_temp.try($t$select public.abo_admin_set_tour(false, '{}')::text$t$));
select pg_temp.say('b_reset', pg_temp.try($t$select public.abo_admin_tour_reset('${A}')::text$t$));
reset role;

-- The administrator's.
select pg_temp.as('${ADMIN}');
select pg_temp.say('bad_key', pg_temp.try($t$select public.abo_admin_set_tour(true, '{"Luke Stop": {"title": "x"}}')::text$t$));
select pg_temp.say('long_title', pg_temp.try($t$select public.abo_admin_set_tour(true, jsonb_build_object('luke', jsonb_build_object('title', repeat('x', 81))))::text$t$));
select pg_temp.say('set', pg_temp.try($t$select (public.abo_admin_set_tour(false, '{"luke": {"title": " Ask me ", "body": ""}, "store": {"title": "", "body": "  "}}') -> 'copy')::text$t$));
select pg_temp.say('settings_after', (select concat_ws('|', enabled::text, copy::text) from public.tour_settings));
select pg_temp.say('report', public.abo_admin_tour_report(1000)::text);
select pg_temp.say('reset', public.abo_admin_tour_reset('${A}')::text);
select pg_temp.say('reset_again', public.abo_admin_tour_reset('${A}')::text);
reset role;
select pg_temp.say('after_reset', (select count(*)::text from public.tour_views where user_id = '${A}'));

-- An account deleted takes its row.
delete from auth.users where id = '${B}';
select pg_temp.say('b_gone', (select count(*)::text from public.tour_views where user_id = '${B}'));

select k, v from out;
rollback;
`;

const r = psql(sql);
let report = null;
try {
  report = JSON.parse(r.report ?? "null");
} catch {
  report = null;
}
const mine = report?.people?.find((p) => p.user_id === A);

console.log("who may mark it");
check("anybody may read whether it is on, and it starts on", r.anon_settings === "true");
check("not without signing in", (r.anon_seen ?? "").startsWith("ERR"));
check("not their AI", (r.ai_seen ?? "").includes("Only in Warmluke itself"));
check("only the moments a tour has", (r.bad_event ?? "").includes("No such moment"));
check("only a tour's number of stops", (r.bad_stops ?? "").includes("between 1 and 20"));
check("never written by hand", (r.own_insert ?? "").startsWith("ERR"));

console.log("\na person taking it");
check("unseen before", r.unseen === "0");
check("opened: once, still open", r.opened === "1|-|1|3|-");
check("closed at a stop: where, and how far", r.closed === "1|closed|4|5|luke");
check("opened again: counted, and open again", r.again === "2|-|1|5|-");
check("to the end, never past the last stop", r.finished === "2|finished|5|5|-");
check("a stop that is not one is not kept", r.odd_stop === "2|closed|2|5|-");
check("they read their own row", r.own_read === "1");
check("and only theirs", r.b_reads === B);

console.log("\nthe administrator's, and nobody else's");
check("nobody else reads who saw it", (r.b_report ?? "").includes("Not an administrator"));
check("or switches it", (r.b_set ?? "").includes("Not an administrator"));
check("or shows it to someone again", (r.b_reset ?? "").includes("Not an administrator"));
check("a stop is named by its key", (r.bad_key ?? "").includes("No such stop"));
check("a title is kept short", (r.long_title ?? "").includes("80 characters"));
check("blank words are the app's own, the rest trimmed", r.set === '{"luke": {"title": "Ask me"}}');
check("and switched off it stays off", (r.settings_after ?? "").startsWith("false|"));
check("who saw it, counted", report?.totals?.shown >= 2 && typeof report?.closed_on === "object");
check(
  "and each person by name, with how it went",
  mine?.email === `tour-a-${tag}@warmluke.test` && mine?.outcome === "closed" && mine?.times === 2
);
check("shown again: their row goes", r.reset === "true" && r.after_reset === "0");
check("and again is nothing to do", r.reset_again === "false");
check("an account deleted takes its row", r.b_gone === "0");

console.log(fails.length ? `\n${fails.length} FAILED` : "\nthe tour is shown once, and counted");
process.exit(fails.length ? 1 : 0);
