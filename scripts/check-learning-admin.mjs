// What Luke learned, as the console reads it (0176), against the check
// database, in one transaction that is rolled back.
//
// A store is planted with thirty lessons and skills, a month of what
// happened to them (and an older stretch that must not count), and its
// owner's thumbs on two replies; one run of the reflector, with its
// dollars; five designs the critic read; and three that the reviewers
// after it read (0177): the operator's view, simplicity, the data check,
// the dry-run and the screen check, one of them skipped. The
// administrator gets the counts and the repeat-mistake rate right, the
// store's own page lists all of it, the thirty-first lesson retires the
// weakest and says so, and nobody else reads any of it.
//
//   ENV_FILE=.env.check.local node scripts/check-learning-admin.mjs

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

const tag = randomBytes(4).toString("hex");
const id = (n) => `7a1ea500-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [ADMIN, OWNER, OTHER, P, Q, C, M1, M2] = [id(1), id(2), id(3), id(10), id(11), id(20), id(30), id(31)];
const MATE = id(4);
const [L1, L2, L3, S1, W1, W2, NEW, X] = [id(40), id(41), id(42), id(43), id(44), id(45), id(46), id(47)];
const asked = `Ask before a status field ${tag}`;

const r = spawnSync("psql", [env.DATABASE_URL, "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1"], {
  input: `
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
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'la-admin-${tag}@warmluke.test'),
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'la-owner-${tag}@warmluke.test'),
  ('${OTHER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'la-other-${tag}@warmluke.test'),
  ('${MATE}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'la-mate-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN}', true)
  on conflict (user_id) do update set is_superadmin = true;
insert into public.projects (id, owner_id, name) values ('${P}', '${OWNER}', 'learning ${tag}'), ('${Q}', '${OTHER}', 'elsewhere ${tag}');
insert into public.conversations (id, project_id, title) values ('${C}', '${P}', 'Statuses ${tag}');
insert into public.messages (id, conversation_id, role, content, payload) values
  ('${M1}', '${C}', 'assistant', 'Done.', '{"type": "answer", "message": "Done."}'),
  ('${M2}', '${C}', 'assistant', '', '{"type": "plans", "message": "Three fields for RTO."}');

-- What the database held before: the check database has learning of its own.
select pg_temp.as('${ADMIN}');
select pg_temp.say('learning_before', public.abo_admin_learning(30)::text);
select pg_temp.say('agents_before', public.abo_admin_agents(7)::text);
reset role;

-- Thirty active: five lessons, twenty-five skills. Two lessons made
-- things worse three times each; the one untouched longer goes first.
insert into public.luke_skills (id, project_id, kind, title, body, when_to_use, uses, helped, hurt, updated_at) values
  ('${L1}', '${P}', 'lesson', '${asked}', 'One status field, not three yes/no fields for one fact.', 'A status is asked for', 900, 3, 0, now() - interval '1 hour'),
  ('${L2}', '${P}', 'lesson', 'Couriers by name ${tag}', 'Delhivery and Blue Dart are couriers, not statuses.', '', 2, 1, 0, now() - interval '2 hours'),
  ('${L3}', '${P}', 'lesson', 'Dates as dates ${tag}', 'A date field, never a text one.', '', 1, 0, 0, now() - interval '3 hours'),
  ('${S1}', '${P}', 'skill', 'RTO tracker ${tag}', 'A section over orders with an RTO status and a rule.', '', 1, 2, 0, now() - interval '4 hours'),
  ('${W1}', '${P}', 'lesson', 'Weak, newer ${tag}', 'It made things worse.', '', 3, 0, 3, now() - interval '1 day'),
  ('${W2}', '${P}', 'lesson', 'Weak, older ${tag}', 'It made things worse, longer ago.', '', 3, 0, 3, now() - interval '10 days');
insert into public.luke_skills (project_id, kind, title, body, helped, updated_at)
  select '${P}', 'skill', 'Filler ' || n || ' ${tag}', 'A way of building that worked.', 1, now() - make_interval(hours => n)
    from generate_series(1, 24) n;
-- And one the owner struck, which is not active.
insert into public.luke_skills (id, project_id, kind, title, body, status) values
  ('${X}', '${P}', 'lesson', 'Struck ${tag}', 'The owner said no to this.', 'struck');

-- A month of what happened, and an older stretch out of every window.
insert into public.luke_learning_events (project_id, skill_id, event, detail, conversation_id, at) values
  ('${P}', '${L1}', 'created', '{}', '${C}', now() - interval '3 days'),
  ('${P}', '${L2}', 'created', '{}', '${C}', now() - interval '3 days'),
  ('${P}', '${S1}', 'created', '{}', '${C}', now() - interval '3 days'),
  ('${P}', '${L1}', 'patched', '{"reason": "said more plainly"}', '${C}', now() - interval '2 days'),
  ('${P}', '${L1}', 'used', '{}', '${C}', now() - interval '1 day'),
  ('${P}', '${L1}', 'used', '{}', '${C}', now() - interval '20 hours'),
  ('${P}', '${L2}', 'used', '{}', '${C}', now() - interval '20 hours'),
  ('${P}', '${S1}', 'used', '{}', '${C}', now() - interval '20 hours'),
  ('${P}', '${L1}', 'helped', '{}', '${C}', now() - interval '19 hours'),
  ('${P}', '${S1}', 'helped', '{}', '${C}', now() - interval '19 hours'),
  ('${P}', '${L2}', 'hurt', '{}', '${C}', now() - interval '19 hours'),
  ('${P}', '${L1}', 'repeat', '{"reason": "three yes/no fields again"}', '${C}', now() - interval '18 hours'),
  ('${P}', '${X}', 'struck', '{}', null, now() - interval '17 hours'),
  ('${P}', null, 'reflected', '{"why": "the owner said it was wrong", "outcome": {"created": 2, "patched": 1, "retired": 0, "repeats": 1}, "model": "claude-haiku-4-5", "usd": 0.0123, "partial": false}', '${C}', now() - interval '16 hours'),
  ('${P}', '${L3}', 'used', '{}', null, now() - interval '120 days'),
  ('${P}', '${L3}', 'repeat', '{}', null, now() - interval '120 days');

-- Five designs the critic read: three fit, two went back, and those two were repaired.
insert into public.turn_traces (project_id, conversation_id, road, repairs, critic, steps, usage, took_ms)
  select '${P}', '${C}', 'design', case when n > 3 then 1 else 0 end,
         jsonb_build_object('verdict', case when n <= 3 then 'fits' else 'redo' end, 'missing', case when n <= 3 then 0 else 2 end),
         '[{"step": "road", "road": "design"}, {"step": "checked", "problems": 0}]'::jsonb,
         '{"usd": 0.001, "partial": false, "uses": [{"provider": "anthropic", "model": "claude-haiku-4-5", "job": "critic", "calls": 1, "input": 100, "cacheRead": 0, "cacheWrite": 0, "output": 10, "usd": 0.001}]}'::jsonb,
         1000 * n
    from generate_series(1, 5) n;

-- Three designs the reviewers after the critic read (0177): one with
-- ideas, a clean simplicity read, a problem in the data, two rules tried
-- and a screenshot that passed; one with none of those; and one that
-- asked for no ideas and skipped the screen check. The first two carry
-- the reviewers' calls on the meter.
insert into public.turn_traces (project_id, conversation_id, road, steps, usage, took_ms) values
  ('${P}', '${C}', 'design',
   '[{"step": "ops", "ideas": 2}, {"step": "simplicity", "verdict": "simple"}, {"step": "data", "problems": 1, "notes": 2},
     {"step": "dryrun", "rules": 2, "matched": 30}, {"step": "ux", "verdict": "pass", "how": "screenshot"}]'::jsonb,
   '{"usd": 0.009, "partial": false, "uses": [
      {"provider": "anthropic", "model": "claude-haiku-4-5", "job": "ops", "calls": 1, "input": 200, "cacheRead": 0, "cacheWrite": 0, "output": 20, "usd": 0.002},
      {"provider": "anthropic", "model": "claude-haiku-4-5", "job": "review", "calls": 1, "input": 300, "cacheRead": 0, "cacheWrite": 0, "output": 30, "usd": 0.003},
      {"provider": "anthropic", "model": "claude-sonnet-5", "job": "ux", "calls": 1, "input": 400, "cacheRead": 0, "cacheWrite": 0, "output": 40, "usd": 0.004}]}'::jsonb,
   4000),
  ('${P}', '${C}', 'design',
   '[{"step": "ops", "ideas": 0}, {"step": "simplicity", "verdict": "redo"}, {"step": "data", "problems": 0, "notes": 0},
     {"step": "dryrun", "rules": 0, "matched": 0}, {"step": "ux", "verdict": "redo", "how": "text"}]'::jsonb,
   '{"usd": 0.009, "partial": false, "uses": [
      {"provider": "anthropic", "model": "claude-haiku-4-5", "job": "ops", "calls": 1, "input": 200, "cacheRead": 0, "cacheWrite": 0, "output": 20, "usd": 0.002},
      {"provider": "anthropic", "model": "claude-haiku-4-5", "job": "review", "calls": 1, "input": 300, "cacheRead": 0, "cacheWrite": 0, "output": 30, "usd": 0.003},
      {"provider": "anthropic", "model": "claude-sonnet-5", "job": "ux", "calls": 1, "input": 400, "cacheRead": 0, "cacheWrite": 0, "output": 40, "usd": 0.004}]}'::jsonb,
   5000),
  ('${P}', '${C}', 'design',
   '[{"step": "ops", "ideas": null}, {"step": "ux", "verdict": "skipped", "how": "none"}]'::jsonb,
   '{"usd": 0, "partial": false, "uses": []}'::jsonb,
   3000);

-- The owner's thumbs, on their own client.
select pg_temp.as('${OWNER}');
insert into public.reply_feedback (project_id, message_id, verdict) values ('${P}', '${M1}', 'up');
insert into public.reply_feedback (project_id, message_id, verdict, note)
  values ('${P}', '${M2}', 'down', 'Three fields for one thing ${tag}');
select pg_temp.say('owner_reads', (select count(*) from public.luke_skills where project_id = '${P}')::text);
reset role;

-- A teammate who builds in this store: what Luke learned is the owner's
-- (as what Luke knows has been since 0140), and the owner's threads are
-- not theirs to read, so neither are their replies to rate.
insert into public.project_members (project_id, user_id, joined_at, can_build) values ('${P}', '${MATE}', now(), true);
select pg_temp.as('${MATE}');
select pg_temp.say('mate_skills', (select count(*) from public.luke_skills where project_id = '${P}')::text);
select pg_temp.say('mate_events', (select count(*) from public.luke_learning_events where project_id = '${P}')::text);
select pg_temp.say('mate_vote', pg_temp.try($q$insert into public.reply_feedback (project_id, message_id, verdict)
  values ('${P}', '${M1}', 'up') returning 'ok'$q$));
reset role;

-- Another store's owner: reads none of it, writes none of it.
select pg_temp.as('${OTHER}');
select pg_temp.say('other_skills', (select count(*) from public.luke_skills where project_id = '${P}')::text);
select pg_temp.say('other_events', (select count(*) from public.luke_learning_events where project_id = '${P}')::text);
select pg_temp.say('other_feedback', (select count(*) from public.reply_feedback where project_id = '${P}')::text);
select pg_temp.say('other_write', pg_temp.try($q$insert into public.luke_skills (project_id, kind, title, body)
  values ('${P}', 'lesson', 'Sneaked in', 'Not theirs.') returning 'ok'$q$));
select pg_temp.say('other_vote', pg_temp.try($q$insert into public.reply_feedback (project_id, message_id, verdict)
  values ('${Q}', '${M1}', 'up') returning 'ok'$q$));
reset role;

-- The administrator.
select pg_temp.as('${ADMIN}');
select pg_temp.say('learning', public.abo_admin_learning(30)::text);
select pg_temp.say('project', public.abo_admin_learning_project('${P}', 90)::text);
select pg_temp.say('agents', public.abo_admin_agents(7)::text);
reset role;
-- The repeat rate's denominator, counted here the plain way.
select pg_temp.say('lessons_used', (
  select count(distinct e.skill_id) from public.luke_learning_events e
    join public.luke_skills s on s.id = e.skill_id
   where e.event = 'used' and s.kind = 'lesson' and e.at > now() - interval '30 days')::text);

-- A merchant asks.
select pg_temp.as('${OWNER}');
select pg_temp.say('merchant_learning', pg_temp.try('select public.abo_admin_learning(30)::text'));
select pg_temp.say('merchant_project', pg_temp.try($q$select public.abo_admin_learning_project('${P}')::text$q$));
select pg_temp.say('merchant_agents', pg_temp.try('select public.abo_admin_agents(7)::text'));

-- The thirty-first, written as the server writes it: on the owner's client.
insert into public.luke_skills (id, project_id, kind, title, body) values ('${NEW}', '${P}', 'lesson', 'The thirty-first ${tag}', 'Learned last.');
reset role;
select pg_temp.say('cap', (select string_agg(id::text || ':' || status, ',' order by id) from public.luke_skills where id in ('${W1}', '${W2}', '${NEW}')));
select pg_temp.say('cap_active', (select count(*) from public.luke_skills where project_id = '${P}' and status = 'active')::text);
select pg_temp.say('cap_logged', (select count(*) from public.luke_learning_events
  where project_id = '${P}' and skill_id = '${W2}' and event = 'retired' and detail->>'reason' = 'cap')::text);

select k, v from out;
rollback;
`,
  encoding: "utf8",
  env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
});
if (r.status !== 0) throw new Error(r.stderr.slice(0, 600));
const out = Object.fromEntries(
  r.stdout
    .split("\n")
    .filter((l) => l.includes("\t"))
    .map((l) => [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)])
);
const json = (k) => {
  try {
    return JSON.parse(out[k] ?? "null");
  } catch {
    return null;
  }
};
const newestFirst = (rows, key) => rows.every((x, i) => i === 0 || new Date(rows[i - 1][key]) >= new Date(x[key]));

console.log("the counts, across stores");
const [was, now] = [json("learning_before"), json("learning")];
const grew = (k) => Number(now?.totals?.[k]) - Number(was?.totals?.[k]);
check(
  "what happened in the window, and nothing from before it",
  grew("created") === 3 &&
    grew("patched") === 1 &&
    grew("used") === 4 &&
    grew("helped") === 2 &&
    grew("hurt") === 1 &&
    grew("repeats") === 1 &&
    grew("struck") === 1 &&
    grew("retired") === 0
);
check("today's active lessons and skills", grew("active_lessons") === 5 && grew("active_skills") === 25);
check("the owner's thumbs", grew("feedback_up") === 1 && grew("feedback_down") === 1);
check(
  "the reflector's runs and what they cost",
  grew("reflections") === 1 && Math.abs(grew("learning_usd") - 0.0123) < 1e-9
);
// Alone in the database, one lesson broken of the two in hand is a half.
const expected = !was?.totals?.used && !was?.totals?.repeats ? 0.5 : null;
const plain = Math.round((Number(now?.totals?.repeats) / Math.max(1, Number(out.lessons_used))) * 1000) / 1000;
check(
  "the repeat rate: mistakes made again over the lessons in hand",
  Math.abs(Number(now?.totals?.repeat_rate) - (expected ?? plain)) < 1e-9 && (expected === null || plain === 0.5)
);
const ours = now?.projects?.find((p) => p.project_id === P);
check(
  "the store's own row",
  ours?.project === `learning ${tag}` &&
    ours.active_lessons === 5 &&
    ours.active_skills === 25 &&
    ours.created === 3 &&
    ours.used === 4 &&
    ours.helped === 2 &&
    ours.hurt === 1 &&
    ours.repeats === 1 &&
    ours.reflections === 1 &&
    Math.abs(ours.learning_usd - 0.0123) < 1e-9 &&
    ours.feedback_up === 1 &&
    ours.feedback_down === 1
);
check("stores newest first", newestFirst(now?.projects ?? [], "last_at"));
check(
  "a lesson by its name across stores",
  (now?.top ?? []).some((t) => t.title === asked && t.kind === "lesson" && t.projects === 1 && t.uses === 900)
);

console.log("\none store");
const store = json("project");
check("named", store?.project?.id === P && store.project.name === `learning ${tag}`);
check(
  "every lesson and skill, the struck one too, newest changed first",
  store?.skills?.length === 31 &&
    store.skills.some((s) => s.id === X && s.status === "struck") &&
    newestFirst(store.skills, "updated_at")
);
check(
  "the timeline in the window, newest first, each with its lesson",
  store?.events?.length === 14 &&
    newestFirst(store.events, "at") &&
    store.events.some(
      (e) => e.event === "repeat" && e.title === asked && e.kind === "lesson" && e.conversation_id === C
    )
);
check(
  "a reflection, with why it ran and what it kept",
  (store?.events ?? []).some(
    (e) =>
      e.event === "reflected" &&
      e.skill_id === null &&
      e.detail?.why === "the owner said it was wrong" &&
      e.detail?.outcome?.created === 2
  )
);
check("a change says its version", store?.events?.find((e) => e.event === "patched")?.version === 2);
check(
  "the owner's verdicts, with the note and the thread",
  store?.feedback?.length === 2 &&
    store.feedback.some((f) => f.verdict === "down" && f.note?.includes(tag) && f.conversation_id === C)
);

console.log("\nthirty at most");
check(
  "the thirty-first retires the weakest, the one untouched longer of two",
  out.cap === `${W1}:active,${W2}:retired,${NEW}:active`
);
check("thirty stay active", out.cap_active === "30");
check("and the timeline says why", out.cap_logged === "1");

console.log("\nthe agents");
const [ab, aa] = [json("agents_before"), json("agents")];
const agent = (x, n) => x?.agents?.find((g) => g.name === n);
const moved = (n, k) => Number(agent(aa, n)?.outcomes?.[k]) - Number(agent(ab, n)?.outcomes?.[k]);
const AGENTS = [
  "scout",
  "plan",
  "design",
  "validator",
  "critic",
  "ops",
  "simplicity",
  "data check",
  "dry-run",
  "screen check",
  "tryout",
  "gap",
  "memory",
  "reflect",
  "judge",
  "ai step",
  "follow-up",
];
// After them, a card of its own for any model job none of them counts (0186): the talk road's replies, say.
const names = (aa?.agents ?? []).map((g) => g.name);
check("every agent is there, the reviewers after the critic", names.slice(0, AGENTS.length).join() === AGENTS.join());
check(
  "and after them only model jobs no card counts",
  names.slice(AGENTS.length).every((n) => !AGENTS.includes(n) && !(aa?.agents ?? []).find((g) => g.name === n)?.about)
);
check("the critic: three fit, two went back", moved("critic", "fits") === 3 && moved("critic", "redo") === 2);
check(
  "its calls and tokens, from the meter",
  agent(aa, "critic").calls - agent(ab, "critic").calls === 5 &&
    agent(aa, "critic").input - agent(ab, "critic").input === 500
);
check("the validator: two repaired", moved("validator", "repaired") === 2);
check(
  "the reflector: its runs, what they kept, and their own dollars",
  agent(aa, "reflect")?.runs - agent(ab, "reflect")?.runs === 1 &&
    moved("reflect", "created") === 2 &&
    moved("reflect", "patched") === 1 &&
    moved("reflect", "retired") === 0 &&
    moved("reflect", "repeats") === 1 &&
    Math.abs(Number(agent(aa, "reflect")?.usd) - Number(agent(ab, "reflect")?.usd) - 0.0123) < 1e-9
);
const ran = (n) => Number(agent(aa, n)?.runs) - Number(agent(ab, n)?.runs);
const spent = (n) => Number(agent(aa, n)?.usd) - Number(agent(ab, n)?.usd);
const called = (n) => Number(agent(aa, n)?.calls) - Number(agent(ab, n)?.calls);
check(
  "the operator's view: two asked, one idea and one none, on its own job's dollars",
  ran("ops") === 2 &&
    moved("ops", "idea") === 1 &&
    moved("ops", "none") === 1 &&
    called("ops") === 2 &&
    Math.abs(spent("ops") - 0.004) < 1e-9
);
check(
  "simplicity: one simple, one sent back, on the meter's 'review' job",
  ran("simplicity") === 2 &&
    moved("simplicity", "simple") === 1 &&
    moved("simplicity", "redo") === 1 &&
    called("simplicity") === 2 &&
    Math.abs(spent("simplicity") - 0.006) < 1e-9
);
check(
  "the data check: one with a problem, one clean, and no dollars: it is code",
  ran("data check") === 2 &&
    moved("data check", "problems found") === 1 &&
    moved("data check", "clean") === 1 &&
    agent(aa, "data check")?.usd === null &&
    agent(aa, "data check")?.calls === 0 &&
    agent(aa, "data check")?.note === "code, no model"
);
const rulesTried = (x) => Number(/^(\d+) rules tried/.exec(agent(x, "dry-run")?.note ?? "")?.[1]);
check(
  "the dry-run: two ran, one had rules, two rules tried in all, no dollars",
  ran("dry-run") === 2 &&
    moved("dry-run", "tried") === 1 &&
    rulesTried(aa) - rulesTried(ab) === 2 &&
    agent(aa, "dry-run")?.usd === null &&
    agent(aa, "dry-run")?.calls === 0
);
check(
  "the screen check: the skipped one not counted, one pass, one redo, on the meter's 'ux' job",
  ran("screen check") === 2 &&
    moved("screen check", "pass") === 1 &&
    moved("screen check", "redo") === 1 &&
    called("screen check") === 2 &&
    Math.abs(spent("screen check") - 0.008) < 1e-9 &&
    /^\d+% by screenshot, \d+% by text$/.test(agent(aa, "screen check")?.note ?? "")
);
check(
  "a road's turns and times",
  (aa?.roads ?? []).some((x) => x.road === "design" && x.turns >= 5 && x.p50_ms !== null && x.p90_ms >= x.p50_ms)
);

console.log("\nwho may read it");
check("the owner reads their own", out.owner_reads === "31");
check("a teammate reads none of what Luke learned", out.mate_skills === "0" && out.mate_events === "0");
check("nor rates a reply in the owner's thread, which they cannot read", out.mate_vote?.startsWith("ERR 42501"));
check(
  "another store's owner reads none of it",
  out.other_skills === "0" && out.other_events === "0" && out.other_feedback === "0"
);
check("nor writes a lesson into it", out.other_write?.startsWith("ERR 42501"));
check("nor files a verdict on its replies", out.other_vote?.startsWith("ERR 42501"));
check(
  "a merchant is refused the console",
  ["merchant_learning", "merchant_project", "merchant_agents"].every((k) => out[k]?.startsWith("ERR 42501"))
);

console.log(
  fails.length
    ? `\n${fails.length} FAILED`
    : "\nwhat Luke learned is counted right, kept to thirty, and shown only to an administrator"
);
process.exit(fails.length ? 1 : 0);
