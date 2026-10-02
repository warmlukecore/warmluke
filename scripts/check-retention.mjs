// What the console keeps, who looked, and what it cost (0159), against the
// check database, in one transaction that is rolled back — the sweep's
// deletes with it.
//
// Traces are kept until an administrator switches the nightly clean-up
// on; then only traces past the kept days go, and only traces. The access
// log reads every account's trail; Spend adds up the traces' dollars by
// day, model and account. Nobody but an administrator reaches any of it,
// and nobody at all calls the sweep directly.
//
//   ENV_FILE=.env.check.local node scripts/check-retention.mjs

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
const OWNER = "79999999-0000-0000-0000-00000000000a";
const ADMIN = "79999999-0000-0000-0000-00000000000c";
const PROJECT = "79999999-0000-0000-0000-0000000000a1";
const CONV = "79999999-0000-0000-0000-0000000000c1";
const MODEL = `check-model-${tag}`;
const usage = (usd) =>
  JSON.stringify({
    model: MODEL,
    usd,
    partial: false,
    uses: [{ provider: "x", model: MODEL, job: "reply", calls: 1, input: 1000, cacheRead: 0, cacheWrite: 0, output: 100, usd }],
  });
const tried = (q) => `pg_temp.try($q$${q}$q$)`;

const sql = `
begin;
create function pg_temp.try(t text) returns text language plpgsql as $f$
declare v text;
begin execute t into v; return coalesce(v, 'ok'); exception when others then return 'ERR ' || sqlstate || ' ' || sqlerrm; end $f$;
create function pg_temp.as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;
create temp table out (k text, v text);
grant all on out to public;
create function pg_temp.say(k text, v text) returns void language sql as $f$ insert into out values (k, v) $f$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ret-owner-${tag}@warmluke.test'),
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ret-admin-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN}', true)
  on conflict (user_id) do update set is_superadmin = true;
insert into public.projects (id, owner_id, name) values ('${PROJECT}', '${OWNER}', 'retention check ${tag}');
insert into public.conversations (id, project_id, title, updated_at) values ('${CONV}', '${PROJECT}', 'Kept ${tag}', now());
-- As a fresh database has it.
update public.trace_retention set enabled = false, days = 90, last_run_at = null, last_deleted = null where id;
-- One trace far older than anything real, one from today.
insert into public.turn_traces (project_id, conversation_id, road, model, usage, created_at) values
  ('${PROJECT}', '${CONV}', 'talk', '${MODEL}', '${usage(0.25)}', now() - interval '4000 days'),
  ('${PROJECT}', '${CONV}', 'talk', '${MODEL}', '${usage(0.5)}', now());
insert into public.admin_account_audit (actor_user_id, target_user_id, action, old_value, new_value)
values ('${ADMIN}', '${OWNER}', 'set_tester', '{"tester": false}', '{"tester": true}');

-- Somebody who is not an administrator.
select pg_temp.as('${OWNER}');
select pg_temp.say('owner_read', ${tried("select public.abo_admin_retention()::text")});
select pg_temp.say('owner_set', ${tried("select public.abo_admin_set_retention(true, 30)::text")});
select pg_temp.say('owner_sweep', ${tried("select public.abo_admin_sweep_traces()::text")});
select pg_temp.say('owner_log', ${tried("select public.abo_admin_access_log()::text")});
select pg_temp.say('owner_spend', ${tried("select public.abo_admin_spend()::text")});
select pg_temp.say('owner_direct', ${tried("select public.abo_trace_sweep(1000, true)::text")});
select pg_temp.say('owner_table', ${tried("select count(*)::text from public.trace_retention")});
reset role;

-- Off: the nightly run does nothing.
select pg_temp.say('off_run', (public.abo_trace_sweep() ->> 'skipped'));

-- The administrator.
select pg_temp.as('${ADMIN}');
select pg_temp.say('admin_direct', ${tried("select public.abo_trace_sweep(1000, true)::text")});
select pg_temp.say('starts', (select concat_ws('|', r ->> 'enabled', r ->> 'days') from public.abo_admin_retention() r));
select pg_temp.say('too_few', ${tried("select public.abo_admin_set_retention(true, 6)::text")});
select pg_temp.say('set', (select concat_ws('|', r ->> 'enabled', r ->> 'days', r ->> 'updated_by', ((r ->> 'past')::int >= 1)::text)
                            from public.abo_admin_set_retention(true, 3650) r));
select pg_temp.say('now', (select concat_ws('|', ((r ->> 'deleted')::int >= 1)::text, r ->> 'more')
                            from public.abo_admin_sweep_traces() r));
reset role;
select pg_temp.say('left', (select string_agg((created_at > now() - interval '1 day')::text, ',')
                              from public.turn_traces where project_id = '${PROJECT}'));
select pg_temp.say('recorded', (select concat_ws('|', (last_run_at is not null)::text, (last_deleted >= 1)::text)
                                  from public.trace_retention));
select pg_temp.say('conversation_kept', (select count(*)::text from public.conversations where id = '${CONV}'));
-- On: the nightly run sweeps by itself.
insert into public.turn_traces (project_id, conversation_id, road, usage, created_at)
values ('${PROJECT}', '${CONV}', 'talk', '{}', now() - interval '4000 days');
select pg_temp.say('on_run', (public.abo_trace_sweep() ->> 'deleted'));

select pg_temp.as('${ADMIN}');
select pg_temp.say('log', (select r::text from public.abo_admin_access_log('ret-owner-${tag}', 'set_tester', 30, 10) r));
select pg_temp.say('log_other', (select jsonb_array_length(r -> 'rows')::text
                                   from public.abo_admin_access_log('ret-owner-${tag}', 'suspend', 30, 10) r));
select pg_temp.say('spend', (select r::text from public.abo_admin_spend(7) r));
reset role;

select k, v from out;
rollback;
`;

const r = psql(sql);
const denied = (v) => (v ?? "").startsWith("ERR 42501");

console.log("nobody else reaches any of it");
for (const k of ["owner_read", "owner_set", "owner_sweep", "owner_log", "owner_spend"])
  check(`${k.replace("owner_", "")}: refused`, denied(r[k]));
check("the sweep is not anybody's to call", denied(r.owner_direct) && denied(r.admin_direct));
check("nor the settings to read", denied(r.owner_table));

console.log("\ntraces are kept until it is switched on");
check("it starts off, at 90 days", r.starts === "false|90");
check("switched off, the nightly run does nothing", r.off_run === "true");
check("fewer than 7 days is refused", (r.too_few ?? "").startsWith("ERR 22023"));
check("switched on, it says who and what it would delete", r.set === `true|3650|ret-admin-${tag}@warmluke.test|true`);
check("now: the old trace goes", (r.now ?? "").startsWith("true|"));
check("and only the old one: today's stays", r.left === "true");
check("the run is recorded", r.recorded === "true|true");
check("traces only: the conversation stays", r.conversation_kept === "1");
check("switched on, the nightly run sweeps by itself", Number(r.on_run) >= 1);

console.log("\nthe access log reads every account's trail");
const log = JSON.parse(r.log ?? "{}");
const line = log.rows?.[0];
check(
  "found by the account's address and kind, with both names",
  line?.actor === `ret-admin-${tag}@warmluke.test` && line?.target === `ret-owner-${tag}@warmluke.test`
);
check("what changed, before and after", line?.old_value?.tester === false && line?.new_value?.tester === true);
check("counted by kind for the filter", log.actions?.set_tester >= 1);
check("another kind finds nothing of theirs", r.log_other === "0");

console.log("\nSpend adds the traces up");
const spend = JSON.parse(r.spend ?? "{}");
const model = spend.models?.find((m) => m.model === MODEL);
check("seven days, each one there", spend.days?.length === 7);
check("today holds today's trace", Number(spend.days?.at(-1)?.usd) >= 0.5);
check("by the model that made the calls", Number(model?.usd) === 0.5 && model?.calls === 1 && model?.input === 1000);
check(
  "and by account, with the address",
  spend.accounts?.some((a) => a.email === `ret-owner-${tag}@warmluke.test` && Number(a.usd) === 0.5)
);

console.log(fails.length ? `\n${fails.length} FAILED` : "\nwhat is kept, who looked, and what it cost");
process.exit(fails.length ? 1 : 0);
