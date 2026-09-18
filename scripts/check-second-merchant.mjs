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
const { data: project } = await admin.from("projects").select("id").limit(1).single();

const stamp = Date.now().toString(36);
const DOMAIN = `squat-${stamp}.myshopify.com`;
const SHADOWED = `shadowed-${stamp}.myshopify.com`;
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

  console.log("\nand a pending row cannot stand in front of a real store");
  // Pending rows are allowed to share a domain — that is what stops a
  // stranger holding somebody else's address for ever. But the webhook
  // handlers looked their store up by shop_domain alone, with no
  // provider and no status, so an install somebody merely STARTED for
  // a shop they do not own could be handed that shop's data.
  //
  // The squatter is created FIRST, before the row that goes on to
  // connect. The old query took whichever row it happened to find, so
  // a test that added the pending row afterwards could pass against
  // the very code it was written to catch.
  {
    const makePending = async (state, domain) => {
      const { data } = await admin
        .from("stores")
        .insert({
          project_id: project.id,
          provider: "shopify",
          shop_domain: domain,
          status: "pending",
          oauth_state: state,
          oauth_state_expires_at: new Date(Date.now() + 600000).toISOString(),
        })
        .select("id")
        .single();
      if (data) made.push(data.id);
      return data?.id;
    };

    const squatter = await makePending(`squat-first-${stamp}`, SHADOWED);
    check("a stranger gets in first with a pending row", !!squatter);

    const real = await makePending(`real-second-${stamp}`, SHADOWED);
    const connected = await admin.rpc("abo_shopify_connect", {
      p_state: `real-second-${stamp}`,
      p_shop: SHADOWED,
      p_token: `shpat_shadow_${stamp}`,
      p_timezone: "Asia/Kolkata",
      p_currency: "INR",
      p_country: "IN",
      p_refresh_token: null,
      p_expires_in: 3600,
      p_refresh_expires_in: null,
    });
    check("and the real owner connects afterwards", connected.data === project.id);

    const external = `gid://shopify/Product/shadow-${stamp}`;
    await admin.rpc("abo_shopify_upsert_product", {
      p_shop: SHADOWED,
      p_product: { id: external, title: "Landed", updated_at: new Date().toISOString() },
    });
    const landed = (
      await admin.from("products").select("store_id").eq("external_id", external).maybeSingle()
    ).data;
    check("the write lands on the connected store", landed?.store_id === real);
    check("and never on the pending one that got there first", landed?.store_id !== squatter);
    const { error: sweptProduct } = await admin
      .from("products")
      .delete()
      .eq("external_id", external);
    check("the product this check invented is removed", !sweptProduct);
  }

  // And a client of the app cannot read the token it just stored.
  const asUser = createClient(URL_, ANON);
  const peek = await asUser.from("stores").select("access_token").eq("id", mine.id);
  check("while the token stays unreadable", !!peek.error || !peek.data?.[0]?.access_token);
} finally {
  // Every delete is looked at. A cleanup that silently failed used to
  // leave rows behind and still report a clean table, because the
  // verification only asked about one of the two domains this check
  // invents — and `(null ?? 0) === 0` read a failed count as zero.
  let swept = true;
  for (const id of made) {
    const { error } = await admin.from("stores").delete().eq("id", id);
    if (error) {
      swept = false;
      console.log(`     ..    could not remove store ${id}: ${error.message}`);
    }
  }
  const left = await admin
    .from("stores")
    .select("id", { count: "exact", head: true })
    .in("shop_domain", [DOMAIN, SHADOWED]);
  check(
    "no store this check invented is left behind",
    swept && !left.error && left.count === 0
  );
}

console.log(
  fails.length === 0 ? "\na shop belongs to whoever proved it" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
