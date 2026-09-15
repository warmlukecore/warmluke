// Who can read the key to the merchant's shop.
//
// RLS decides rows, never columns, so a seat on the project used to be
// enough: `select access_token from stores` answered. That token is
// the worst thing in the database to lose — it talks to Shopify as the
// merchant, from anywhere, and revoking a Supabase session does not
// touch it.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-token.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
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

const { data: store } = await admin
  .from("stores")
  .select("id, project_id, access_token")
  .limit(1)
  .maybeSingle();
if (!store) {
  console.log("no store connected — nothing to check");
  process.exit(0);
}
check("the token is really there to be taken", typeof store.access_token === "string");

// ── A staff member with a seat on the project ───────────────────
const stamp = Date.now();
const email = `tok_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
const { data: seat } = await admin
  .from("project_members")
  .insert({
    project_id: store.project_id,
    user_id: made.user.id,
    email,
    joined_at: new Date().toISOString(),
  })
  .select()
  .single();

const staff = createClient(URL_, ANON);
await staff.auth.signInWithPassword({ email, password });

try {
  console.log("\na staff member with a seat");
  const seen = await staff.from("stores").select("id, shop_domain").eq("id", store.id);
  check("still sees that a store is connected", seen.data?.length === 1);

  // The whole finding, asked the way an attacker asks it.
  const grab = await staff.from("stores").select("access_token").eq("id", store.id);
  check("cannot select the access token", !!grab.error || !grab.data?.[0]?.access_token);
  const both = await staff.from("stores").select("access_token, refresh_token").eq("id", store.id);
  check("nor the refresh token", !!both.error || !both.data?.[0]?.refresh_token);

  // select("*") is how it reached a browser in the first place.
  const everything = await staff.from("stores").select("*").eq("id", store.id);
  check(
    "and cannot sweep it up with a star",
    !!everything.error || !everything.data?.[0]?.access_token
  );

  // The function is the only way in, and it is not for them.
  const asked = await staff.rpc("abo_store_token", { p_store: store.id });
  check("the token function gives them nothing", !!asked.error || (asked.data ?? []).length === 0);
} finally {
  if (seat) await admin.from("project_members").delete().eq("id", seat.id);
  await admin.auth.admin.deleteUser(made.user.id);
  console.log("\nthe seat is given back");
}

// ── The owner, who runs the import ──────────────────────────────
const owner = createClient(URL_, ANON);
const { data: signedIn } = await owner.auth.signInWithPassword({
  email: "aaa@gmail.com",
  password: process.env.OWNER_PASSWORD ?? "",
});

if (!signedIn?.session) {
  console.log("\nno OWNER_PASSWORD given — the owner's side was not checked");
} else {
  console.log("\nthe owner");
  const star = await owner.from("stores").select("*").eq("id", store.id);
  check("cannot read the token as a column either", !!star.error || !star.data?.[0]?.access_token);

  // Because the import has to keep working.
  const { data: got, error } = await owner
    .rpc("abo_store_token", { p_store: store.id })
    .maybeSingle();
  check("but the import can still get it", !error && typeof got?.access_token === "string");
  check("with what it needs to renew it", got !== null && "refresh_token" in (got ?? {}));
}

console.log(fails.length === 0 ? "\nthe key stays with the lock" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
