// Who may see every account, and who may switch one.
//
// The admin screen reads through security definer functions rather
// than a service-role key, so the question worth asking is whether an
// ordinary merchant can reach past them — by calling the functions
// directly, or by writing the flag that grants them.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-admin.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsOwner } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
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

console.log("the spend controls ask before they write");
{
  const page = readFileSync(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8");
  check("an allowance is not saved on blur", !/onBlur=/.test(page));
  check(
    "a changed number needs an explicit save and confirmation",
    />\s*Save\s*</.test(page) && /Set this account’s total allowance/.test(page)
  );
  check(
    "resetting the lifetime counter names the consequence before it runs",
    /Reset used/.test(page) && /This starts a fresh allowance/.test(page)
  );
}

const stamp = Date.now();
const email = `adm_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made, error: makeError } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (!made.user) {
  throw new Error(`could not create the admin-boundary test user: ${makeError?.message}`);
}

const merchant = createClient(URL_, ANON);
const { error: signInError } = await merchant.auth.signInWithPassword({ email, password });
if (signInError) throw new Error(`could not sign in the admin-boundary test user: ${signInError.message}`);

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

  check(
    "cannot grant themselves more designs",
    !!(
      await merchant.rpc("abo_admin_set_turns", {
        p_user: made.user.id,
        p_turns: 50,
      })
    ).error
  );
  check(
    "cannot make their designs unlimited",
    !!(
      await merchant.rpc("abo_admin_set_unlimited", {
        p_user: made.user.id,
        p_on: true,
      })
    ).error
  );
  check(
    "cannot reset their used counter",
    !!(
      await merchant.rpc("abo_admin_reset_turns", {
        p_user: made.user.id,
      })
    ).error
  );

  const auditRead = await merchant
    .from("admin_account_audit")
    .select("actor_user_id")
    .limit(1);
  check("cannot read the admin audit trail", !!auditRead.error && !auditRead.data?.length);

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
  const signed = suUser
    ? await signInAsOwner(owner, env, suUser.email)
    : { session: null, why: "no superadmin account exists" };

  if (!signed.session) {
    check(`can sign in as an administrator (${signed.why})`, false);
  } else {
    const all = await owner.rpc("abo_admin_accounts");
    check("can list every account", (all.data ?? []).length > 1);
    check("the list carries emails", (all.data ?? []).every((r) => !!r.email));
    check("and counts their projects", (all.data ?? []).every((r) => typeof r.projects === "number"));
    check(
      "and says whether each allowance is unlimited",
      (all.data ?? []).every((r) => typeof r.turns_unlimited === "boolean")
    );

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
    check(
      "a missing feature name is refused too",
      !!(
        await owner.rpc("abo_admin_set_feature", {
          p_user: made.user.id,
          p_feature: null,
          p_on: true,
        })
      ).error
    );

    for (const f of ["chat", "mcp"]) {
      await owner.rpc("abo_admin_set_feature", { p_user: made.user.id, p_feature: f, p_on: true });
    }

    console.log("\nthe included-design controls");
    const fortySix = await owner.rpc("abo_admin_set_turns", {
      p_user: made.user.id,
      p_turns: 46,
    });
    check("accept an ordinary allowance such as 46", fortySix.data === 46);
    const fifty = await owner.rpc("abo_admin_set_turns", {
      p_user: made.user.id,
      p_turns: 50,
    });
    check("and another such as 50", fifty.data === 50);

    await owner.rpc("abo_admin_set_turns", { p_user: made.user.id, p_turns: 0 });
    const unlimited = await owner.rpc("abo_admin_set_unlimited", {
      p_user: made.user.id,
      p_on: true,
    });
    check("can explicitly lift the limit", unlimited.data === true);
    const spends = await Promise.all(
      Array.from({ length: 3 }, () => merchant.rpc("abo_spend_turn").then((r) => r.data))
    );
    check(
      "and an unlimited account can spend beyond its retained zero ceiling",
      spends.every((spend) => spend?.ok === true)
    );

    const reset = await owner.rpc("abo_admin_reset_turns", { p_user: made.user.id });
    check("can deliberately reset the lifetime counter", reset.data === 0);
    const allowance = (await merchant.rpc("abo_my_settings")).data?.[0];
    check("and the account sees zero used", allowance?.turns_used === 0);

    const finite = await owner.rpc("abo_admin_set_unlimited", {
      p_user: made.user.id,
      p_on: false,
    });
    check("can restore the finite limit", finite.data === false);
    const refused = (await merchant.rpc("abo_spend_turn")).data;
    check("and the retained zero ceiling applies again", refused?.ok === false);

    const { data: audit } = await admin
      .from("admin_account_audit")
      .select("actor_user_id, target_user_id, action, old_value, new_value")
      .eq("target_user_id", made.user.id);
    const actions = new Set((audit ?? []).map((entry) => entry.action));
    check(
      "every kind of admin change has an audit entry",
      ["set_feature", "set_turns", "set_unlimited", "reset_turns"].every((action) =>
        actions.has(action)
      )
    );
    check(
      "the trail names the administrator and target",
      (audit ?? []).every(
        (entry) =>
          entry.actor_user_id === signed.user.id && entry.target_user_id === made.user.id
      )
    );
    check(
      "the trail keeps before and after values",
      (audit ?? []).every((entry) => entry.old_value && entry.new_value)
    );
  }
} finally {
  await admin.from("admin_account_audit").delete().eq("target_user_id", made.user.id);
  await admin.auth.admin.deleteUser(made.user.id);
  console.log("\ntest user removed");
}

console.log(fails.length === 0 ? "\nthe admin boundary holds" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
