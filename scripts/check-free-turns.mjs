// What the free allowance counts, and what it must never count.
//
// The mistake this guards against is not arithmetic. It is counting
// the wrong thing: propose_change runs the same engine on the same
// key, so an allowance that watched only the chat box would cap
// nothing while a connected Claude designed all day on our money.
//
// And the other half — reading a store, approving a design already
// made — costs nothing and must stay free, or the pitch is a lie.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-free-turns.mjs

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
const APP = process.env.APP_URL ?? "http://localhost:3100";

const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// ── The counter itself, under a throwaway account ───────────────
const stamp = Date.now();
const email = `turns_${stamp}@example.com`;
const password = `pw_${stamp}_aA1!`;
const { data: made } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
const user = createClient(URL_, ANON);
await user.auth.signInWithPassword({ email, password });

try {
  console.log("the counter");
  await user.rpc("abo_my_settings"); // creates the row
  await admin.from("account_settings").update({ free_turns: 2 }).eq("user_id", made.user.id);

  const first = (await user.rpc("abo_spend_turn")).data;
  check("the first turn is allowed", first?.ok === true && first.used === 1);
  const second = (await user.rpc("abo_spend_turn")).data;
  check("and the second", second?.ok === true && second.used === 2);
  const third = (await user.rpc("abo_spend_turn")).data;
  check("the third is refused", third?.ok === false);
  check("and says what the allowance was", third?.free === 2);

  const afterRefusal = (
    await admin.from("account_settings").select("turns_used").eq("user_id", made.user.id).single()
  ).data;
  // A refusal that still counted would push the account further away
  // from the allowance every time it retried.
  check("a refusal spends nothing", afterRefusal.turns_used === 2);

  await user.rpc("abo_refund_turn");
  const back = (await user.rpc("abo_spend_turn")).data;
  check("a refund buys one back", back?.ok === true);

  console.log("\nand it cannot be gamed");
  const forged = await user
    .from("account_settings")
    .update({ turns_used: 0, free_turns: 999 })
    .eq("user_id", made.user.id)
    .select();
  const stillThere = (
    await admin
      .from("account_settings")
      .select("turns_used, free_turns")
      .eq("user_id", made.user.id)
      .single()
  ).data;
  check(
    "a merchant cannot reset their own count",
    !forged.data?.length && stillThere.turns_used === 2 && stillThere.free_turns === 2
  );
  check(
    "nor grant themselves more",
    !!(await user.rpc("abo_admin_set_turns", { p_user: made.user.id, p_turns: 500 })).error
  );
} finally {
  await admin.auth.admin.deleteUser(made.user.id);
  console.log("\ntest account removed");
}

// ── Both doors spend the same purse ─────────────────────────────
const owner = createClient(URL_, ANON);
const { data: signedIn } = await owner.auth.signInWithPassword({
  email: "aaa@gmail.com",
  password: process.env.OWNER_PASSWORD ?? "",
});

if (!signedIn?.session) {
  console.log("\nno OWNER_PASSWORD given — the two doors were not checked");
} else {
  const token = signedIn.session.access_token;
  const uid = signedIn.user.id;
  const was = (
    await admin.from("account_settings").select("free_turns, turns_used").eq("user_id", uid).single()
  ).data;

  const setAllowance = (free, used) =>
    admin
      .from("account_settings")
      .update({ free_turns: free, turns_used: used })
      .eq("user_id", uid);

  const tool = async (name, args) => {
    const res = await fetch(`${APP}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const j = await res.json();
    try {
      return JSON.parse(j.result.content[0].text);
    } catch {
      return j;
    }
  };

  try {
    console.log("\nwith nothing left");
    await setAllowance(1, 1);

    const { data: projects } = await admin.from("projects").select("id").limit(1);
    const chat = await fetch(`${APP}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: projects[0].id, message: "build me something" }),
    });
    check("the chat refuses", chat.status === 402);
    check("and says why", (await chat.json()).out_of_turns === true);

    // The one that would have been missed: designing through their
    // own Claude runs the same engine.
    const proposed = await tool("propose_change", { request: "Add a Suppliers section." });
    check("designing through their own AI refuses too", /free builds/i.test(proposed?.error ?? ""));

    // And the half that costs nothing stays open, or the whole pitch
    // — bring your own assistant — is untrue.
    const overview = await tool("store_overview", {});
    check("reading the store still works", !!overview?.shop_domain);
    const orders = await tool("search_orders", { limit: 3 });
    check("and searching it", typeof orders?.count === "number");
    const sections = await tool("read_section", {});
    check("and reading their own sections", Array.isArray(sections?.sections));

    const spent = (
      await admin.from("account_settings").select("turns_used").eq("user_id", uid).single()
    ).data;
    check("none of which spent anything", spent.turns_used === 1);
  } finally {
    await setAllowance(was.free_turns, was.turns_used);
    const after = (
      await admin
        .from("account_settings")
        .select("free_turns, turns_used")
        .eq("user_id", uid)
        .single()
    ).data;
    check(
      "the account is back as it was",
      after.free_turns === was.free_turns && after.turns_used === was.turns_used
    );
  }
}

console.log(
  fails.length === 0 ? "\nit charges for the engine and nothing else" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
