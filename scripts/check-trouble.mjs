// What needs a look (0175, kept since 0211), against the check database,
// in one transaction that is rolled back.
//
// Tanish found the RTO tangle and the broken rule by hand (3 Oct); every
// sign was already in the database. One of each is planted here, beside
// the ordinary work that must not show: each sign is listed, newest first,
// with where to look, and only to an administrator. And what Tanish's first
// meeting showed it missing (0211): a slow or stopped turn, an ask left
// undone, Luke saying he can't, "why would I lie" and a lone "?", three
// builds in an hour, a rule that ran and changed nothing or never ran, a
// list cut short, and an owner who left a question. Yesterday, worst first.
//
//   ENV_FILE=.env.check.local node scripts/check-trouble.mjs

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
const id = (n) => `7a666666-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [ADMIN, MERCHANT, P, C, M, CALM, FILL, WATCH] = [id(1), id(2), id(10), id(11), id(20), id(21), id(30), id(31)];
const [FAILED, OK_TURN] = [id(40), id(41)];
const [C2, C3, C4, NEVERM, NEVER, IDLE, BUSY, CUT, ASKED, ANSWERED] = [50, 51, 52, 60, 61, 62, 63, 64, 70, 71].map(id);
const cols = (fields) => JSON.stringify({ columns: fields.map(([field, type]) => ({ field, label: field, type })) });

const r = spawnSync("psql", [env.DATABASE_URL, "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1"], {
  input: `
begin;
create function pg_temp.as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;
insert into auth.users (id, instance_id, aud, role, email) values
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tr-admin-${tag}@warmluke.test'),
  ('${MERCHANT}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tr-merchant-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN}', true)
  on conflict (user_id) do update set is_superadmin = true;
insert into public.projects (id, owner_id, name) values ('${P}', '${MERCHANT}', 'trouble ${tag}');
insert into public.conversations (id, project_id, title) values ('${C}', '${P}', 'RTO ${tag}');

-- The owner, unhappy and not; an old complaint, out of the window.
insert into public.messages (conversation_id, role, content, payload, created_at) values
  ('${C}', 'user', 'x', '{"kind": "user", "text": "ye galat hai, phir se banao"}', now() - interval '5 minutes'),
  ('${C}', 'user', 'x', '{"kind": "user", "text": "add a note field to shipments"}', now() - interval '4 minutes'),
  ('${C}', 'user', 'x', '{"kind": "user", "text": "this is wrong ${tag}"}', now() - interval '10 days');
-- Luke: a turn that failed, one with three repairs, one the critic sent back, one that went fine.
insert into public.messages (id, conversation_id, role, content, payload, created_at) values
  ('${FAILED}', '${C}', 'assistant', '', '{"type": "unanswered", "message": "Luke could not get this right"}', now() - interval '3 minutes'),
  ('${OK_TURN}', '${C}', 'assistant', '', '{"type": "answer"}', now() - interval '3 minutes');
insert into public.turn_traces (project_id, conversation_id, turn_id, repairs, plan_goal, critic, created_at) values
  ('${P}', '${C}', '${FAILED}', 1, 'Mark RTO orders', null, now() - interval '3 minutes'),
  ('${P}', '${C}', null, 3, 'Add RTO status', null, now() - interval '2 minutes'),
  ('${P}', '${C}', null, 0, 'A simple table', '{"verdict": "redo", "missing": 2}', now() - interval '1 minute'),
  ('${P}', '${C}', '${OK_TURN}', 1, 'A note field', '{"verdict": "fits", "missing": 0}', now() - interval '1 minute');

-- A section changed four times today, its newest holding one fact three ways; another changed twice.
insert into public.modules (id, project_id, name, nav_label, route, created_by) values
  ('${M}', '${P}', 'ships-${tag}', 'Shipments', '/modules/ships-${tag}', '${MERCHANT}'),
  ('${CALM}', '${P}', 'calm-${tag}', 'Calm', '/modules/calm-${tag}', '${MERCHANT}');
insert into public.ui_schemas (module_id, schema_json, version, change_description, created_at) values
  ('${M}', '${cols([["order", "text"]])}', 1, 'Made it', now() - interval '9 minutes'),
  ('${M}', '${cols([
    ["order", "text"],
    ["rto", "boolean"],
  ])}', 2, 'Added RTO', now() - interval '8 minutes'),
  ('${M}', '${cols([
    ["order", "text"],
    ["rto", "boolean"],
    ["rto_status", "badge"],
  ])}', 3, 'RTO status', now() - interval '7 minutes'),
  ('${M}', '${cols([
    ["order", "text"],
    ["rto", "boolean"],
    ["rto_status", "badge"],
    ["is_rto", "boolean"],
    ["order_status", "badge"],
    ["rto_note", "text"],
  ])}', 4, 'Is RTO', now() - interval '6 minutes'),
  ('${CALM}', '${cols([
    ["name", "text"],
    ["paid", "boolean"],
  ])}', 1, 'Made it', now() - interval '9 minutes'),
  ('${CALM}', '${cols([
    ["name", "text"],
    ["paid", "boolean"],
    ["paid_on", "date"],
  ])}', 2, 'Paid on', now() - interval '8 minutes');

-- A schedule writing into every row, failing; a schedule with a condition, working.
insert into public.automations (id, project_id, module_id, name, enabled, definition, created_at) values
  ('${FILL}', '${P}', '${M}', 'Fill RTO status', true,
   '{"trigger": {"type": "schedule", "every": "hourly"}, "actions": [{"type": "set_fields", "target": {"self": true}, "values": {"rto_status": "No"}}]}',
   now() - interval '8 minutes'),
  ('${WATCH}', '${P}', '${M}', 'Flag late ones', true,
   '{"trigger": {"type": "schedule", "every": "daily", "when": {"op": "eq", "left": {"field": "rto"}, "right": true}}, "actions": [{"type": "set_fields", "target": {"self": true}, "values": {"rto_note": "late"}}]}',
   now() - interval '8 minutes');
insert into public.automation_runs (automation_id, ok, detail, created_at) values
  ('${FILL}', false, '{"error": "No field rto_status"}', now() - interval '2 minutes'),
  ('${FILL}', false, '{"error": "No field rto_status"}', now() - interval '1 minute'),
  ('${WATCH}', true, null, now() - interval '1 minute');

-- A written screen that broke twice, told by the owner who had it open (0178).
select pg_temp.as('${MERCHANT}');
insert into public.screen_errors (project_id, module_id, screen, message) values
  ('${P}', '${M}', 'Queue', 'wl.find did not work: Failed to fetch'),
  ('${P}', '${M}', 'Queue', 'wl.find did not work: Failed to fetch');
reset role;

-- What 0211 adds. Yesterday, in the console's zone: one conversation that went badly.
create function pg_temp.yday(m integer) returns timestamptz language sql as $f$
  select ((((now() at time zone 'Asia/Kolkata')::date - 1) + time '12:00') at time zone 'Asia/Kolkata') + make_interval(mins => m)
$f$;
insert into public.conversations (id, project_id, title) values
  ('${C2}', '${P}', 'Parent stock ${tag}'), ('${C3}', '${P}', 'Left ${tag}'), ('${C4}', '${P}', 'Answered ${tag}');
insert into public.messages (id, conversation_id, role, content, payload, created_at) values
  (gen_random_uuid(), '${C2}', 'assistant', '', '{"type": "build", "message": "New section: Parent Stock"}', pg_temp.yday(0)),
  (gen_random_uuid(), '${C2}', 'assistant', '', '{"type": "build", "message": "Change Parent Stock"}', pg_temp.yday(20)),
  (gen_random_uuid(), '${C2}', 'assistant', '', '{"type": "build", "message": "Delete this section · New section: Parent Stock"}', pg_temp.yday(40)),
  (gen_random_uuid(), '${C2}', 'user', 'x', '{"kind": "user", "text": "But, bro, why would I lie?"}', pg_temp.yday(45)),
  (gen_random_uuid(), '${C2}', 'user', 'x', '{"kind": "user", "text": "?"}', pg_temp.yday(46)),
  (gen_random_uuid(), '${C2}', 'user', 'x', '{"kind": "user", "text": "why is my stock zero on the blank?"}', pg_temp.yday(47)),
  (gen_random_uuid(), '${C2}', 'assistant', '', '{"type": "answer", "message": "Let us look. I can''t actually see your custom rows, they live in the app. Check Parent Stock."}', pg_temp.yday(48)),
  (gen_random_uuid(), '${C2}', 'assistant', '', '{"type": "answer", "message": "I can help with that: here is what Stock says."}', pg_temp.yday(49)),
  (gen_random_uuid(), '${C2}', 'assistant', '', '{"type": "stopped"}', pg_temp.yday(50)),
  ('${ASKED}', '${C3}', 'assistant', '', '{"type": "clarify", "message": "Which blank does this design use?"}', now() - interval '13 hours'),
  ('${ANSWERED}', '${C4}', 'assistant', '', '{"type": "clarify", "message": "Which store?"}', now() - interval '13 hours'),
  (gen_random_uuid(), '${C4}', 'user', 'x', '{"kind": "user", "text": "the main one"}', now() - interval '12 hours'),
  (gen_random_uuid(), '${C}', 'assistant', '', '{"type": "build", "message": "One"}', now() - interval '50 minutes'),
  (gen_random_uuid(), '${C}', 'assistant', '', '{"type": "build", "message": "Two"}', now() - interval '40 minutes');
insert into public.turn_traces (project_id, conversation_id, turn_id, road, repairs, took_ms, unmet, created_at) values
  ('${P}', '${C2}', null, 'design', 0, 182000, '["Packed status on every order"]', pg_temp.yday(10)),
  ('${P}', '${C2}', null, 'talk', 0, 30000, '[]', pg_temp.yday(11));
-- A section of their own, and four rules on it: one that never ran though a
-- row came, one that ran and changed nothing, one that did, one handed a list cut short.
insert into public.modules (id, project_id, name, nav_label, route, created_by) values
  ('${NEVERM}', '${P}', 'parent-${tag}', 'Parent Stock', '/modules/parent-${tag}', '${MERCHANT}');
insert into public.ui_schemas (module_id, schema_json, version, change_description, created_at) values
  ('${NEVERM}', '${cols([["name", "text"]])}', 1, 'Made it', now() - interval '3 hours');
insert into public.automations (id, project_id, module_id, name, enabled, definition, created_at) values
  ('${NEVER}', '${P}', '${NEVERM}', 'Push to children', true,
   '{"trigger": {"type": "record_created"}, "actions": [{"type": "run_code", "code": "export default function run() { return {}; }", "reads": []}]}',
   now() - interval '2 hours'),
  ('${IDLE}', '${P}', '${NEVERM}', 'Sync blank stock', true,
   '{"trigger": {"type": "record_updated"}, "actions": [{"type": "run_code", "code": "export default function run() { return {}; }", "reads": []}]}',
   now() - interval '2 hours'),
  ('${BUSY}', '${P}', '${NEVERM}', 'Busy one', true,
   '{"trigger": {"type": "record_updated", "when": {"op": "changed", "args": [{"field": "name"}]}}, "actions": [{"type": "run_code", "code": "export default function run() { return {}; }", "reads": []}]}',
   now() - interval '2 hours'),
  ('${CUT}', '${P}', '${NEVERM}', 'Read everything', true,
   '{"trigger": {"type": "record_updated", "when": {"op": "changed", "args": [{"field": "name"}]}}, "actions": [{"type": "run_code", "code": "export default function run() { return {}; }", "reads": []}]}',
   now() - interval '2 hours');
insert into public.records (module_id, project_id, data, created_at, updated_at) values
  ('${NEVERM}', '${P}', '{"name": "POX-iPh17PM-SL"}', now() - interval '30 minutes', now() - interval '30 minutes');
insert into public.automation_runs (automation_id, ok, detail, created_at) values
  ('${IDLE}', true, '{"kind": "code", "wrote": 0, "read": {"Stock": {"rows": 500, "cut": false}}}', now() - interval '20 minutes'),
  ('${IDLE}', true, '{"kind": "code", "wrote": 0}', now() - interval '15 minutes'),
  ('${IDLE}', true, '{"kind": "code", "wrote": 0}', now() - interval '10 minutes'),
  ('${BUSY}', true, '{"kind": "code", "wrote": 0}', now() - interval '20 minutes'),
  ('${BUSY}', true, '{"kind": "code", "wrote": 2}', now() - interval '15 minutes'),
  ('${BUSY}', true, '{"kind": "code", "wrote": 0}', now() - interval '10 minutes'),
  ('${CUT}', true, '{"kind": "code", "wrote": 34, "read": {"Stock": {"rows": 50000, "cut": true}}}', now() - interval '5 minutes');

-- From the start: what was planted back in time is scanned, as on a fresh database.
delete from public.trouble_scan;
select pg_temp.as('${ADMIN}');
select 'admin', public.abo_admin_trouble(7)::text;
select 'day', public.abo_admin_trouble_day(null, '${P}')::text;
reset role;
select 'scan1', count(*) from public.trouble_signs where project_id = '${P}';
select 'rescan', public.abo_trouble_scan() >= 0;
select 'scan2', count(*) from public.trouble_signs where project_id = '${P}';
select pg_temp.as('${MERCHANT}');
do $d$ begin
  perform public.abo_admin_trouble(7);
  raise notice 'merchant-saw-it';
exception when insufficient_privilege then null;
end $d$;
select 'merchant', 'refused';
do $d$ begin
  perform public.abo_trouble_scan();
  raise notice 'merchant-scanned';
exception when insufficient_privilege then null;
end $d$;
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
const all = JSON.parse(out.admin ?? "[]");
const ours = all.filter((s) => s.project_id === P);
const of = (kind) => ours.filter((s) => s.kind === kind);
const has = (kind, words) => of(kind).some((s) => s.detail.includes(words));

console.log("the signs");
check("a turn that failed", has("turn", "The turn failed"));
check("a turn that needed three repairs", has("turn", "Needed 3 repairs"));
check("a design the critic sent back", has("turn", "The critic sent the design back"));
check("a turn that went fine is not there", of("turn").length === 3);
check(
  "the owner, unhappy, in their own words",
  of("frustrated").some((s) => s.sample.includes("galat")) &&
    !of("frustrated").some((s) => s.sample.includes("add a note"))
);
check("a section changed four times in a day", has("churn", "Shipments changed 4 times in a day"));
check("one changed twice is not", of("churn").length === 1);
check("a rule that failed, and how often", has("rule", 'Rule "Fill RTO status" failed 2 times'));
check("a schedule writing into every row", has("workaround", 'Rule "Fill RTO status" sets fields on every row'));
check("a schedule with a condition is not", !has("workaround", "Flag late ones"));
check(
  "one fact kept three ways",
  of("workaround").some((s) => s.detail === 'Shipments has 3 fields for "rto"' && s.sample.includes("is_rto"))
);
check("a word like status, shared by any fields, is not", !has("workaround", 'for "status"'));

check(
  "a written screen that broke, counted, with its message",
  of("screen").some(
    (s) => s.detail === 'The screen "Queue" on Shipments broke 2 times' && s.sample.includes("Failed to fetch")
  )
);

console.log("\nwhat Tanish's first meeting showed it missing (0211)");
const in2 = (kind) => of(kind).filter((s) => s.conversation_id === C2);
check(
  "a design turn the owner waited three minutes on",
  in2("slow").some((s) => s.detail === "A design turn took 182 s")
);
check("a quick turn is not", !in2("slow").some((s) => s.detail.includes("took 30 s")));
check(
  "a turn stopped before it answered",
  in2("slow").some((s) => s.detail.includes("stopped"))
);
check(
  "an ask the app could not do",
  in2("gap").some((s) => s.sample === "Packed status on every order")
);
check(
  "Luke saying he can't, the sentence that says it",
  in2("cant").length === 1 && in2("cant")[0].sample.trim().startsWith("I can't actually see your custom rows")
);
check(
  '"why would I lie" and a lone "?"',
  ["why would I lie", "?"].every((w) => in2("frustrated").some((s) => s.sample.includes(w)))
);
check("a plain question is not unhappy", !in2("frustrated").some((s) => s.sample.includes("stock zero")));
check(
  "three builds in an hour",
  in2("rebuilds").some((s) => s.detail.startsWith("3 builds in one conversation, three within 40 min"))
);
check("two builds are not", !of("rebuilds").some((s) => s.conversation_id === C));
check(
  "a rule that never ran, though a row came",
  has("idle", 'Rule "Push to children" never ran, though rows were added')
);
check("a rule that ran and changed nothing", has("idle", 'Rule "Sync blank stock" ran 3 times and changed nothing'));
check("one that changed rows once is not", !has("idle", "Busy one"));
check("a rule with a condition is not called idle", !has("idle", "Read everything"));
check("a rule handed a list cut short", has("cut", 'Rule "Read everything" read a list cut short 1 time'));
check(
  "a question left unanswered",
  of("left").some((s) => s.conversation_id === C3 && s.detail.includes("question"))
);
check("one answered is not", !of("left").some((s) => s.conversation_id === C4));
check(
  "each names its turn where it has one",
  in2("cant").every((s) => typeof s.turn_id === "string")
);

console.log("\nkept once, and yesterday worst first");
check("a scan run again keeps the same signs", Number(out.scan1) > 0 && out.scan1 === out.scan2);
const day = JSON.parse(out.day ?? "{}");
check("yesterday is counted", day.total >= 7 && typeof day.before === "number");
check(
  "by kind",
  (day.kinds ?? []).some((k) => k.kind === "rebuilds" && k.n === 1)
);
check(
  "the conversation that went worst comes first",
  day.worst?.[0]?.conversation_id === C2 && day.worst[0].title === `Parent stock ${tag}` && day.worst[0].score >= 10
);

console.log("\nwhere to look");
check(
  "each turn and complaint names its thread",
  [...of("turn"), ...of("frustrated")].every(
    (s) =>
      (s.conversation_id === C && s.title === `RTO ${tag}`) ||
      (s.conversation_id === C2 && s.title === `Parent stock ${tag}`)
  )
);
check("each names its project", ours.length > 0 && ours.every((s) => s.project === `trouble ${tag}`));
check(
  "newest first",
  all.every((s, i) => i === 0 || new Date(all[i - 1].at) >= new Date(s.at))
);
check("nothing from before the window", !ours.some((s) => (s.sample ?? "").includes(`this is wrong ${tag}`)));

console.log("\nwho may read it");
check("a merchant is refused", out.merchant === "refused" && !r.stderr.includes("merchant-saw-it"));
check("and cannot run the scan", !r.stderr.includes("merchant-scanned"));

console.log(
  fails.length ? `\n${fails.length} FAILED` : "\nwhat needs a look is found, and only shown to an administrator"
);
process.exit(fails.length ? 1 : 0);
