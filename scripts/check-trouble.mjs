// What needs a look (0175), against the check database, in one
// transaction that is rolled back.
//
// Tanish found the RTO tangle and the broken rule by hand (3 Oct); every
// sign was already in the database. One of each is planted here, beside
// the ordinary work that must not show: each sign is listed, newest first,
// with where to look, and only to an administrator.
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

select pg_temp.as('${ADMIN}');
select 'admin', public.abo_admin_trouble(7)::text;
select pg_temp.as('${MERCHANT}');
do $d$ begin
  perform public.abo_admin_trouble(7);
  raise notice 'merchant-saw-it';
exception when insufficient_privilege then null;
end $d$;
select 'merchant', 'refused';
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
  of("frustrated").length === 1 && of("frustrated")[0].sample.includes("galat")
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

console.log("\nwhere to look");
check(
  "each turn and complaint names its thread",
  [...of("turn"), ...of("frustrated")].every((s) => s.conversation_id === C && s.title === `RTO ${tag}`)
);
check("each names its project", ours.length > 0 && ours.every((s) => s.project === `trouble ${tag}`));
check(
  "newest first",
  all.every((s, i) => i === 0 || new Date(all[i - 1].at) >= new Date(s.at))
);
check("nothing from before the window", !ours.some((s) => (s.sample ?? "").includes(`this is wrong ${tag}`)));

console.log("\nwho may read it");
check("a merchant is refused", out.merchant === "refused" && !r.stderr.includes("merchant-saw-it"));

console.log(
  fails.length ? `\n${fails.length} FAILED` : "\nwhat needs a look is found, and only shown to an administrator"
);
process.exit(fails.length ? 1 : 0);
