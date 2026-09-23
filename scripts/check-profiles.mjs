// What a person told us in onboarding, against the real database.
//
// check-onboarding reads the migration; this runs it. Two accounts, and
// the questions worth asking of a table holding who they are: can one
// read or write the other's row, can a browser backdate or undo
// finishing, will the table take a value the form never offers, and
// does the accounts screen see the answers.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-profiles.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const stamp = Date.now();
const made = [];
async function person(tag) {
  const email = `onb_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_aA1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (!data.user) throw new Error(`could not create ${tag}: ${error?.message}`);
  made.push(data.user.id);
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`could not sign in ${tag}: ${e.message}`);
  return { id: data.user.id, email, client };
}

const answers = {
  full_name: "Asha Rao",
  business_name: "Rao Ceramics",
  role: "founder",
  monthly_orders: "500_2000",
  platform: "shopify",
  heard_from: "referral",
  heard_from_detail: "Meera",
};

try {
  const a = await person("a");
  const b = await person("b");

  console.log("a person's own row");
  const saved = await a.client.from("profiles").insert({ user_id: a.id, ...answers });
  check("they can save their answers", !saved.error);
  const mine = await a.client.from("profiles").select("*").eq("user_id", a.id).maybeSingle();
  check("and read them back", mine.data?.business_name === "Rao Ceramics");
  check("unfinished until they finish", mine.data?.onboarded_at === null);
  const again = await a.client.from("profiles").insert({ user_id: a.id, ...answers });
  check("there is never a second row", !!again.error);

  console.log("\nand nobody else's");
  const forB = await a.client.from("profiles").insert({ user_id: b.id, ...answers });
  check("cannot save answers as somebody else", !!forB.error);
  const peek = await b.client.from("profiles").select("*").eq("user_id", a.id);
  check("cannot read another account's answers", (peek.data ?? []).length === 0);
  await b.client.from("profiles").update({ business_name: "Taken" }).eq("user_id", a.id);
  const after = await a.client.from("profiles").select("business_name").eq("user_id", a.id).single();
  check("cannot change them either", after.data?.business_name === "Rao Ceramics");
  const anon = await createClient(URL_, ANON).from("profiles").select("*");
  check("and signed out, nothing at all", (anon.data ?? []).length === 0);

  console.log("\nonly what the form offers");
  const odd = await b.client.from("profiles").insert({ user_id: b.id, ...answers, role: "ceo" });
  check("a role the form does not offer is refused", !!odd.error);
  const empty = await b.client.from("profiles").insert({ user_id: b.id, ...answers, full_name: "   " });
  check("a name of only spaces is refused", !!empty.error);

  console.log("\nfinishing is the database's to stamp");
  const before = Date.now();
  await a.client.from("profiles").update({ onboarded_at: "2001-01-01T00:00:00Z" }).eq("user_id", a.id);
  const done = await a.client.from("profiles").select("onboarded_at").eq("user_id", a.id).single();
  const t = Date.parse(done.data?.onboarded_at ?? "");
  check("a backdated finish is stamped as now instead", Math.abs(t - before) < 5 * 60e3);
  await a.client.from("profiles").update({ onboarded_at: null }).eq("user_id", a.id);
  const kept = await a.client.from("profiles").select("onboarded_at").eq("user_id", a.id).single();
  check("and cannot be taken back", kept.data?.onboarded_at === done.data?.onboarded_at);
  await a.client.from("profiles").update({ team_size: "2_5" }).eq("user_id", a.id);
  const edited = await a.client.from("profiles").select("onboarded_at, team_size").eq("user_id", a.id).single();
  check(
    "editing an answer later does not un-finish anybody",
    edited.data?.onboarded_at === done.data?.onboarded_at && edited.data?.team_size === "2_5"
  );
  await a.client.from("profiles").delete().eq("user_id", a.id);
  const still = await a.client.from("profiles").select("user_id").eq("user_id", a.id);
  check("a person cannot delete the row, it goes with the account", (still.data ?? []).length === 1);

  console.log("\nthe accounts screen");
  const refused = await b.client.rpc("abo_admin_accounts");
  check("is still refused to a merchant", refused.error?.code === "42501");
  // A made an administrator for the one call; the account is deleted after.
  await admin.from("account_settings").upsert({ user_id: a.id, is_superadmin: true }, { onConflict: "user_id" });
  const all = await a.client.rpc("abo_admin_accounts");
  const row = (all.data ?? []).find((r) => r.user_id === a.id);
  check(
    "sees what they told us",
    row?.business_name === "Rao Ceramics" && row?.heard_from === "referral" && row?.heard_from_detail === "Meera"
  );
  check("and whether they finished", !!row?.onboarded_at);
  const other = (all.data ?? []).find((r) => r.user_id === b.id);
  check("an account that has not answered comes back empty, not missing", !!other && other.full_name === null);
  check("with when each was last here", "last_sign_in_at" in (row ?? {}));
} finally {
  for (const id of made) await admin.auth.admin.deleteUser(id);
  const left = await admin.from("profiles").select("user_id").in("user_id", made);
  check("the rows go with the accounts", (left.data ?? []).length === 0);
}

console.log(fails.length === 0 ? "\neach person's answers are theirs" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
