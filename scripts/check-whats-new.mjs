// What is new to each person (0191), on the database: a section made since
// is New until they open it; one changed since they looked says so; what
// they have seen is never lowered; it is theirs alone, a teammate's open
// clears nothing for them, and nobody marks a section they cannot see.
// Their own AI reads it and marks nothing. In one transaction, rolled back.
//
//   ENV_FILE=.env.check.local node scripts/check-whats-new.mjs

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
const [OWNER, MEMBER, STRANGER] = [id(1), id(2), id(3)];
const P = id(10);
// NEW: made today, the owner's own; OLD: made before marks began; SHARED: the team sees it.
const [NEW, OLD, SHARED] = [id(20), id(21), id(22)];
const news = (m) =>
  `(select coalesce((select e::text from jsonb_array_elements(public.abo_whats_new('${P}')) e where e ->> 'id' = '${m}'), 'none'))`;

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
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wn-owner-${tag}@warmluke.test'),
  ('${MEMBER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wn-member-${tag}@warmluke.test'),
  ('${STRANGER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wn-stranger-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name) values ('${P}', '${OWNER}', 'whats new ${tag}');
insert into public.project_members (project_id, user_id, email, joined_at)
  values ('${P}', '${MEMBER}', 'wn-member-${tag}@warmluke.test', now());
insert into public.modules (id, project_id, name, nav_label, route, created_at, shared_with_team) values
  ('${NEW}', '${P}', 'wn-new', 'New one', '/modules/wn-new', now(), false),
  ('${OLD}', '${P}', 'wn-old', 'Old one', '/modules/wn-old', '2026-10-01', false),
  ('${SHARED}', '${P}', 'wn-shared', 'Shared one', '/modules/wn-shared', now(), true);
insert into public.ui_schemas (module_id, schema_json, version, created_by, created_at) values
  ('${NEW}', '{"columns":[]}', 1, 'ai', now()),
  ('${OLD}', '{"columns":[]}', 1, 'ai', '2026-10-01'),
  ('${SHARED}', '{"columns":[]}', 1, 'ai', now());

select pg_temp.as('${OWNER}');
select pg_temp.say('fresh', ${news(NEW)});
select pg_temp.say('old', ${news(OLD)});
select pg_temp.say('seen', pg_temp.try($q$select public.abo_seen('${NEW}', 1)::text$q$));
select pg_temp.say('after_seen', ${news(NEW)});
reset role;
insert into public.ui_schemas (module_id, schema_json, version, created_by) values
  ('${NEW}', '{"columns":[]}', 2, 'ai'), ('${OLD}', '{"columns":[]}', 2, 'user');
select pg_temp.as('${OWNER}');
select pg_temp.say('changed', ${news(NEW)});
select pg_temp.say('old_changed', ${news(OLD)});
select public.abo_seen('${NEW}', 2);
select public.abo_seen('${NEW}', 1);
select pg_temp.say('kept', ${news(NEW)});
select pg_temp.say('own_write', pg_temp.try($q$insert into public.section_seen (user_id, module_id, version) values ('${OWNER}', '${OLD}', 9) returning 'wrote'$q$));
-- Their own AI reads, and marks nothing.
select pg_temp.as('${OWNER}', 'some-oauth-client');
select pg_temp.say('ai_read', ${news(OLD)});
select pg_temp.say('ai_seen', pg_temp.try($q$select public.abo_seen('${OLD}', 2)::text$q$));
select pg_temp.as('${OWNER}');
select pg_temp.say('after_ai', ${news(OLD)});

select pg_temp.as('${MEMBER}');
select pg_temp.say('member_private', ${news(NEW)});
select pg_temp.say('member_shared', ${news(SHARED)});
select pg_temp.say('member_mark_private', pg_temp.try($q$select public.abo_seen('${NEW}', 2)::text$q$));
select public.abo_seen('${SHARED}', 1);
select pg_temp.as('${OWNER}');
select pg_temp.say('owner_shared', ${news(SHARED)});

select pg_temp.as('${STRANGER}');
select pg_temp.say('stranger_list', public.abo_whats_new('${P}')::text);
select pg_temp.say('stranger_mark', pg_temp.try($q$select public.abo_seen('${SHARED}', 1)::text$q$));
select pg_temp.say('stranger_rows', (select count(*)::text from public.section_seen));
reset role;

select k || chr(9) || v from out;
rollback;
`);

const j = (k) => (r[k] && r[k] !== "none" ? JSON.parse(r[k]) : null);

console.log("their own sections");
check("made since marks began and never opened: new", j("fresh")?.fresh === true && j("fresh")?.seen === null);
check(
  "one from before marks began, unchanged since: nothing",
  j("old")?.fresh === false && j("old")?.changed === false
);
check(
  "opened: seen, and nothing to mark",
  !r.seen?.startsWith("ERR") && j("after_seen")?.seen === 1 && !j("after_seen")?.fresh
);
check("a version after the one seen: changed", j("changed")?.changed === true && j("changed")?.version === 2);
check("an old one changed since marks began: changed", j("old_changed")?.changed === true);
check("what was seen is never lowered", j("kept")?.seen === 2 && j("kept")?.changed === false);
check("the table is written only through abo_seen", r.own_write?.startsWith("ERR"));

console.log("\ntheir own AI");
check("reads what is new", j("ai_read")?.changed === true);
check(
  "and marks nothing",
  !r.ai_seen?.startsWith("ERR") && j("after_ai")?.seen === null && j("after_ai")?.changed === true
);

console.log("\na teammate, and a stranger");
check("a teammate is told nothing of a section not shared with them", r.member_private === "none");
check("and is told of one shared", j("member_shared")?.fresh === true);
check("and cannot mark one they cannot see", r.member_mark_private?.startsWith("ERR"));
check("a teammate's open clears nothing for the owner", j("owner_shared")?.fresh === true);
check("a stranger is told nothing", r.stranger_list === "[]");
check("and marks nothing", r.stranger_mark?.startsWith("ERR") && r.stranger_rows === "0");

console.log(fails.length ? `\n${fails.length} FAILED` : "\nwhat is new is each person's own, and kept");
process.exit(fails.length ? 1 : 0);
