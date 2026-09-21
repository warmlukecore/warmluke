// One order, two roads in, one number.
//
// The import wrote GraphQL's totalPriceSet — what an order came to when
// placed — to orders.total. The webhook wrote REST's current_total_price
// — what it comes to today, after refunds — to the same column. A
// refunded order therefore carried a different total depending on
// which road it last took, and a revenue stat never matched a payout.
//
// This puts the same refunded order in by both roads and asks for the
// same answer from each, with the original kept beside it. Then it
// asks what a designer is told, so "revenue" stops meaning every row.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-order-totals.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { saveOrders } from "../src/lib/shopify-import.ts";
import { STORE_TABLES } from "../src/lib/store-read.ts";

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
const project = await throwawayProject(admin, me.user.id, "order-totals");
const stamp = Date.now().toString(36);
const shop = `totals-${stamp}.myshopify.com`;
const { data: store } = await admin
  .from("stores")
  .insert({ project_id: project.id, shop_domain: shop, status: "connected" })
  .select("id")
  .single();

const row = async (ext) =>
  (await admin.from("orders").select("total, total_original").eq("store_id", store.id).eq("external_id", ext).single()).data;
const money = (amount) => ({ shopMoney: { amount, currencyCode: "USD" } });

try {
  console.log("a refunded order, by the import road");
  // Placed at 597, 50 refunded since: Shopify says 547 today.
  await saveOrders(admin, store.id, [
    {
      id: `gid://shopify/Order/${stamp}1`, name: "#9001",
      createdAt: "2026-09-14T10:00:00Z", updatedAt: "2026-09-15T10:00:00Z", cancelledAt: null, tags: [],
      displayFinancialStatus: "PARTIALLY_REFUNDED", displayFulfillmentStatus: "FULFILLED",
      totalPriceSet: money("597.00"), currentTotalPriceSet: money("547.00"),
      customer: null, lineItems: { nodes: [] }, refunds: [],
    },
  ]);
  const imported = await row(`gid://shopify/Order/${stamp}1`);
  check("total is what it comes to today", Number(imported?.total) === 547);
  check("and the original is kept beside it", Number(imported?.total_original) === 597);

  console.log("\nthe same order, by the webhook road");
  // The webhook function is called as the app calls it, with REST's
  // shape. Both roads must land on the same numbers.
  const { error } = await admin.rpc("abo_shopify_upsert_order", {
    p_shop: shop,
    p_order: {
      id: Number(`${stamp}1`.replace(/\D/g, "").slice(-9) || 1),
      admin_graphql_api_id: `gid://shopify/Order/${stamp}1`,
      name: "#9001", created_at: "2026-09-14T10:00:00Z", updated_at: "2026-09-15T12:00:00Z",
      financial_status: "partially_refunded", fulfillment_status: "fulfilled",
      total_price: "597.00", current_total_price: "547.00", currency: "USD", tags: "",
      line_items: [{ id: 1, title: "A thing", variant_title: "Blue", sku: "X", quantity: 2, price: "298.50" }],
      // A refund raises orders/updated, and the payload carries every
      // refund the order has — this road used to write none of them.
      refunds: [
        {
          id: 77, created_at: "2026-09-15T11:00:00Z",
          transactions: [{ kind: "refund", status: "success", amount: "50.00" }],
          refund_line_items: [{ quantity: 1, subtotal: "50.00" }],
        },
      ],
    },
  });
  check("the webhook is accepted", !error);
  if (error) console.log("     →", error.message);
  const hooked = await row(`gid://shopify/Order/${stamp}1`);
  check("and lands on the same total", Number(hooked?.total) === 547);
  check("and the same original", Number(hooked?.total_original) === 597);
  const { data: hookedLines } = await admin.from("order_line_items").select("variant_title").eq("store_id", store.id);
  check("the line kept its variant", (hookedLines ?? []).some((l) => l.variant_title === "Blue"));
  const { data: hookedRefunds } = await admin.from("refunds").select("amount, quantity, external_id").eq("store_id", store.id);
  check("the refund landed by webhook", (hookedRefunds ?? []).length === 1);
  check("with what was given back", Number(hookedRefunds?.[0]?.amount) === 50);
  check("and how many units", hookedRefunds?.[0]?.quantity === 1);
  check("on the Shopify id, so the import lands on the same row", hookedRefunds?.[0]?.external_id === "gid://shopify/Refund/77");

  console.log("\nan order that was never refunded");
  await saveOrders(admin, store.id, [
    {
      id: `gid://shopify/Order/${stamp}2`, name: "#9002",
      createdAt: "2026-09-14T10:00:00Z", updatedAt: "2026-09-14T10:00:00Z", cancelledAt: null, tags: [],
      displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED",
      totalPriceSet: money("1299.00"), currentTotalPriceSet: money("1299.00"),
      customer: null, lineItems: { nodes: [] }, refunds: [],
    },
  ]);
  const plain = await row(`gid://shopify/Order/${stamp}2`);
  check("has the same number twice", Number(plain?.total) === 1299 && Number(plain?.total_original) === 1299);

  console.log("\nan old bulk file, before Shopify sent the current total");
  await saveOrders(admin, store.id, [
    {
      id: `gid://shopify/Order/${stamp}3`, name: "#9003",
      createdAt: "2026-09-14T10:00:00Z", updatedAt: "2026-09-14T10:00:00Z", cancelledAt: null, tags: [],
      displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED",
      totalPriceSet: money("149.00"),
      customer: null, lineItems: { nodes: [] }, refunds: [],
    },
  ]);
  const legacy = await row(`gid://shopify/Order/${stamp}3`);
  check("falls back to the original rather than nothing", Number(legacy?.total) === 149 && Number(legacy?.total_original) === 149);

  console.log("\nand what a designer is told");
  const advice = STORE_TABLES.orders.advice ?? "";
  check("revenue is the paid rows, not every row", /financial_status = "PAID"/.test(advice) && /Do not sum `total` over every row/.test(advice));
  check("awaiting payment is named on its own", /PENDING/.test(advice));
  check("cancelled is kept out", /cancelled_at/.test(advice));
  check("order value is the original", /avg\(total_original\)/.test(advice));
  check("and the section shows the original beside the total", STORE_TABLES.orders.columns.some((c) => c.field === "total_original"));
} finally {
  await project.remove();
  console.log("\nthe project is gone");
}

console.log(fails.length === 0 ? "\none total, whichever road" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
