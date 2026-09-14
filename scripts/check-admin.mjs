// Who may see every account, and who may switch one.
//
// The admin screen reads through security definer functions rather
// than a service-role key, so the question worth asking is whether an
// ordinary merchant can reach past them — by calling the functions
// directly, or by writing the flag that grants them.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-admin.mjs

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

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const stamp = Date.now();
const email = `adm_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made } = await admin.auth.admin.createUser({ email, password, email_confirm: true });

const merchant = createClient(URL_, ANON);
await merchant.auth.signInWithPassword({ email, password });

try {
  console.log("an ordinary merchant");
  const mine = await merchant.rpc("abo_my_settings");
  check("can read their own settings", mine.data?.[0]?.chat_enabled === true);
  check("and their own AI is available too", mine.data?.[0]?.mcp_enabled === true);
  check("and is not an administrator", mine.data?.[0]?.is_superadmin === false);

  const list = await merchant.rpc("abo_admin_accounts");
  // Refused, not empty: an empty list reads as "no accounts yet" and
  // sends whoever is debugging in the wrong direction.
  check("cannot list accounts", !!list.error);
  check("and is told why, rather than shown nothing", list.error?.code === "42501");

  check(
    "cannot switch even their own assistant",
    !!(
      await merchant.rpc("abo_admin_set_feature", {
        p_user: made.user.id,
        p_feature: "chat",
        p_on: false,
      })
    ).error
  );

  // The flag is the whole gate. A merchant who can write this row can
  // grant themselves everything above.
  const promote = await merchant
    .from("account_settings")
    .update({ is_superadmin: true })
    .eq("user_id", made.user.id)
    .select();
  const stored = (
    await admin
      .from("account_settings")
      .select("is_superadmin")
      .eq("user_id", made.user.id)
      .single()
  ).data;
  check(
    "cannot make themselves an administrator",
    !promote.data?.length && stored.is_superadmin === false
  );

  check(
    "cannot insert a row claiming it either",
    !!(
      await merchant
        .from("account_settings")
        .insert({ user_id: made.user.id, is_superadmin: true })
    ).error
  );

  const others = await merchant.from("account_settings").select("user_id");
  check("sees only their own row", (others.data ?? []).every((r) => r.user_id === made.user.id));

  console.log("\nan administrator");
  const { data: su } = await admin
    .from("account_settings")
    .select("user_id")
    .eq("is_superadmin", true)
    .limit(1)
    .maybeSingle();
  const suUser = su ? (await admin.auth.admin.getUserById(su.user_id)).data.user : null;
  const owner = createClient(URL_, ANON);
  const { data: signed } = suUser
    ? await owner.auth.signInWithPassword({
        email: suUser.email,
        password: process.env.OWNER_PASSWORD ?? "",
      })
    : { data: null };

  if (!signed?.session) {
    console.log("  ..    no administrator signed in, those checks did not run");
  } else {
    const all = await owner.rpc("abo_admin_accounts");
    check("can list every account", (all.data ?? []).length > 1);
    check("the list carries emails", (all.data ?? []).every((r) => !!r.email));
    check("and counts their projects", (all.data ?? []).every((r) => typeof r.projects === "number"));

    const off = await owner.rpc("abo_admin_set_feature", {
      p_user: made.user.id,
      p_feature: "chat",
      p_on: false,
    });
    check("can switch Warmluke's assistant off", off.data === false);
    let seen = (await merchant.rpc("abo_my_settings")).data?.[0];
    check("and the merchant sees the change", seen?.chat_enabled === false);
    // The two switches are independent — this is the whole reason the
    // old single setting was split. Turning one off must not touch the
    // other, or an account loses both assistants at once.
    check("their own AI is untouched by it", seen?.mcp_enabled === true);

    await owner.rpc("abo_admin_set_feature", {
      p_user: made.user.id,
      p_feature: "mcp",
      p_on: false,
    });
    seen = (await merchant.rpc("abo_my_settings")).data?.[0];
    check("the other switch turns off on its own", seen?.mcp_enabled === false);
    check("without turning the first back on", seen?.chat_enabled === false);

    // A name outside the two is refused rather than stored: the app
    // would then branch on something it has never seen.
    check(
      "an unknown feature is refused",
      !!(
        await owner.rpc("abo_admin_set_feature", {
          p_user: made.user.id,
          p_feature: "chatgpt",
          p_on: true,
        })
      ).error
    );

    for (const f of ["chat", "mcp"]) {
      await owner.rpc("abo_admin_set_feature", { p_user: made.user.id, p_feature: f, p_on: true });
    }
  }
} finally {
  await admin.auth.admin.deleteUser(made.user.id);
  console.log("\ntest user removed");
}

console.log(fails.length === 0 ? "\nthe admin boundary holds" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
