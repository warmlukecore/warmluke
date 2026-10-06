// The console sees one account (0184), on the check project: two real
// accounts, each with an app, a Luke turn that cost something, a
// conversation, a call from their own AI and an administrator's change.
// Asked for one account, each report counts that account alone; asked for
// one app, that app; asked for no one, both, as before. The access log
// narrows to one administrator, and says who has acted.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-console-scope.mjs
//
// Never with CI running: one check database.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log("not a check project: this makes accounts of its own, so it runs only there");
  process.exit(0);
}
const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, anon), env);
if (!me.session) {
  console.log(`could not sign in as the check user — ${me.why}`);
  process.exit(1);
}
const db = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${me.session.access_token}` } } });

const stamp = Date.now();
const made = async (label) => {
  const { data: u, error } = await admin.auth.admin.createUser({
    email: `scope-${label}-${stamp}@warmluke.test`,
    password: "Test-passw0rd!",
    email_confirm: true,
  });
  if (error) throw error;
  const { data: p } = await admin
    .from("projects")
    .insert({ owner_id: u.user.id, name: `Scope ${label}` })
    .select("id")
    .single();
  const { data: c } = await admin
    .from("conversations")
    .insert({ project_id: p.id, title: `Scope ${label} ${stamp}` })
    .select("id")
    .single();
  await admin
    .from("turn_traces")
    .insert({ project_id: p.id, conversation_id: c.id, usage: { usd: label === "a" ? 0.5 : 0.25 } });
  await admin.from("mcp_calls").insert({ user_id: u.user.id, tool: "read_section", client_id: "check-scope" });
  if (label === "b") await admin.from("merchant_notes").insert({ project_id: p.id, note: `Ships from Pune ${stamp}` });
  await admin.from("admin_account_audit").insert({
    actor_user_id: me.user.id,
    target_user_id: u.user.id,
    action: "set_turns",
    old_value: {},
    new_value: {},
  });
  return { user: u.user.id, project: p.id, conversation: c.id };
};

const a = await made("a");
const b = await made("b");
try {
  console.log("spend");
  const spend = async (args) => (await db.rpc("abo_admin_spend", { p_days: 1, ...args })).data?.total;
  const all = await spend({});
  const onlyA = await spend({ p_account: a.user });
  check("everyone counts both", all?.turns >= 2);
  check("one account counts that account alone", onlyA?.turns === 1 && Number(onlyA.usd) === 0.5);
  check("one app of it too", (await spend({ p_account: b.user, p_app: b.project }))?.turns === 1);
  check(
    "an app that is not theirs counts nothing",
    (await spend({ p_account: a.user, p_app: b.project }))?.turns === 0
  );

  console.log("\nconversations");
  const titles = async (args) =>
    ((await db.rpc("abo_admin_conversations", { p_days: 1, p_query: `${stamp}`, ...args })).data ?? []).map(
      (r) => r.title
    );
  check("everyone: both", (await titles({})).length === 2);
  check("one account: theirs alone", (await titles({ p_account: b.user })).join() === `Scope b ${stamp}`);

  console.log("\ntheir AI");
  const calls = async (args) => (await db.rpc("abo_admin_their_ai", { p_days: 1, ...args })).data?.all?.calls ?? 0;
  check("one account: their AI's calls alone", (await calls({ p_account: a.user })) === 1);

  console.log("\nthe access log");
  const log = async (args) => (await db.rpc("abo_admin_access_log", { p_days: 1, ...args })).data;
  const onA = await log({ p_account: a.user });
  check("on one account: what was done to it alone", onA?.rows?.length === 1 && onA.rows[0].target_id === a.user);
  const byMe = await log({ p_admin: me.user.id });
  check("by one administrator", byMe?.rows?.every((r) => r.actor_id === me.user.id) && byMe.rows.length >= 2);
  check(
    "and who has acted, for the filter",
    byMe?.admins?.some((x) => x.id === me.user.id)
  );

  console.log("\nthe agents");
  const memory = async (who) =>
    (await db.rpc("abo_admin_agents", { p_days: 1, p_account: who })).data?.agents?.find((g) => g.name === "memory")
      ?.outcomes?.["notes written"];
  check("memory counts one account's notes alone", (await memory(b.user)) === 1 && (await memory(a.user)) === 0);

  console.log("\nthe rest answer for one account");
  for (const fn of ["abo_admin_trouble", "abo_admin_agents", "abo_admin_learning", "abo_admin_routing"]) {
    const { error } = await db.rpc(fn, { p_days: 1, p_account: a.user });
    check(`${fn} takes an account`, !error);
  }
  const { error: tourErr } = await db.rpc("abo_admin_tour_report", { p_limit: 10, p_account: a.user });
  check("abo_admin_tour_report takes an account", !tourErr);
  const { error: stuckErr } = await db.rpc("abo_admin_what_stuck", { p_weeks: 4, p_account: a.user });
  check("abo_admin_what_stuck takes an account", !stuckErr);
  const { error: helper } = await db.rpc("abo_admin_scope", { p_account: a.user, p_app: null });
  check("the scope itself is not anyone's to call", !!helper);
} finally {
  await admin.from("admin_account_audit").delete().in("target_user_id", [a.user, b.user]);
  await admin.from("mcp_calls").delete().eq("client_id", "check-scope");
  await admin.from("projects").delete().in("id", [a.project, b.project]);
  for (const u of [a.user, b.user]) await admin.auth.admin.deleteUser(u);
}

console.log(
  fails.length === 0 ? "\nthe console sees one account when asked, and everyone when not" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
