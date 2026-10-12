// What each rule has done (0172), against the check database, in one
// transaction that is rolled back.
//
// The Rules dialog read the newest 200 runs of every rule together, and
// only the kind a rule of expressions leaves: a rule of code, 25 runs
// without an error, read "Hasn't run yet" (Tanish, 3 Oct). Now each rule
// says how many times it ran, how many failed, and its last run, of both
// kinds; and only to whoever may see the rule.
//
// And since 0206, a rule of code run after the owner's write is kept too
// (abo_rule_ran), with what its last run changed and whether a list it read
// was cut short; a queued job kept as a run is counted once; runs past sixty
// days are folded into the rule's totals before they go; and each run reads
// back, newest first, for Luke and the owner's own AI (abo_rule_runs).
//
//   ENV_FILE=.env.check.local node scripts/check-rule-log.mjs

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
const id = (n) => `7a555555-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [OWNER, STRANGER, P, M, SQL_RULE, CODE_RULE, QUIET, INLINE, JOB_KEPT] = [
  id(1),
  id(2),
  id(10),
  id(20),
  id(30),
  id(31),
  id(32),
  id(33),
  id(40),
];

const r = spawnSync("psql", [env.DATABASE_URL, "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1"], {
  input: `
begin;
create function pg_temp.as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;
insert into auth.users (id, instance_id, aud, role, email) values
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rl-owner-${tag}@warmluke.test'),
  ('${STRANGER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rl-stranger-${tag}@warmluke.test');
insert into public.projects (id, owner_id, name) values ('${P}', '${OWNER}', 'rule log ${tag}');
insert into public.modules (id, project_id, name, nav_label, route, created_by)
  values ('${M}', '${P}', 'flags-${tag}', 'Flags', '/modules/flags-${tag}', '${OWNER}');
insert into public.automations (id, project_id, module_id, name, definition) values
  ('${SQL_RULE}', '${P}', '${M}', 'Fill a field', '{"trigger": {"type": "schedule", "every": "hourly"}, "actions": []}'),
  ('${CODE_RULE}', '${P}', '${M}', 'Flag repeat orders', '{"trigger": {"type": "store_row_added"}, "actions": [{"type": "run_code", "code": ""}]}'),
  ('${QUIET}', '${P}', '${M}', 'Never yet', '{"trigger": {"type": "schedule", "every": "daily"}, "actions": []}'),
  ('${INLINE}', '${P}', '${M}', 'Sync blank stock', '{"trigger": {"type": "record_updated"}, "actions": [{"type": "run_code", "code": ""}]}');
-- A rule of expressions: three runs on rows, the newest failed.
insert into public.automation_runs (automation_id, ok, detail, created_at) values
  ('${SQL_RULE}', true, null, now() - interval '3 hours'),
  ('${SQL_RULE}', true, null, now() - interval '2 hours'),
  ('${SQL_RULE}', false, '{"error": "No field rto_status"}', now() - interval '1 hour');
-- A rule of code: four jobs done, one failed, one still queued (not a run yet).
insert into public.code_jobs (project_id, automation_id, kind, status, error, created_at, finished_at) values
  ('${P}', '${CODE_RULE}', 'added', 'done', null, now() - interval '50 minutes', now() - interval '49 minutes'),
  ('${P}', '${CODE_RULE}', 'added', 'failed', 'boom', now() - interval '40 minutes', now() - interval '39 minutes'),
  ('${P}', '${CODE_RULE}', 'added', 'done', null, now() - interval '30 minutes', now() - interval '29 minutes'),
  ('${P}', '${CODE_RULE}', 'added', 'done', null, now() - interval '20 minutes', now() - interval '19 minutes'),
  ('${P}', '${CODE_RULE}', 'added', 'queued', null, now() - interval '1 minute', null);
-- Since 0206 a queued job keeps a run of its own: the job and its run are one run.
insert into public.code_jobs (id, project_id, automation_id, kind, status, error, created_at, finished_at) values
  ('${JOB_KEPT}', '${P}', '${CODE_RULE}', 'added', 'done', null, now() - interval '10 minutes', now() - interval '9 minutes');
insert into public.automation_runs (automation_id, ok, detail, created_at) values
  ('${CODE_RULE}', true, '{"kind": "code", "trigger": "store_row_added", "wrote": 2, "job": "${JOB_KEPT}"}', now() - interval '9 minutes');
-- A run past sixty days, and a job past it, to be folded away.
insert into public.automation_runs (automation_id, ok, detail, created_at) values
  ('${SQL_RULE}', false, '{"error": "old"}', now() - interval '70 days');
insert into public.code_jobs (project_id, automation_id, kind, status, error, created_at, finished_at) values
  ('${P}', '${CODE_RULE}', 'added', 'done', null, now() - interval '70 days', now() - interval '70 days');

select 'before', public.abo_rule_log('${P}')::text;
select 'swept', public.abo_rule_runs_sweep()::text;
select 'after', public.abo_rule_log('${P}')::text;
select 'left', (select count(*) from public.automation_runs where automation_id in ('${SQL_RULE}', '${CODE_RULE}') and created_at < now() - interval '60 days')
       + (select count(*) from public.code_jobs where automation_id = '${CODE_RULE}' and created_at < now() - interval '60 days');

select pg_temp.as('${OWNER}');
-- A rule of code after the owner's own write: kept by them, cut short and changing nothing.
select public.abo_rule_ran('${INLINE}', null, true,
  '{"kind": "code", "trigger": "record_updated", "read": {"Stock": {"rows": 50000, "cut": true}}, "wrote": 0, "ai": "forged"}');
select 'owner', public.abo_rule_log('${P}')::text;
select 'runs', public.abo_rule_runs('${P}', null, 50)::text;
select 'one', public.abo_rule_runs('${P}', 'sync blank stock', 5)::text;
select pg_temp.as('${STRANGER}');
select 'stranger', public.abo_rule_log('${P}')::text;
select 'stranger_runs', public.abo_rule_runs('${P}', null, 50)::text;
do $t$ begin
  perform public.abo_rule_ran('${INLINE}', null, true, '{}');
  raise notice 'refused:no';
exception when insufficient_privilege then
  raise notice 'refused:yes';
end $t$;
rollback;
`,
  encoding: "utf8",
  env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
});
if (r.status !== 0) throw new Error(r.stderr.slice(0, 600));
const strangerRefused = /refused:yes/.test(r.stderr);
const out = Object.fromEntries(
  r.stdout
    .split("\n")
    .filter((l) => l.includes("\t"))
    .map((l) => [l.slice(0, l.indexOf("\t")), JSON.parse(l.slice(l.indexOf("\t") + 1))])
);
const log = out.owner ?? {};

console.log("what each rule has done");
const sql = log[SQL_RULE];
// Three runs, the newest failed, and one past sixty days that failed too.
check("a rule of expressions: its runs counted, and the ones that failed", sql?.runs === 4 && sql?.failed === 2);
check("its last run, with its error", sql?.last?.ok === false && sql?.last?.error === "No field rto_status");
const code = log[CODE_RULE];
check(
  "a rule of code: its runs counted too, the queued one not yet, a job kept as a run once",
  // four jobs, one kept as a run, and one past sixty days
  code?.runs === 6 && code?.failed === 1
);
check("its last run is its newest finished one, which worked", code?.last?.ok === true && code?.last?.error === null);
check("and says what it changed", code?.last?.wrote === 2 && code?.last?.cut === false);
const inline = log[INLINE];
check("a rule of code after the owner's own write is kept", inline?.runs === 1 && inline?.last?.ok === true);
check(
  "with what its last run changed, and that a list it read was cut short",
  inline?.last?.wrote === 0 && inline?.last?.cut === true
);

console.log("\nkept sixty days, counted always");
check("old runs and old jobs are folded and let go", out.left === 0 && out.swept >= 1);
check(
  "and every rule's count and failures stay what they were",
  out.before?.[SQL_RULE]?.runs === out.after?.[SQL_RULE]?.runs &&
    out.before?.[SQL_RULE]?.failed === out.after?.[SQL_RULE]?.failed &&
    out.before?.[CODE_RULE]?.runs === out.after?.[CODE_RULE]?.runs &&
    out.after?.[SQL_RULE]?.runs === 4
);

console.log("\neach run, read back");
const runs = out.runs ?? [];
check("newest first, every kind", runs.length === 9 && runs[0]?.rule === "Sync blank stock");
check(
  "with what set it off and what it read",
  runs[0]?.trigger === "record_updated" && runs[0]?.read?.Stock?.cut === true && runs[0]?.kind === "code"
);
check("a forged AI step is not one", runs[0]?.kind === "code");
check("one rule by its name, whatever its case", out.one?.length === 1 && out.one[0]?.rule === "Sync blank stock");
check("a job kept as a run is one run", runs.filter((x) => x.rule === "Flag repeat orders").length === 5);
check("a rule that never ran says so", log[QUIET]?.runs === 0 && log[QUIET]?.last === null);

console.log("\nwho may read it");
check("nobody outside the project sees a rule of it", JSON.stringify(out.stranger) === "{}");
check("nor its runs", JSON.stringify(out.stranger_runs) === "[]");
check("nor keeps a run of it", strangerRefused);

console.log(fails.length ? `\n${fails.length} FAILED` : "\neach rule says what it has done");
process.exit(fails.length ? 1 : 0);
