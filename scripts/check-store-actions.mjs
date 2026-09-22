// A change to somebody's real shop, and everything standing in front of it.
//
// This is the first table whose rows are meant to leave the building.
// A build request that goes wrong makes a wrong section in an app
// nobody but its owner sees; one of these, once write scopes exist,
// tags an order or moves a stock count in a business. So the rules
// around it are worth more than the thing itself, and they are all
// in SQL rather than in a route somebody can forget to call.
//
// Four of them, and each has a way of quietly not being true:
//
//   the switch     — default off, and off means the propose is refused,
//                    not merely hidden in the interface;
//   the yes        — a client may ask, and may never answer. auto_build
//                    is a standing yes to building sections in Warmluke
//                    and must not reach out here;
//   once           — two approvals, a retry, a second tab: one run.
//                    Shopify has no idempotency key for these, so the
//                    claim is the only thing between a merchant and
//                    two refunds;
//   the record     — the status is worked out from what came back, not
//                    taken from whoever reports it.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-actions.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const me = await signInAsCheckUser(anon, env);
if (!me.session) {
  console.log(`no check user: ${me.why}`);
  process.exit(1);
}
const project = await throwawayProject(admin, me.user.id, "store-actions");
const stamp = Date.now().toString(36);

/** Turns the account switch on or off under us, the way an admin would. */
const feature = (on) =>
  admin.from("account_settings").update({ store_actions_enabled: on }).eq("user_id", me.user.id);

const propose = (store, action = "tag_orders", params = { tag: "rush" }, summary = "Tags one order rush") =>
  anon.rpc("abo_action_propose", {
    p_project: project.id,
    p_store: store,
    p_action: action,
    p_targets: ["gid://shopify/Order/1"],
    p_params: params,
    p_summary: summary,
  });

let wasOn = false;
try {
  const { data: before } = await admin
    .from("account_settings")
    .select("store_actions_enabled")
    .eq("user_id", me.user.id)
    .maybeSingle();
  wasOn = before?.store_actions_enabled === true;

  const { data: store } = await admin
    .from("stores")
    .insert({ project_id: project.id, shop_domain: `actions-${stamp}.myshopify.com`, status: "connected" })
    .select("id")
    .single();

  console.log("the switch is off until somebody turns it on");
  await feature(false);
  {
    const { data, error } = await propose(store.id);
    check("proposing is refused outright", !!error && !data);
    check("and says why in a sentence", /not turned on/i.test(error?.message ?? ""));
  }

  console.log("\nand with it on, a change can be asked for");
  await feature(true);
  let first;
  {
    const { data, error } = await propose(store.id);
    first = data;
    check("the id comes back", !error && !!data);
    if (error) console.log("     →", error.message);
  }
  {
    // A store belonging to another project. The project check alone
    // would let a caller name any store id they liked.
    //
    // Its own try/finally, and not because this block can throw.
    // For the few seconds it exists there are TWO connected stores
    // on this database, and half the live checks find their store
    // with maybeSingle() — which errors on two. A run that dies in
    // here leaves that behind and the next run reports eight
    // failures that have nothing to do with what it was testing.
    // That is not a guess: it happened, twice, before this comment.
    const { data: other } = await admin
      .from("projects")
      .insert({ name: `check actions elsewhere ${stamp}`, owner_id: me.user.id })
      .select("id")
      .single();
    try {
      const { data: strayStore } = await admin
        .from("stores")
        .insert({ project_id: other.id, shop_domain: `stray-${stamp}.myshopify.com`, status: "connected" })
        .select("id")
        .single();
      const { error } = await propose(strayStore.id);
      check("a store from another project is refused", !!error);
    } finally {
      await admin.from("projects").delete().eq("id", other.id);
    }
  }
  {
    const { error } = await anon.rpc("abo_action_propose", {
      p_project: project.id,
      p_store: store.id,
      p_action: "tag_orders",
      p_targets: [],
      p_params: {},
      p_summary: "   ",
    });
    check("and one nobody could read is refused", !!error);
  }

  console.log("\nthe merchant's yes, and only theirs");
  {
    const { data } = await anon.rpc("abo_action_approve", { p_action: first });
    check("the owner may approve", data?.approved === true);
    const { data: row } = await admin.from("store_actions").select("status, approved_by").eq("id", first).single();
    check("and the row says approved", row.status === "approved");
    check("with their name on it", row.approved_by === me.user.id);
  }
  {
    const { data } = await anon.rpc("abo_action_approve", { p_action: first });
    check("approving twice changes nothing", data?.approved === false);
  }

  console.log("\nand it runs once, whoever asks");
  {
    const { data: a } = await anon.rpc("abo_action_claim", { p_action: first });
    check("the first caller takes it", a?.claimed === true);
    check("and is handed what to do", a?.action === "tag_orders" && a?.params?.tag === "rush");
    const { data: b } = await anon.rpc("abo_action_claim", { p_action: first });
    check("the second is told it is taken", b?.claimed === false);
    check("and what state it is in", b?.status === "running");
  }

  console.log("\nand the record is written from what came back");
  {
    const { data } = await anon.rpc("abo_action_done", {
      p_action: first,
      p_outcome: { done: ["gid://shopify/Order/1"], errors: [] },
    });
    check("all of it through is done", data?.status === "done");
  }
  {
    const { data: id } = await propose(store.id);
    await anon.rpc("abo_action_approve", { p_action: id });
    await anon.rpc("abo_action_claim", { p_action: id });
    const { data } = await anon.rpc("abo_action_done", {
      p_action: id,
      p_outcome: { done: ["gid://shopify/Order/1"], errors: ["gid://shopify/Order/2: no such order"] },
    });
    check("some of it through is partly done", data?.status === "partly_done");
    const { data: row } = await admin.from("store_actions").select("outcome").eq("id", id).single();
    check("and what failed is kept", (row.outcome?.errors ?? []).length === 1);
  }
  {
    const { data: id } = await propose(store.id);
    await anon.rpc("abo_action_approve", { p_action: id });
    await anon.rpc("abo_action_claim", { p_action: id });
    // The caller says nothing about the status; the numbers decide.
    const { data } = await anon.rpc("abo_action_done", {
      p_action: id,
      p_outcome: { done: [], errors: ["the store refused every one"], status: "done" },
    });
    check("none of it through is failed, whatever the caller calls it", data?.status === "failed");
  }

  console.log("\nand a claim only follows a yes");
  {
    const { data: id } = await propose(store.id);
    const { data } = await anon.rpc("abo_action_claim", { p_action: id });
    check("an unapproved one cannot be claimed", data?.claimed === false);
    check("and says it is still waiting", data?.status === "pending");
    const { data: gone } = await anon.rpc("abo_action_dismiss", { p_action: id });
    check("turning it down works", gone === true);
    const { data: again } = await anon.rpc("abo_action_approve", { p_action: id });
    check("and a dismissed one cannot be approved afterwards", again?.approved === false);
  }
} finally {
  const { error: sweepError, count: swept } = await admin
    .from("projects")
    .delete({ count: "exact" })
    .eq("id", project.id);
  if (sweepError || swept !== 1) {
    console.log(`     → could not remove the project: ${sweepError?.message ?? `${swept} rows`}`);
  }
  // The switch is the account's, not this run's. Put it back exactly
  // as it was, or the next check inherits a permission nobody granted.
  await feature(wasOn);
  console.log("\nthe project is gone and the switch is back where it was");
}

console.log(fails.length === 0 ? "\nnothing reaches a shop without a yes, and never twice" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
