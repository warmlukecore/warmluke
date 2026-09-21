// The money that reached the bank.
//
// Said first, because it decides what this check is worth: the
// development store has NO Shopify Payments account, so no payout
// has ever been seen arriving. Every field name in the query was
// validated against the live schema and Shopify refuses an invented
// one, so the shape is real. What is checked here is the saver and
// the SQL, against the shapes the schema says can come. The first
// store with Shopify Payments is the real test.
//
// Two things matter more than the rest. A payout list that hangs off
// an account which may not exist has to read as "no payouts" and not
// as a crash — that is most shops in the world, not an edge case.
// And a WITHDRAWAL is money leaving, so anything that adds it to a
// DEPOSIT reports a bank balance nobody has.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-payouts.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { savePayouts } from "../src/lib/shopify-import.ts";
import { pageAt, SHOPIFY_RESOURCES } from "../src/lib/shopify-resources.ts";
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

// ── Finding the page, which needs no database ─────────────────
console.log("a list is found wherever its root says it is");
const page = { pageInfo: { hasNextPage: false, endCursor: "x" }, nodes: [{ id: "a" }] };
check("one step down, as every other resource is", pageAt({ orders: page }, "orders")?.nodes.length === 1);
check("two steps down, as payouts are", pageAt({ shopifyPaymentsAccount: { payouts: page } }, "shopifyPaymentsAccount.payouts")?.nodes.length === 1);
// The case that is most of the world: no Shopify Payments at all.
check("a null account reads as no page, not a crash", pageAt({ shopifyPaymentsAccount: null }, "shopifyPaymentsAccount.payouts") === null);
check("a missing account does too", pageAt({}, "shopifyPaymentsAccount.payouts") === null);
check("and so does nothing at all", pageAt(null, "shopifyPaymentsAccount.payouts") === null);
// Half a page is not a page.
check("a page with no nodes array is refused", pageAt({ orders: { pageInfo: {} } }, "orders") === null);
check("a page with no pageInfo is refused", pageAt({ orders: { nodes: [] } }, "orders") === null);
check("an empty page is still a page", pageAt({ orders: { pageInfo: {}, nodes: [] } }, "orders")?.nodes.length === 0);
check("the payouts resource points two steps down", SHOPIFY_RESOURCES.payouts.root === "shopifyPaymentsAccount.payouts");
// No topic exists, and saying so out loud stops somebody adding one
// that Shopify will refuse to subscribe.
check("and subscribes to no webhook, because none exists", SHOPIFY_RESOURCES.payouts.webhooks.length === 0);
check("and has no bulk road, because it is not a top-level list", SHOPIFY_RESOURCES.payouts.bulk === null);

const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(anon, env);
if (!me.session) {
  console.log(`no check user: ${me.why}`);
  process.exit(1);
}
const project = await throwawayProject(admin, me.user.id, "payouts");
const stamp = Date.now().toString(36);

try {
  const { data: store } = await admin
    .from("stores")
    .insert({ project_id: project.id, shop_domain: `pay-${stamp}.myshopify.com`, status: "connected" })
    .select("id").single();

  const money = (a) => ({ amount: a });
  await savePayouts(admin, store.id, [
    {
      id: `gid://shopify/ShopifyPaymentsPayout/${stamp}1`,
      status: "PAID", transactionType: "DEPOSIT", issuedAt: "2026-09-18T00:00:00Z",
      net: { amount: "4182.55", currencyCode: "USD" },
      summary: {
        chargesGross: money("4500.00"), chargesFee: money("130.50"),
        refundsFeeGross: money("200.00"), refundsFee: money("5.00"),
        adjustmentsGross: money("20.00"), adjustmentsFee: money("1.95"),
        reservedFundsGross: money("0.00"), reservedFundsFee: money("0.00"),
        retriedPayoutsGross: money("0.00"), retriedPayoutsFee: money("0.00"),
        advanceGross: money("0.00"), advanceFees: money("0.00"),
      },
    },
    // Money going the other way. The row that makes a naive sum lie.
    {
      id: `gid://shopify/ShopifyPaymentsPayout/${stamp}2`,
      status: "PAID", transactionType: "WITHDRAWAL", issuedAt: "2026-09-19T00:00:00Z",
      net: { amount: "300.00", currencyCode: "USD" },
      summary: { chargesGross: money("0.00"), chargesFee: money("0.00") },
    },
    // Not in the bank yet, and a summary Shopify did not fill in.
    {
      id: `gid://shopify/ShopifyPaymentsPayout/${stamp}3`,
      status: "SCHEDULED", transactionType: "DEPOSIT", issuedAt: "2026-09-22T00:00:00Z",
      net: { amount: "910.00", currencyCode: "USD" },
      summary: null,
    },
  ]);

  const rows = (await admin.from("payouts").select("*").eq("store_id", store.id).order("issued_at")).data ?? [];
  check("all three are written", rows.length === 3);
  const [deposit, withdrawal, scheduled] = rows;
  check("the net is what Shopify said moved", Number(deposit?.net) === 4182.55);
  check("with its currency", deposit?.currency === "USD");
  check("every component is kept, so the parts explain the whole", Number(deposit?.charges_gross) === 4500 && Number(deposit?.charges_fee) === 130.5 && Number(deposit?.refunds_gross) === 200 && Number(deposit?.adjustments_fee) === 1.95);
  check("a withdrawal is marked as one", withdrawal?.kind === "WITHDRAWAL");
  check("and a deposit as one", deposit?.kind === "DEPOSIT");
  check("a payout still on its way says so", scheduled?.status === "SCHEDULED");
  // Null, never zero: a summary Shopify did not send is unknown, and
  // zero would be a payout with no fees, which is a different claim.
  check("a missing summary leaves the parts unknown, not zero", scheduled?.charges_gross === null && scheduled?.charges_fee === null);

  console.log("\nand what a merchant reads");
  const view = (await admin.from("store_payouts").select("*").eq("store_id", store.id).order("issued_at")).data ?? [];
  check("in the bank, in their words", view[0]?.state === "In the bank");
  check("and on its way", view[2]?.state === "On its way");
  check("a deposit reads as paid out", view[0]?.kind === "Paid out");
  // The one that stops a wrong bank balance.
  check("and a withdrawal reads as taken back", view[1]?.kind === "Taken back");
  // 130.50 + 5.00 + 1.95, with the four zero categories.
  check("everything Shopify kept adds into one number", Number(view[0]?.fees) === 137.45);
  // Nothing sent means nothing kept, as far as anyone can say.
  check("a payout with no summary reports no fees", Number(view[2]?.fees) === 0);

  console.log("\nand a shop with no Shopify Payments holds nothing, quietly");
  const { data: other } = await admin
    .from("stores")
    .insert({ project_id: project.id, shop_domain: `nopay-${stamp}.myshopify.com`, status: "connected" })
    .select("id").single();
  await savePayouts(admin, other.id, []);
  const empty = (await admin.from("store_payouts").select("id").eq("store_id", other.id)).data ?? [];
  check("no rows, and no error", empty.length === 0);
} finally {
  await admin.from("projects").delete().eq("id", project.id);
  console.log("\nthe project is gone");
}

console.log(fails.length === 0 ? "\nwhat reached the bank, kept apart from what was charged" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
