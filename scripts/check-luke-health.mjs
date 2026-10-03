// The console says when Luke is failing (0165), against the check
// database, in one transaction that is rolled back.
//
// On 3 October the model account ran out and merchants' turns failed
// for an hour before anyone here knew. A turn that fails because the
// model was not there keeps what it was (payload.failed); every console
// screen asks abo_admin_luke_health whether that is happening now.
//
//   ENV_FILE=.env.check.local node scripts/check-luke-health.mjs

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
const id = (n) => `7a666666-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [ADMIN, OWNER, P1, P2, C1, C2] = [id(1), id(2), id(10), id(11), id(20), id(21)];
// The newest turns anywhere in the check database decide "now": these are
// made a minute ahead of every other, so the check reads its own.
const at = (s) => `now() + interval '${s} seconds'`;
const turn = (conv, s, payload) =>
  `insert into public.messages (conversation_id, role, content, payload, created_at) values
     ('${conv}', 'user', 'asked', '{"kind":"user","text":"asked"}', ${at(s)}),
     ('${conv}', 'assistant', '', '${JSON.stringify(payload)}', ${at(s + 1)});`;
const paused = {
  type: "unanswered",
  message: "Luke is paused: its model account needs topping up on our side. Nothing was changed.",
  failed: "billing",
};
const health = `(select public.abo_admin_luke_health())`;

const r = psql(`
begin;
create function pg_temp.try(t text) returns text language plpgsql as $f$
declare v text;
begin execute t into v; return coalesce(v, 'ok'); exception when others then return 'ERR ' || sqlerrm; end $f$;
create function pg_temp.as(uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;
create temp table out (k text, v text);
grant all on out to public;
create function pg_temp.say(k text, v text) returns void language sql as $f$ insert into out values (k, v) $f$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lh-admin-${tag}@warmluke.test'),
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lh-owner-${tag}@warmluke.test');
insert into public.account_settings (user_id, is_superadmin) values ('${ADMIN}', true)
  on conflict (user_id) do update set is_superadmin = true;
insert into public.projects (id, owner_id, name) values ('${P1}', '${OWNER}', 'lh one ${tag}'), ('${P2}', '${OWNER}', 'lh two ${tag}');
insert into public.conversations (id, project_id, title) values ('${C1}', '${P1}', 'one'), ('${C2}', '${P2}', 'two');

-- An answer, then three turns in two apps refused for an empty account,
-- and one that failed for our own reasons, which is not the model's.
${turn(C1, 60, { type: "answer", message: "Hi" })}
${turn(C1, 70, paused)}
${turn(C2, 80, paused)}
${turn(C2, 90, paused)}
${turn(C1, 100, { type: "unanswered", message: "Luke could not get this right, so nothing was changed. Ask again, in other words." })}

select pg_temp.as('${ADMIN}');
select pg_temp.say('failing', ${health} ->> 'failing');
select pg_temp.say('what', (${health} ->> 'kind') || '|' || (${health} ->> 'turns') || '|' || (${health} ->> 'projects'));
select pg_temp.say('since', ((${health} ->> 'since')::timestamptz = ${at(71)})::text);
select pg_temp.as('${OWNER}');
select pg_temp.say('owner', pg_temp.try('select public.abo_admin_luke_health()::text'));
reset role;

-- An answer comes through: Luke is answering again, and the console stops saying so.
${turn(C2, 110, { type: "plans", message: "Shipments will get an RTO mark." })}
select pg_temp.as('${ADMIN}');
select pg_temp.say('back', ${health} ->> 'failing');
reset role;

select k, v from out;
rollback;
`);

console.log("the console says when Luke is failing");
check("three turns refused for an empty account: failing", r.failing === "true");
check("what it was, how many turns, in how many apps", r.what === "billing|3|2");
check("since the first of them", r.since === "true");
check("only an administrator may ask", r.owner?.startsWith("ERR"));
check("an answer that comes through ends it", r.back === "false");

console.log(
  fails.length ? `\n${fails.length} FAILED` : "\nthe console says when Luke is failing, and stops once it answers"
);
process.exit(fails.length ? 1 : 0);
