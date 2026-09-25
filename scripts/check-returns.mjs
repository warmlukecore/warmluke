// The journey a refund is the end of.
//
// No return exists in the development store this was built against,
// so nothing here has been seen arriving from Shopify. That is said
// plainly rather than hidden: the query and the bulk export were
// validated against the live schema, and everything below is the
// saver and the SQL put through the shapes the schema says can come.
//
// Three things are genuinely easy to get wrong and are checked hard:
//
//   the bulk file is three deep — an order, its returns, their
//   lines — and putting that back is the only bespoke assembler in
//   the registry;
//
//   returnLineItems is an INTERFACE, and one of its two shapes has
//   no link to what was bought at all, so a line with no product is
//   correct rather than broken;
//
//   a return is not a refund. Counting both is counting one event
//   twice, and the view exists to keep them apart.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-returns.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { saveReturns } from "../src/lib/shopify-import.ts";
import { SHOPIFY_RESOURCES, childrenWereCut } from "../src/lib/shopify-resources.ts";
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

// ── The assembler, which needs no database ────────────────────
console.log("a bulk file three levels deep is put back");
const ORDER_A = "gid://shopify/Order/1";
const ORDER_B = "gid://shopify/Order/2";
const RET_1 = "gid://shopify/Return/11";
const RET_2 = "gid://shopify/Return/12";
const RET_3 = "gid://shopify/Return/13";
// Exactly how Shopify writes it: a parent, then its children, then
// their children, each naming the one above.
const file = [
  { id: ORDER_A },
  { id: RET_1, name: "#1001-R1", status: "OPEN", __parentId: ORDER_A },
  { id: "line-a", quantity: 2, __parentId: RET_1 },
  { id: "line-b", quantity: 1, __parentId: RET_1 },
  { id: RET_2, name: "#1001-R2", status: "CLOSED", __parentId: ORDER_A },
  { id: "line-c", quantity: 5, __parentId: RET_2 },
  { id: ORDER_B },
  { id: RET_3, name: "#1002-R1", status: "REQUESTED", __parentId: ORDER_B },
];
const built = SHOPIFY_RESOURCES.returns.bulk.assemble(file);
check("both orders come back", built.length === 2);
check("in the order the file had them", built[0].id === ORDER_A && built[1].id === ORDER_B);
check("the first order keeps both its returns", built[0].returns.nodes.length === 2);
check("and the second keeps its one", built[1].returns.nodes.length === 1);
// The bit a flat assembler gets wrong: lines landing on the wrong
// return, or on the order.
check("two lines land on the first return", built[0].returns.nodes[0].returnLineItems.nodes.length === 2);
check("one lands on the second", built[0].returns.nodes[1].returnLineItems.nodes.length === 1);
check("and it is the right one", built[0].returns.nodes[1].returnLineItems.nodes[0].id === "line-c");
check("a return with no lines still has an empty list", built[1].returns.nodes[0].returnLineItems.nodes.length === 0);
check("and the return keeps its own fields", built[0].returns.nodes[0].name === "#1001-R1");
// An order with no return at all must not vanish from the file.
const lonely = SHOPIFY_RESOURCES.returns.bulk.assemble([{ id: ORDER_A }]);
check("an order with no return survives assembly", lonely.length === 1 && lonely[0].returns.nodes.length === 0);
// A child whose parent is missing is dropped, not crashed on.
const orphan = SHOPIFY_RESOURCES.returns.bulk.assemble([{ id: "line-z", __parentId: "gid://shopify/Return/nope" }]);
check("an orphaned line is dropped rather than thrown over", orphan.length === 0);

console.log("\nand a page at its limit is known to be cut");
const [byReturn, byLine] = SHOPIFY_RESOURCES.returns.children.map((c) => c.limit);
const atLimit = {
  id: ORDER_A,
  returns: { nodes: Array.from({ length: byReturn }, (_, i) => ({ id: `r${i}`, returnLineItems: { nodes: [] } })) },
};
check(`${byReturn} returns on one order means go bulk`, childrenWereCut("returns", [atLimit]));
const deepLimit = {
  id: ORDER_A,
  returns: {
    nodes: [{ id: "r", returnLineItems: { nodes: Array.from({ length: byLine }, (_, i) => ({ id: `l${i}` })) } }],
  },
};
// The one a single-level check would miss: the lines are two lists
// down, inside each return.
check(`${byLine} lines inside one return does too`, childrenWereCut("returns", [deepLimit]));
const small = { id: ORDER_A, returns: { nodes: [{ id: "r", returnLineItems: { nodes: [{ id: "l" }] } }] } };
check("and a small one does not", !childrenWereCut("returns", [small]));

// ── The saver and what a merchant reads ───────────────────────
const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(anon, env);
if (!me.session) {
  console.log(`no check user: ${me.why}`);
  process.exit(1);
}
const project = await throwawayProject(admin, me.user.id, "returns");
const stamp = Date.now().toString(36);
const shop = `ret-${stamp}.myshopify.com`;

try {
  const { data: store } = await admin
    .from("stores")
    .insert({ project_id: project.id, shop_domain: shop, status: "connected" })
    .select("id")
    .single();
  const { data: customer } = await admin
    .from("customers")
    .insert({ store_id: store.id, external_id: `gid://shopify/Customer/${stamp}`, name: "Aman Kumar" })
    .select("id")
    .single();
  const orderExt = `gid://shopify/Order/${stamp}1`;
  const { data: order } = await admin
    .from("orders")
    .insert({
      store_id: store.id,
      external_id: orderExt,
      order_number: "#1004",
      customer_id: customer.id,
      total: 1299,
      currency: "USD",
      source: "shopify",
    })
    .select("id")
    .single();
  const productExt = `gid://shopify/Product/${stamp}2`;
  const { data: product } = await admin
    .from("products")
    .insert({ store_id: store.id, external_id: productExt, title: "Clear Phone Case" })
    .select("id")
    .single();

  const eightDaysAgo = new Date(Date.now() - 8 * 86400_000).toISOString();
  const retExt = `gid://shopify/Return/${stamp}3`;
  await saveReturns(admin, store.id, [
    {
      id: orderExt,
      returns: {
        nodes: [
          {
            id: retExt,
            name: "#1004-R1",
            status: "OPEN",
            totalQuantity: 3,
            createdAt: eightDaysAgo,
            closedAt: null,
            returnLineItems: {
              nodes: [
                // Verified: reaches back to what was bought.
                {
                  id: `gid://shopify/ReturnLineItem/${stamp}A`,
                  quantity: 2,
                  refundedQuantity: 1,
                  returnReasonNote: "Too tight on the camera bump",
                  returnReasonDefinition: { handle: "size-too-small", name: "Size too small" },
                  fulfillmentLineItem: {
                    lineItem: {
                      id: "li-1",
                      title: "Clear Phone Case",
                      sku: "CASE-L",
                      variant: null,
                      product: { id: productExt },
                    },
                  },
                },
                // Unverified: the interface's other shape, which carries no
                // link to a product at all. Null here is right, not missing.
                {
                  id: `gid://shopify/UnverifiedReturnLineItem/${stamp}B`,
                  quantity: 1,
                  refundedQuantity: 0,
                  returnReasonNote: null,
                  returnReasonDefinition: { handle: "unwanted", name: "Unwanted" },
                },
              ],
            },
          },
        ],
      },
    },
    // An order the filter returned that has no return on it any more.
    { id: `gid://shopify/Order/${stamp}9`, returns: { nodes: [] } },
  ]);

  const saved = (await admin.from("returns").select("*").eq("store_id", store.id)).data ?? [];
  check("the return is written", saved.length === 1);
  check("joined to its order", saved[0]?.order_id === order.id);
  check("with the status upper case", saved[0]?.status === "OPEN");
  check("and the day it was asked for", saved[0]?.requested_at !== null);

  const lines =
    (await admin.from("return_line_items").select("*").eq("return_id", saved[0].id).order("quantity")).data ?? [];
  check("both lines are written", lines.length === 2);
  const unverified = lines.find((l) => l.quantity === 1);
  const verified = lines.find((l) => l.quantity === 2);
  check("the verified line reaches its product", verified?.product_id === product.id && verified?.sku === "CASE-L");
  check(
    "the unverified one has no product, and is still kept",
    unverified?.product_id === null && unverified?.title === null
  );
  check("the reason is in words, not a constant", verified?.reason === "Size too small");
  check("the customer's own note comes too", verified?.reason_note === "Too tight on the camera bump");
  check(
    "and how much has actually been paid back",
    verified?.refunded_quantity === 1 && unverified?.refunded_quantity === 0
  );

  console.log("\nand a line dropped in Shopify goes");
  await saveReturns(admin, store.id, [
    {
      id: orderExt,
      returns: {
        nodes: [
          {
            id: retExt,
            name: "#1004-R1",
            status: "CLOSED",
            totalQuantity: 2,
            createdAt: eightDaysAgo,
            closedAt: new Date().toISOString(),
            returnLineItems: {
              nodes: [
                {
                  id: `gid://shopify/ReturnLineItem/${stamp}A`,
                  quantity: 2,
                  refundedQuantity: 2,
                  returnReasonNote: "Too tight on the camera bump",
                  returnReasonDefinition: { handle: "size-too-small", name: "Size too small" },
                  fulfillmentLineItem: {
                    lineItem: {
                      id: "li-1",
                      title: "Clear Phone Case",
                      sku: "CASE-L",
                      variant: null,
                      product: { id: productExt },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ]);
  check(
    "one line left, not two",
    ((await admin.from("return_line_items").select("id").eq("return_id", saved[0].id)).data ?? []).length === 1
  );

  console.log("\nand what a merchant reads");
  const view = (await admin.from("store_returns").select("*").eq("store_id", store.id).single()).data;
  check("it names the order and the customer", view?.order_number === "#1004" && view?.customer_name === "Aman Kumar");
  check("the state is in their words", view?.state === "Done");
  check("the reason reads as Shopify labels it", view?.reasons === "Size too small");
  // Finished, so nothing is still ticking.
  check("a finished return has no days open", view?.days_open === null);
  check("and it says when it closed", typeof view?.closed_at === "string");

  // Re-open it to prove the counter works at all.
  await admin.from("returns").update({ status: "OPEN", closed_at: null }).eq("id", saved[0].id);
  const open = (await admin.from("store_returns").select("state, days_open").eq("store_id", store.id).single()).data;
  check("an open one says how long it has been open", Number(open?.days_open) === 8);
  check("in the merchant's words", open?.state === "Agreed, not back yet");

  console.log("\nand why things come back");
  const reasons = (await admin.from("return_reasons").select("*").eq("store_id", store.id)).data ?? [];
  check(
    "the product and its reason are grouped",
    reasons.some(
      (r) => r.title === "Clear Phone Case" && r.reason === "Size too small" && Number(r.units_returned) === 2
    )
  );

  console.log("\nand the webhook road finds the same return");
  const { data: n, error: hookErr } = await admin.rpc("abo_shopify_upsert_return", {
    p_shop: shop,
    p_r: {
      admin_graphql_api_id: retExt,
      name: "#1004-R1",
      status: "closed",
      total_quantity: 2,
      order_id: orderExt,
      updated_at: new Date().toISOString(),
    },
  });
  check("the webhook is accepted", !hookErr && n === 1);
  if (hookErr) console.log("     →", hookErr.message);
  const after = (await admin.from("returns").select("*").eq("external_id", retExt).single()).data;
  check("with the status in the import's case", after?.status === "CLOSED");
  check("and it did not lose the day it was asked for", after?.requested_at !== null);
  check(
    "nor its lines",
    ((await admin.from("return_line_items").select("id").eq("return_id", saved[0].id)).data ?? []).length === 1
  );

  // A return for an order nobody has imported is not invented.
  const { data: nothing } = await admin.rpc("abo_shopify_upsert_return", {
    p_shop: shop,
    p_r: { admin_graphql_api_id: "gid://shopify/Return/999", status: "open", order_id: "gid://shopify/Order/999" },
  });
  check("a return for an unknown order writes nothing", nothing === 0);
} finally {
  await admin.from("projects").delete().eq("id", project.id);
  console.log("\nthe project is gone");
}

console.log(
  fails.length === 0 ? "\nthe goods coming back, kept apart from the money going out" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
