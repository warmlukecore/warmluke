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

  const refund = (await user.rpc("abo_refund_turn")).data;
  check("a refund buys one back", refund?.refunded === true);
  const back = (await user.rpc("abo_spend_turn")).data;
  check("and the turn can be taken again", back?.ok === true);

  console.log("\nand the refund is not free money");
  // It takes no arguments and every signed-in role may call it, so
  // PostgREST is one curl away. What stops a loop is that a refund
  // has to answer for a spend.
  await admin.from("account_settings").update({ free_turns: 3 }).eq("user_id", made.user.id);
  const before = (
    await admin.from("account_settings").select("turns_used").eq("user_id", made.user.id).single()
  ).data.turns_used;
  const many = await Promise.all(
    Array.from({ length: 10 }, () => user.rpc("abo_refund_turn").then((r) => r.data))
  );
  const granted = many.filter((r) => r?.refunded).length;
  check("ten calls in a row refund at most one", granted <= 1);
  const afterLoop = (
    await admin.from("account_settings").select("turns_used").eq("user_id", made.user.id).single()
  ).data.turns_used;
  check("and the count did not fall away", afterLoop >= before - 1);

  // A refund with nothing recent behind it buys nothing at all.
  await admin
    .from("account_settings")
    .update({ last_spend_at: new Date(Date.now() - 3600e3).toISOString(), last_refund_at: null })
    .eq("user_id", made.user.id);
  const stale = (await user.rpc("abo_refund_turn")).data;
  check("an old spend cannot be refunded", stale?.refunded === false);

  console.log("\nand two at once cannot both slip through");
  // Read-then-write left a gap: both requests saw one left.
  await admin
    .from("account_settings")
    .update({ free_turns: 5, turns_used: 4 })
    .eq("user_id", made.user.id);
  const race = await Promise.all(
    Array.from({ length: 6 }, () => user.rpc("abo_spend_turn").then((r) => r.data))
  );
  check("only the last one is allowed", race.filter((r) => r?.ok).length === 1);
  const final = (
    await admin.from("account_settings").select("turns_used").eq("user_id", made.user.id).single()
  ).data.turns_used;
  check("and the allowance is not overspent", final === 5);

  console.log("\nand it cannot be gamed");
  const nowAt = (
    await admin
      .from("account_settings")
      .select("turns_used, free_turns")
      .eq("user_id", made.user.id)
      .single()
  ).data;
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
    !forged.data?.length &&
      stillThere.turns_used === nowAt.turns_used &&
      stillThere.free_turns === nowAt.free_turns
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

// ── A staff member spends nobody's allowance ────────────────────
// They can open the app they were invited to — that is the point of a
// seat. Building is not part of it: their own ten turns would pay for
// a turn on somebody else's app, which is ten more builds per person
// invited, and the reply could not be saved afterwards anyway.
{
  const { data: project } = await admin.from("projects").select("id").limit(1).single();
  const st = Date.now();
  const mail = `member_${st}@example.com`;
  const pw = `pw_${st}_aA1!`;
  const { data: staff } = await admin.auth.admin.createUser({
    email: mail,
    password: pw,
    email_confirm: true,
  });
  const { data: seat } = await admin
    .from("project_members")
    .insert({ project_id: project.id, user_id: staff.user.id, email: mail, joined_at: new Date().toISOString() })
    .select()
    .single();

  const staffClient = createClient(URL_, ANON);
  const { data: session } = await staffClient.auth.signInWithPassword({ email: mail, password: pw });

  try {
    console.log("\nand a staff member cannot build");
    const seen = await staffClient.from("projects").select("id").eq("id", project.id);
    check("they can still open the app", seen.data?.length === 1);

    const res = await fetch(`${APP}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.session.access_token}`,
      },
      body: JSON.stringify({ projectId: project.id, message: "build me something" }),
    });
    check("but the assistant refuses them", res.status === 403);

    const theirs = (
      await admin
        .from("account_settings")
        .select("turns_used")
        .eq("user_id", staff.user.id)
        .maybeSingle()
    ).data;
    check("and it cost them nothing", (theirs?.turns_used ?? 0) === 0);
  } finally {
    if (seat) await admin.from("project_members").delete().eq("id", seat.id);
    await admin.auth.admin.deleteUser(staff.user.id);
    console.log("the seat is given back");
  }
}

console.log(
  fails.length === 0 ? "\nit charges for the engine and nothing else" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
