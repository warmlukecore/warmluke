// The team sees how Luke got there (0158), against the check database, in
// one transaction that is rolled back.
//
// What a turn cost, and its trace, are the team's: an owner's Luke writes
// them and the owner cannot read them back; a tester reads them in a
// project they belong to and in no other. Only an administrator puts
// someone on the team, opens a conversation by its id, or lists them, and
// each opening is written to the account's trail.
//
//   ENV_FILE=.env.check.local node scripts/check-team.mjs

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
const uuid = () => {
  const h = randomBytes(16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const tag = randomBytes(4).toString("hex");
const OWNER = "88888888-0000-0000-0000-00000000000a";
const TESTER = "88888888-0000-0000-0000-00000000000b";
const STRANGER = "88888888-0000-0000-0000-00000000000c";
const ADMIN = "88888888-0000-0000-0000-00000000000d";
const PROJECT = "88888888-0000-0000-0000-0000000000e1";
const CONV = "88888888-0000-0000-0000-0000000000f1";
const QUIET = "88888888-0000-0000-0000-0000000000f2";
const ASKED = "88888888-0000-0000-0000-0000000000a1";
const REPLY = "88888888-0000-0000-0000-0000000000a2";
const NOBODY = uuid();
const usage = (usd) =>
  JSON.stringify({
    model: "claude-opus-5-5",
    usd,
    partial: false,
    uses: [
      { job: "reply", model: "claude-opus-5-5", calls: 1, input: 1200, cacheRead: 0, cacheWrite: 0, output: 300, usd },
    ],
  });

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
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'team-owner-${tag}@warmluke.test'),
  ('${TESTER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'team-tester-${tag}@warmluke.test'),
  ('${STRANGER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'team-stranger-${tag}@warmluke.test'),
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'team-admin-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN}', true)
  on conflict (user_id) do update set is_superadmin = true;
insert into public.account_settings (user_id) values ('${OWNER}') on conflict (user_id) do nothing;
select pg_temp.say('new_shows', (select luke_shows from public.account_settings where user_id = '${OWNER}'));
insert into public.projects (id, owner_id, name) values ('${PROJECT}', '${OWNER}', 'team check ${tag}');
-- The tester works in the owner's project; the stranger does not.
insert into public.project_members (project_id, user_id, email, joined_at)
values ('${PROJECT}', '${TESTER}', 'team-tester-${tag}@warmluke.test', now());
insert into public.conversations (id, project_id, title, updated_at) values
  ('${CONV}', '${PROJECT}', 'Packing sheet ${tag}', now()),
  ('${QUIET}', '${PROJECT}', 'Hello ${tag}', now() - interval '1 minute');
insert into public.messages (id, conversation_id, role, content, payload, created_at) values
  ('${ASKED}', '${CONV}', 'user', 'make me a packing sheet', null, now() - interval '30 seconds'),
  ('${REPLY}', '${CONV}', 'assistant', '{}',
   jsonb_build_object('type', 'answer', 'message', 'Here it is', 'usage', '${usage(0.05)}'::jsonb), now());

-- Who is on the team.
select pg_temp.as('${OWNER}');
select pg_temp.say('owner_team', public.abo_is_tester()::text);
select pg_temp.say('owner_sets', pg_temp.try($t$select public.abo_admin_set_tester('${OWNER}', true)::text$t$));
-- The owner's Luke writes the turn's trace; the owner cannot read it back.
insert into public.turn_traces (project_id, conversation_id, turn_id, road, model, steps, usage, repairs, repair_errors, unmet, critic, took_ms)
values ('${PROJECT}', '${CONV}', '${REPLY}', 'design', 'claude-opus-5-5', '[{"step":"accepted"}]', '${usage(0.05)}', 1,
        '["column kind unknown"]', '[]', '{"verdict":"redo","missing":1}', 8400);
insert into public.turn_traces (project_id, conversation_id, turn_id, road, steps, usage, took_ms)
values ('${PROJECT}', '${QUIET}', null, 'talk', '[]', '${usage(0.002)}', 900);
select pg_temp.say('owner_reads_traces', (select count(*)::text from public.turn_traces where project_id = '${PROJECT}'));
reset role;

select pg_temp.as('${ADMIN}');
select pg_temp.say('admin_team', public.abo_is_tester()::text);
select pg_temp.say('admin_sets', pg_temp.try($t$select public.abo_admin_set_tester('${TESTER}', true)::text$t$));
select pg_temp.say('admin_sets_again', pg_temp.try($t$select public.abo_admin_set_tester('${TESTER}', true)::text$t$));
select pg_temp.say('luke_says', (public.abo_admin_luke('${TESTER}') ->> 'tester'));
reset role;
select pg_temp.say('audit_set', (select count(*)::text from public.admin_account_audit where target_user_id = '${TESTER}' and action = 'set_tester'));

select pg_temp.as('${TESTER}');
select pg_temp.say('tester_team', public.abo_is_tester()::text);
select pg_temp.say('tester_reads_traces', (select count(*)::text from public.turn_traces where project_id = '${PROJECT}'));
select pg_temp.say('tester_lists', pg_temp.try($t$select public.abo_admin_conversations()::text$t$));
reset role;
select pg_temp.as('${STRANGER}');
select pg_temp.say('stranger_team', public.abo_is_tester()::text);
select pg_temp.say('stranger_reads_traces', (select count(*)::text from public.turn_traces where project_id = '${PROJECT}'));
reset role;

-- The administrator's reader.
select pg_temp.as('${ADMIN}');
select pg_temp.say('by_conv', (select string_agg(x ->> 'id', ',') from jsonb_array_elements(public.abo_admin_conversations('${CONV}')) x));
select pg_temp.say('by_message', (select string_agg(x ->> 'id', ',') from jsonb_array_elements(public.abo_admin_conversations('${ASKED}')) x));
select pg_temp.say('by_turn', (select string_agg(x ->> 'id', ',') from jsonb_array_elements(public.abo_admin_conversations('${REPLY}')) x));
select pg_temp.say('by_nothing', (select count(*)::text from jsonb_array_elements(public.abo_admin_conversations('${NOBODY}')) x));
select pg_temp.say('by_email', (select string_agg(x ->> 'id', ',' order by x ->> 'id') from jsonb_array_elements(public.abo_admin_conversations('team-owner-${tag}')) x));
select pg_temp.say('wrong_only', (select string_agg(x ->> 'id', ',') from jsonb_array_elements(public.abo_admin_conversations('${tag}', 'problems')) x));
select pg_temp.say('costly_first', (public.abo_admin_conversations('${tag}', 'costly') -> 0 ->> 'id'));
select pg_temp.say('row', (select x::text from jsonb_array_elements(public.abo_admin_conversations('${CONV}')) x));
select pg_temp.say('bad_view', pg_temp.try($t$select public.abo_admin_conversations(null, 'everything')::text$t$));
select pg_temp.say('whole', public.abo_admin_conversation('${CONV}')::text);
select pg_temp.say('unknown', coalesce(public.abo_admin_conversation('${NOBODY}')::text, 'null'));
reset role;
select pg_temp.say('audit_view', (select count(*)::text from public.admin_account_audit where target_user_id = '${OWNER}' and action = 'view_conversation'));
select pg_temp.as('${TESTER}');
select pg_temp.say('tester_opens', pg_temp.try($t$select public.abo_admin_conversation('${CONV}')::text$t$));
reset role;

select k, v from out;
rollback;
`;

const r = psql(sql);
const parse = (s) => {
  try {
    return JSON.parse(s ?? "null");
  } catch {
    return null;
  }
};
const row = parse(r.row);
const whole = parse(r.whole);

console.log("who is on the team");
check("a new account sees nothing under a reply", r.new_shows === "nothing");
check("an owner is not on it", r.owner_team === "false");
check("and cannot put themselves on it", (r.owner_sets ?? "").includes("Not an administrator"));
check("an administrator is, without being marked", r.admin_team === "true");
check("and puts a tester on it", r.admin_sets === "true" && r.tester_team === "true");
check("which the account's dialog says", r.luke_says === "true");
check("written to their trail once, not again for a change that changed nothing", r.audit_set === "1");
check("someone never put on it is not on it", r.stranger_team === "false");

console.log("\nwhat a turn cost is the team's");
check("the owner's Luke writes the trace, and the owner cannot read it back", r.owner_reads_traces === "0");
check("a tester reads it in a project they work in", r.tester_reads_traces === "2");
check("and nobody outside the project does", r.stranger_reads_traces === "0");

console.log("\nthe administrator's reader");
check("a tester cannot list conversations", (r.tester_lists ?? "").includes("Not an administrator"));
check("or open one", (r.tester_opens ?? "").includes("Not an administrator"));
check("found by its own id", r.by_conv === CONV);
check("by a message's in it", r.by_message === CONV);
check("by a turn's", r.by_turn === CONV);
check("an id that is nothing finds nothing", r.by_nothing === "0");
check("by its owner's email", r.by_email === [CONV, QUIET].toSorted().join(","));
check("the ones that went wrong, and only those", r.wrong_only === CONV);
check("the costliest first", r.costly_first === CONV);
check(
  "each row adds up its turns",
  row?.turns === 1 && Math.abs(Number(row?.usd) - 0.05) < 1e-9 && Number(row?.input) === 1200 && row?.troubled === 1
);
check("a view that is not one is refused", (r.bad_view ?? "").includes("No such view"));
check(
  "a conversation opens whole: whose, its messages and each turn's trace",
  whole?.owner?.email === `team-owner-${tag}@warmluke.test` &&
    whole?.messages?.length === 2 &&
    whole?.traces?.[0]?.turn_id === REPLY &&
    whole?.traces?.[0]?.repair_errors?.[0] === "column kind unknown"
);
check("an id that is no conversation opens nothing", r.unknown === "null");
check("and every opening is written to the owner's trail", r.audit_view === "1");

console.log(fails.length ? `\n${fails.length} FAILED` : "\nthe team sees how Luke got there, and only the team");
process.exit(fails.length ? 1 : 0);
