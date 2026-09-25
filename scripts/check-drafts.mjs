// The orders a merchant made by hand, on both roads.
//
// A draft arrives two ways: the import reads GraphQL and saveDraftOrders
// writes it, or Shopify posts REST at a webhook and SQL writes it. They
// have to leave the same row behind. They did not for refunds until
// somebody looked — GraphQL says REFUND and REST says refund, and a
// list filtered on one silently lost the other.
//
// Three things beyond that, each one a way a draft is not an order:
// a line the merchant typed has no product at all; a draft that
// became an order has to say which, or the same sale is counted
// twice; and a line removed in Shopify has to disappear here.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-drafts.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { saveDraftOrders } from "../src/lib/shopify-import.ts";
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
const project = await throwawayProject(admin, me.user.id, "drafts");
const stamp = Date.now().toString(36);
const shop = `drafts-${stamp}.myshopify.com`;

try {
  const { data: store } = await admin
    .from("stores")
    .insert({ project_id: project.id, shop_domain: shop, status: "connected" })
    .select("id")
    .single();

  // An order for the completed draft to point at, and a product for
  // one of the lines to match.
  const orderExt = `gid://shopify/Order/${stamp}9`;
  const { data: order } = await admin
    .from("orders")
    .insert({
      store_id: store.id,
      external_id: orderExt,
      order_number: "#9001",
      total: 1299,
      currency: "USD",
      source: "shopify",
    })
    .select("id")
    .single();
  const productExt = `gid://shopify/Product/${stamp}7`;
  const { data: product } = await admin
    .from("products")
    .insert({ store_id: store.id, external_id: productExt, title: "Clear Phone Case" })
    .select("id")
    .single();

  const draftExt = `gid://shopify/DraftOrder/${stamp}1`;
  const row = async (ext = draftExt) =>
    (await admin.from("draft_orders").select("*").eq("store_id", store.id).eq("external_id", ext).maybeSingle()).data;
  const lines = async (id) =>
    (await admin.from("draft_order_line_items").select("*").eq("draft_order_id", id).order("title")).data ?? [];

  console.log("the import road");
  await saveDraftOrders(admin, store.id, [
    {
      id: draftExt,
      name: "#D1",
      status: "OPEN",
      email: "quote@example.test",
      tags: ["cod", "wholesale"],
      createdAt: "2026-09-14T05:35:34Z",
      updatedAt: "2026-09-14T05:35:34Z",
      completedAt: null,
      invoiceUrl: "https://example.test/invoices/abc",
      totalPriceSet: { shopMoney: { amount: "230.0", currencyCode: "USD" } },
      subtotalPriceSet: { shopMoney: { amount: "200.0" } },
      totalTaxSet: { shopMoney: { amount: "0.0" } },
      totalShippingPriceSet: { shopMoney: { amount: "30.0" } },
      customer: null,
      order: null,
      lineItems: {
        nodes: [
          // A line the merchant typed: no product, no variant, no SKU.
          // #D1 in the real dev store is exactly this.
          {
            id: `gid://shopify/DraftOrderLineItem/${stamp}A`,
            title: "Custom Snowboard",
            sku: null,
            quantity: 1,
            variant: null,
            product: null,
            originalUnitPriceSet: { shopMoney: { amount: "200.0" } },
            discountedUnitPriceSet: { shopMoney: { amount: "200.0" } },
          },
          // And one off the catalogue, discounted by hand — the
          // ordinary reason a draft exists at all.
          {
            id: `gid://shopify/DraftOrderLineItem/${stamp}B`,
            title: "Clear Phone Case",
            sku: "CASE-L",
            quantity: 2,
            variant: null,
            product: { id: productExt },
            originalUnitPriceSet: { shopMoney: { amount: "299.0" } },
            discountedUnitPriceSet: { shopMoney: { amount: "249.0" } },
          },
        ],
      },
    },
  ]);

  const imported = await row();
  check("the draft is written", !!imported);
  check("with its own number", imported?.name === "#D1");
  check(
    "and the four money parts apart",
    Number(imported?.total) === 230 &&
      Number(imported?.subtotal) === 200 &&
      Number(imported?.shipping) === 30 &&
      Number(imported?.tax) === 0
  );
  check("its tags", String(imported?.tags) === "cod,wholesale");
  check("and no order, because it is still open", imported?.order_id === null && imported?.order_external_id === null);

  const two = await lines(imported.id);
  check("both lines are there", two.length === 2);
  const custom = two.find((l) => l.title === "Custom Snowboard");
  // The half that would be dropped by a saver that insisted on a
  // product: a real line on a real quote, worth real money.
  check("the typed line is kept with no product", !!custom && custom.product_id === null && custom.sku === null);
  const picked = two.find((l) => l.title === "Clear Phone Case");
  check("the picked line is joined to the product", picked?.product_id === product.id);
  check("at the price it is actually being sold for", Number(picked?.price) === 249);

  console.log("\nand the webhook road leaves the same row");
  const restExt = `${stamp}2`;
  const { error: hookErr } = await admin.rpc("abo_shopify_upsert_draft_order", {
    p_shop: shop,
    p_d: {
      id: restExt,
      name: "#D2",
      // Lower case here, upper case in GraphQL. This is the refunds
      // bug, waiting to happen again.
      status: "completed",
      email: "quote2@example.test",
      tags: "cod, wholesale",
      created_at: "2026-09-15T05:35:34Z",
      updated_at: "2026-09-15T06:00:00Z",
      completed_at: "2026-09-15T06:00:00Z",
      invoice_url: "https://example.test/invoices/def",
      currency: "USD",
      total_price: "230.00",
      subtotal_price: "200.00",
      total_tax: "0.00",
      shipping_line: { price: "30.00" },
      order_id: orderExt,
      line_items: [
        { id: `${stamp}C`, title: "Custom Snowboard", sku: null, quantity: 1, price: "200.00" },
        {
          id: `${stamp}D`,
          title: "Clear Phone Case",
          sku: "CASE-L",
          quantity: 2,
          price: "249.00",
          product_id: productExt,
        },
      ],
    },
  });
  check("the webhook is accepted", !hookErr);
  if (hookErr) console.log("     →", hookErr.message);

  const viaHook = await row(`gid://shopify/DraftOrder/${restExt}`);
  check("it wrote a draft", !!viaHook);
  // The whole point of this check.
  check("with the status in the same case as the import's", viaHook?.status === "COMPLETED");
  check(
    "the same four money parts",
    Number(viaHook?.total) === 230 &&
      Number(viaHook?.subtotal) === 200 &&
      Number(viaHook?.shipping) === 30 &&
      Number(viaHook?.tax) === 0
  );
  check("the same tags, split the same way", String(viaHook?.tags) === "cod,wholesale");
  // Without this a completed draft and the order it became are two
  // sales in every total that covers both lists.
  check("and it names the order it became", viaHook?.order_id === order.id);
  const hookLines = await lines(viaHook.id);
  check("its lines are written too", hookLines.length === 2);
  check(
    "the typed one with no product here as well",
    hookLines.find((l) => l.title === "Custom Snowboard")?.product_id === null
  );
  check("and the picked one joined", hookLines.find((l) => l.title === "Clear Phone Case")?.product_id === product.id);

  console.log("\nand a line the merchant removed goes");
  await saveDraftOrders(admin, store.id, [
    {
      id: draftExt,
      name: "#D1",
      status: "OPEN",
      email: "quote@example.test",
      tags: ["cod"],
      createdAt: "2026-09-14T05:35:34Z",
      updatedAt: "2026-09-16T05:35:34Z",
      completedAt: null,
      invoiceUrl: "https://example.test/invoices/abc",
      totalPriceSet: { shopMoney: { amount: "200.0", currencyCode: "USD" } },
      subtotalPriceSet: { shopMoney: { amount: "200.0" } },
      totalTaxSet: { shopMoney: { amount: "0.0" } },
      totalShippingPriceSet: { shopMoney: { amount: "0.0" } },
      customer: null,
      order: null,
      lineItems: {
        nodes: [
          {
            id: `gid://shopify/DraftOrderLineItem/${stamp}A`,
            title: "Custom Snowboard",
            sku: null,
            quantity: 1,
            variant: null,
            product: null,
            originalUnitPriceSet: { shopMoney: { amount: "200.0" } },
            discountedUnitPriceSet: { shopMoney: { amount: "200.0" } },
          },
        ],
      },
    },
  ]);
  const after = await lines(imported.id);
  // An upsert alone would leave the removed line behind for ever, and
  // the quote would read higher here than it does in Shopify.
  check("the draft now has one line, not two", after.length === 1);
  check("and it is the one still in Shopify", after[0]?.title === "Custom Snowboard");
  check("the shipping it no longer charges is gone", Number((await row())?.shipping) === 0);

  console.log("\nand what a merchant reads");
  const { data: view, error: viewErr } = await admin
    .from("store_draft_orders")
    .select("name, state, customer_name, total, became_order, items")
    .eq("store_id", store.id)
    .order("name");
  check("the list is readable", !viewErr);
  check("it holds both drafts", (view ?? []).length === 2);
  check('an open one reads as "Open"', view?.find((d) => d.name === "#D1")?.state === "Open");
  check("a completed one says it became an order", view?.find((d) => d.name === "#D2")?.state === "Became an order");
  check("and names which order", view?.find((d) => d.name === "#D2")?.became_order === "#9001");
  // Nobody attached: the address is the only thing to call them.
  check(
    "a draft with no customer falls back to the email",
    view?.find((d) => d.name === "#D1")?.customer_name === "quote@example.test"
  );
  check("and the line count comes with it", Number(view?.find((d) => d.name === "#D1")?.items) === 1);

  const { data: items } = await admin
    .from("store_draft_order_items")
    .select("draft, title, quantity, price, line_total, custom_item")
    .eq("store_id", store.id)
    .eq("draft", "#D2")
    .order("title");
  check(
    "the items list adds the line up",
    Number(items?.find((i) => i.title === "Clear Phone Case")?.line_total) === 498
  );
  check("and marks the typed line as custom", items?.find((i) => i.title === "Custom Snowboard")?.custom_item === true);
} finally {
  await admin.from("projects").delete().eq("id", project.id);
  console.log("\nthe project is gone");
}

console.log(fails.length === 0 ? "\nboth roads leave the same draft" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
