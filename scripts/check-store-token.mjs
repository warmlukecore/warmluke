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
import { OWNER_EMAIL } from "./owner-session.mjs";

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
  email: OWNER_EMAIL,
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

// And the other half of the same rule: hiding columns one at a time
// means a column added later is hidden from everybody until somebody
// says otherwise. webhook_error was added, the strip began selecting
// it, and PostgREST refuses the WHOLE row over one ungranted column —
// so the app told the merchant "not connected" about a store that was
// connected, synced and holding a valid token. Nothing failed loudly;
// the store simply stopped existing on screen.
if (signedIn?.session) {
  console.log("\nand what the merchant is meant to see, they can see");
  // StoreStrip's query, not an approximation of it: the same columns,
  // filtered the same way. A version that only resembles it can pass
  // while the real one still fails on a column nobody granted.
  const project = (
    await admin.from("stores").select("project_id").eq("status", "connected").limit(1).maybeSingle()
  ).data;
  const shown = await owner
    .from("stores")
    .select("id, shop_domain, status, webhook_error")
    .eq("project_id", project?.project_id ?? "00000000-0000-0000-0000-000000000000");
  check("the strip's own query is answered", !shown.error);
  check("and it comes back with a store", (shown.data ?? []).length > 0);

  // The currency has to reach the browser, or money from the shop gets
  // formatted in the project's currency instead — a dollar amount
  // printed with a rupee sign, which looks entirely correct. The app
  // reads this column to decide; ungranted, `store` is null and it
  // silently falls back to the wrong one. That is exactly how
  // webhook_error broke, and it broke in silence.
  const money = await owner.from("stores").select("id, currency").limit(1);
  check("the shop's own currency is readable", !money.error);
  check(
    "and it is a real currency code",
    /^[A-Z]{3}$/.test((money.data ?? [])[0]?.currency ?? "")
  );

  // The same trap again, one column later. granted_scopes is what
  // answers "did that reconnect actually take?", and ungranted it
  // would not merely be absent — PostgREST refuses the whole row over
  // one column nobody granted, so a screen asking for it shows no
  // store at all. That is the webhook_error failure exactly.
  const scopes = await owner.from("stores").select("id, granted_scopes").limit(1);
  check("what the grant gave is readable", !scopes.error);
  // Null is allowed and means unknown: a store connected before the
  // column existed has not been renewed yet. A list, when there is
  // one, is a list of scope names.
  const gave = (scopes.data ?? [])[0]?.granted_scopes ?? null;
  check(
    "and it is either unknown or a list of scopes",
    gave === null || (Array.isArray(gave) && gave.every((s) => typeof s === "string" && s.length > 0))
  );
} else {
  console.log("\n  --    no owner session; the strip's query is not checked");
}

console.log(fails.length === 0 ? "\nthe key stays with the lock" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
