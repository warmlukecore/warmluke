// What an account is shown of the store's lists (0192), on the database:
// only an administrator chooses it, per account and per list, and it is
// written down; every app the account owns reads it, and its team there,
// their own AI included; a stranger reads nothing; every column again is
// no row at all. In one transaction, rolled back.
//
//   ENV_FILE=.env.check.local node scripts/check-store-columns-live.mjs

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
const [ADMIN, OWNER, MEMBER, STRANGER] = [id(1), id(2), id(3), id(4)];
const [P, P2] = [id(10), id(11)];

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
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sc-admin-${tag}@warmluke.test'),
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sc-owner-${tag}@warmluke.test'),
  ('${MEMBER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sc-member-${tag}@warmluke.test'),
  ('${STRANGER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sc-stranger-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN}', true)
  on conflict (user_id) do update set is_superadmin = true;
insert into public.projects (id, owner_id, name) values ('${P}', '${OWNER}', 'columns ${tag}'), ('${P2}', '${OWNER}', 'second ${tag}');
insert into public.project_members (project_id, user_id, email, joined_at)
  values ('${P}', '${MEMBER}', 'sc-member-${tag}@warmluke.test', now());

select pg_temp.as('${OWNER}');
select pg_temp.say('owner_sets', pg_temp.try($q$select public.abo_admin_set_store_columns('${OWNER}', 'orders', array['total'])::text$q$));
select pg_temp.say('owner_reads_admin', pg_temp.try($q$select public.abo_admin_store_columns('${OWNER}')::text$q$));
select pg_temp.say('owner_writes_table', pg_temp.try($q$insert into public.account_store_columns (user_id, store_table, shown) values ('${OWNER}', 'orders', array['total']) returning 'wrote'$q$));
select pg_temp.say('before', public.abo_store_columns('${P}')::text);

select pg_temp.as('${ADMIN}');
select pg_temp.say('set', public.abo_admin_set_store_columns('${OWNER}', 'orders', array['total', 'order_number', 'total', 'Bad Name'])::text);
select pg_temp.say('set_again', public.abo_admin_set_store_columns('${OWNER}', 'orders', array['order_number', 'total'])::text);
select pg_temp.say('empty', pg_temp.try($q$select public.abo_admin_set_store_columns('${OWNER}', 'orders', array[]::text[])::text$q$));
select pg_temp.say('bad_list', pg_temp.try($q$select public.abo_admin_set_store_columns('${OWNER}', 'Orders; drop', array['total'])::text$q$));
select pg_temp.say('nobody', pg_temp.try($q$select public.abo_admin_set_store_columns('${id(99)}', 'orders', array['total'])::text$q$));
select pg_temp.say('admin_reads', public.abo_admin_store_columns('${OWNER}')::text);
reset role;
select pg_temp.say('trail', (select count(*)::text from public.admin_account_audit where target_user_id = '${OWNER}' and action = 'set_columns'));
select pg_temp.as('${ADMIN}');

select pg_temp.as('${OWNER}');
select pg_temp.say('owner_app', public.abo_store_columns('${P}')::text);
select pg_temp.say('owner_app2', public.abo_store_columns('${P2}')::text);
select pg_temp.as('${OWNER}', 'some-oauth-client');
select pg_temp.say('their_ai', public.abo_store_columns('${P}')::text);
select pg_temp.as('${MEMBER}');
select pg_temp.say('member', public.abo_store_columns('${P}')::text);
select pg_temp.say('member_other_app', public.abo_store_columns('${P2}')::text);
select pg_temp.as('${STRANGER}');
select pg_temp.say('stranger', public.abo_store_columns('${P}')::text);
select pg_temp.say('stranger_table', (select count(*)::text from public.account_store_columns));

select pg_temp.as('${ADMIN}');
select pg_temp.say('reset', public.abo_admin_set_store_columns('${OWNER}', 'orders', null)::text);
reset role;
select pg_temp.say('trail_after', (select count(*)::text from public.admin_account_audit where target_user_id = '${OWNER}' and action = 'set_columns'));
select pg_temp.as('${ADMIN}');
select pg_temp.say('reset_again', public.abo_admin_set_store_columns('${OWNER}', 'orders', null)::text);
reset role;
select pg_temp.say('trail_same', (select count(*)::text from public.admin_account_audit where target_user_id = '${OWNER}' and action = 'set_columns'));
select pg_temp.as('${ADMIN}');
select pg_temp.as('${OWNER}');
select pg_temp.say('after_reset', public.abo_store_columns('${P}')::text);
reset role;

select k || chr(9) || v from out;
rollback;
`);

console.log("only an administrator chooses");
check("not the account itself", r.owner_sets?.startsWith("ERR"));
check("nor reads the administrator's view", r.owner_reads_admin?.startsWith("ERR"));
check("nor writes the table", r.owner_writes_table?.startsWith("ERR"));
check("before any choice, every column", r.before === "{}");

console.log("\nan administrator's choice");
check("kept as names, once each, in order", r.set === '{"orders": ["order_number", "total"]}');
check("at least one column", r.empty?.startsWith("ERR") && /at least one/.test(r.empty));
check("a list by its name", r.bad_list?.startsWith("ERR"));
check("an account that is there", r.nobody?.startsWith("ERR"));
check("read back", r.admin_reads === '{"orders": ["order_number", "total"]}');
check("written down once, the same choice again not", r.trail === "1");

console.log("\nwho reads it");
check("every app the account owns", r.owner_app === r.set && r.owner_app2 === r.set);
check("their own AI", r.their_ai === r.set);
check("their team, in the app they share", r.member === r.set);
check("not in an app of theirs the teammate is not in", r.member_other_app === "{}");
check("a stranger reads nothing", r.stranger === "{}" && r.stranger_table === "0");

console.log("\nevery column again");
check("no row at all", r.reset === "{}" && r.after_reset === "{}");
check("and written down, once", r.trail_after === "2" && r.trail_same === "2");

console.log(
  fails.length
    ? `\n${fails.length} FAILED`
    : "\nwhat an account is shown is the administrator's, and read where it is used"
);
process.exit(fails.length ? 1 : 0);
