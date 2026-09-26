// Which models an account's Luke may use, and what each reply shows it,
// are the administrator's to set and nobody else's (0127).
//
// A merchant can neither call the setter nor write the columns, the
// setter refuses what it does not understand, each change is on the
// account's trail, and the panel is told exactly what was set. Whether
// a model off the list can be forced by naming it is the chat route's
// question, answered in check-model-prices by the rule it calls.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-luke-access.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser } from "./owner-session.mjs";

const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log(`${envFile} does not declare CHECK_PROJECT=1, and this writes; nothing checked`);
  process.exit(0);
}
const APP = process.env.APP_URL ?? "http://localhost:3100";
const BASE = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const admin = createClient(BASE, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const us = createClient(BASE, ANON);
const me = await signInAsCheckUser(us, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);

const stamp = Date.now();
const email = `luke_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (!made.user) throw new Error("could not make the merchant");
const merchant = createClient(BASE, ANON);
const { data: signedIn } = await merchant.auth.signInWithPassword({ email, password });
const models = async (token) => {
  const r = await fetch(`${APP}/api/models`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  console.log("a merchant, before anyone set anything");
  const first = await models(signedIn.session.access_token);
  check("is told every model on offer, and sees the cost", first.status === 200 && first.body.shows === "cost");
  check(
    "with a default among them",
    first.body.models?.some((m) => m.id === first.body.default)
  );
  check("and is not given the administrator's list", first.body.offered === undefined);

  console.log("\nthe merchant, reaching past the setter");
  const { error: refused } = await merchant.rpc("abo_admin_set_luke", {
    p_user: made.user.id,
    p_models: null,
    p_shows: "cost",
  });
  check("cannot call it", /Not an administrator/.test(refused?.message ?? ""));
  const { error: readRefused } = await merchant.rpc("abo_admin_luke", { p_user: made.user.id });
  check("nor read another's", /Not an administrator/.test(readRefused?.message ?? ""));
  await merchant.from("account_settings").update({ luke_shows: "nothing" }).eq("user_id", made.user.id);
  const { data: held } = await admin
    .from("account_settings")
    .select("luke_shows")
    .eq("user_id", made.user.id)
    .maybeSingle();
  check("nor write the columns", (held?.luke_shows ?? "cost") === "cost");

  console.log("\nthe administrator");
  const set = (p_models, p_shows) => us.rpc("abo_admin_set_luke", { p_user: made.user.id, p_models, p_shows });
  check("refuses a word it does not know", /Unknown choice/.test((await set(null, "everything")).error?.message ?? ""));
  check("and a list with nothing on it", /one to fifty/.test((await set([], "cost")).error?.message ?? ""));
  check(
    "and a name that is not one",
    /one to fifty/.test((await set(["claude haiku; drop"], "cost")).error?.message ?? "")
  );
  const { error: setError } = await set(["claude-haiku-4-5"], "model");
  check("sets a list and what is shown", !setError);
  const { data: back } = await us.rpc("abo_admin_luke", { p_user: made.user.id });
  check("and reads back what it set", back?.shows === "model" && back?.models?.join() === "claude-haiku-4-5");
  const { data: trail } = await admin
    .from("admin_account_audit")
    .select("action, old_value, new_value")
    .eq("target_user_id", made.user.id)
    .eq("action", "set_luke");
  check(
    "which is on the account's trail, before and after",
    trail?.length === 1 && trail[0].old_value?.shows === "cost" && trail[0].new_value?.shows === "model"
  );
  await set(["claude-haiku-4-5"], "model");
  const { data: again } = await admin
    .from("admin_account_audit")
    .select("id")
    .eq("target_user_id", made.user.id)
    .eq("action", "set_luke");
  check("and setting it the same again writes nothing new", again?.length === 1);

  console.log("\nthe merchant, after");
  const after = await models(signedIn.session.access_token);
  check("is offered only what was allowed", after.body.models?.map((m) => m.id).join() === "claude-haiku-4-5");
  check("with it as the default", after.body.default === "claude-haiku-4-5");
  check("and sees only the model", after.body.shows === "model");

  console.log("\nthe administrator's own list");
  const mine = await models(me.session.access_token);
  check(
    "holds every model on offer",
    Array.isArray(mine.body.offered) && mine.body.offered.length >= mine.body.models.length
  );
} finally {
  await admin.auth.admin.deleteUser(made.user.id);
}

console.log(fails.length === 0 ? "\nwhat Luke may use is the administrator's to say" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
