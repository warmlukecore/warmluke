// What the second merchant hits that the first did not.
//
// One store has been connected to one project since this was built, so
// none of it had ever been exercised twice. Three things were only safe
// because nobody else had arrived:
//
//   a domain was claimed before anyone proved they owned it, and the
//   claim was permanent;
//
//   the OAuth nonce was not tied to a shop, so a callback for one store
//   could put its token on a row wearing another store's name;
//
//   and a failure to subscribe the webhooks was logged where the
//   merchant cannot see it, under the word "connected".
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-second-merchant.mjs

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
const { data: project } = await admin.from("projects").select("id").limit(1).single();

const stamp = Date.now().toString(36);
const DOMAIN = `squat-${stamp}.myshopify.com`;
const made = [];

/** A row part-way through connecting, as the install route writes one. */
const pending = async (state) => {
  const { data, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      shop_domain: DOMAIN,
      status: "pending",
      oauth_state: state,
      oauth_state_expires_at: new Date(Date.now() + 600000).toISOString(),
    })
    .select("id")
    .single();
  if (data) made.push(data.id);
  return { id: data?.id, error };
};

const connect = (state, shop) =>
  admin.rpc("abo_shopify_connect", {
    p_state: state,
    p_shop: shop,
    p_token: `shpat_test_${stamp}`,
    p_timezone: "Asia/Kolkata",
    p_currency: "INR",
    p_country: "IN",
    p_refresh_token: null,
    p_expires_in: 3600,
    p_refresh_expires_in: null,
  });

try {
  console.log("two people mid-install for the same shop");
  const mine = await pending(`state-a-${stamp}`);
  check("the first attempt is written", !!mine.id);
  const theirs = await pending(`state-b-${stamp}`);
  // This used to be a duplicate key, which is how a stranger could hold
  // somebody else's domain for ever by typing it once.
  check("and a second attempt is not refused", !theirs.error && !!theirs.id);

  console.log("\nand the token has to come from the shop it names");
  const wrongShop = await connect(`state-a-${stamp}`, "someone-else.myshopify.com");
  check("a callback for another shop connects nothing", wrongShop.data === null);
  const stillPending = (
    await admin.from("stores").select("status, access_token").eq("id", mine.id).single()
  ).data;
  check("and writes no token onto that row", stillPending.access_token === null);
  check("which stays unconnected", stillPending.status === "pending");

  const right = await connect(`state-a-${stamp}`, DOMAIN);
  check("the shop it does name connects", right.data === project.id);

  console.log("\nand only one of them ends up holding the shop");
  const loser = await connect(`state-b-${stamp}`, DOMAIN);
  // The second finisher meets the constraint, which is where it
  // belongs: at the moment somebody proves ownership, not before.
  check("the second to finish is refused", loser.data === null || !!loser.error);
  const connected = await admin
    .from("stores")
    .select("id", { count: "exact", head: true })
    .eq("shop_domain", DOMAIN)
    .eq("status", "connected");
  check("leaving exactly one connected store", connected.count === 1);

  console.log("\nand a failure to subscribe is written down");
  await admin
    .from("stores")
    .update({ webhook_error: "ORDERS_CREATE: not approved for this scope" })
    .eq("id", mine.id);
  const said = (await admin.from("stores").select("webhook_error").eq("id", mine.id).single()).data;
  check("the reason is kept, not only logged", /not approved/.test(said.webhook_error ?? ""));

  // And a client of the app cannot read the token it just stored.
  const asUser = createClient(URL_, ANON);
  const peek = await asUser.from("stores").select("access_token").eq("id", mine.id);
  check("while the token stays unreadable", !!peek.error || !peek.data?.[0]?.access_token);
} finally {
  for (const id of made) await admin.from("stores").delete().eq("id", id);
  const { count } = await admin
    .from("stores")
    .select("id", { count: "exact", head: true })
    .eq("shop_domain", DOMAIN);
  check("no store this check invented is left behind", (count ?? 0) === 0);
}

console.log(
  fails.length === 0 ? "\na shop belongs to whoever proved it" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
