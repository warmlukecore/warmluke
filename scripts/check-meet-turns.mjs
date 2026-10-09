// The first conversation's turns (0200): free for the owner while they have
// not met Luke, twenty at most an account, charged as usual otherwise; a
// refund gives back the count it took from; and met_luke_at, once set, is
// the server's alone to clear.
//
//   ENV_FILE=.env.check.local node scripts/check-meet-turns.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let failed = 0;
const check = (what, ok) => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) failed++;
};

const stamp = Date.now();
const email = `meet_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made, error: makeError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (!made.user) throw new Error(`could not create the test user: ${makeError?.message}`);
const userId = made.user.id;
const merchant = createClient(URL_, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error: signInError } = await merchant.auth.signInWithPassword({ email, password });
if (signInError) throw new Error(`could not sign in the test user: ${signInError.message}`);

let projectId = null;
try {
  const { data: project, error: projectError } = await admin
    .from("projects")
    .insert({ owner_id: userId, name: `meet-check ${stamp}` })
    .select("id")
    .single();
  if (projectError) throw new Error(`could not make the project: ${projectError.message}`);
  projectId = project.id;
  const { error: profileError } = await merchant.from("profiles").insert({
    user_id: userId,
    full_name: "Meet Check",
    business_name: "Meet Check Co",
    role: "founder",
    monthly_orders: "under_500",
    platform: "shopify",
    website: "meetcheck.example",
    onboarded_at: new Date().toISOString(),
  });
  if (profileError) throw new Error(`could not save the profile: ${profileError.message}`);

  const counts = async () =>
    (await admin.from("account_settings").select("turns_used, meet_turns").eq("user_id", userId).single()).data;
  const spend = async (meeting) =>
    (await merchant.rpc("abo_spend_turn", { p_project: projectId, ...(meeting ? { p_meeting: true } : {}) })).data;

  console.log("\nthe first conversation is free");
  const first = await spend(true);
  let c = await counts();
  check("a turn of it is spent as the meeting's", first?.ok === true && first?.meeting === true);
  check("and leaves the included turns untouched", c?.turns_used === 0 && c?.meet_turns === 1);
  const back = (await merchant.rpc("abo_refund_turn", { p_spend: first.spend_id })).data;
  c = await counts();
  check(
    "a refund gives back the meeting's count",
    back?.refunded === true && c?.meet_turns === 0 && c?.turns_used === 0
  );

  console.log("\nonly the meeting, only twenty");
  const plain = await spend(false);
  c = await counts();
  check(
    "a turn not asked as the meeting is charged as usual",
    plain?.ok === true && !plain?.meeting && c?.turns_used === 1
  );
  for (let i = 0; i < 20; i++) await spend(true);
  c = await counts();
  check("twenty are free", c?.meet_turns === 20 && c?.turns_used === 1);
  const past = await spend(true);
  c = await counts();
  check("the twenty-first is charged as usual", past?.ok === true && !past?.meeting && c?.turns_used === 2);

  console.log("\nonce they have met him");
  await admin.from("account_settings").update({ meet_turns: 0 }).eq("user_id", userId);
  await merchant.from("profiles").update({ met_luke_at: new Date().toISOString() }).eq("user_id", userId);
  const after = await spend(true);
  c = await counts();
  check(
    "a meeting turn after they are let in is charged as usual",
    after?.ok === true && !after?.meeting && c?.meet_turns === 0
  );
  await merchant.from("profiles").update({ met_luke_at: null }).eq("user_id", userId);
  const kept = (await admin.from("profiles").select("met_luke_at").eq("user_id", userId).single()).data;
  check("a browser cannot take back that they met him", !!kept?.met_luke_at);
  await admin.from("profiles").update({ met_luke_at: null }).eq("user_id", userId);
  const cleared = (await admin.from("profiles").select("met_luke_at").eq("user_id", userId).single()).data;
  check("the server can, to show it again", cleared?.met_luke_at === null);
} finally {
  if (projectId) await admin.from("projects").delete().eq("id", projectId);
  await admin.auth.admin.deleteUser(userId);
}

console.log(failed ? `\n${failed} failed` : "\nthe first conversation's turns are counted apart, and capped");
process.exit(failed ? 1 : 0);
