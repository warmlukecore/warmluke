// An order arriving by webhook, against the order already imported.
//
// The webhook speaks REST and the importer speaks GraphQL, and the two
// disagree about ids and about tags. Neither disagreement raises an
// error — the first silently doubles every order, the second turns
// "cod, priority" into one tag — so both are checked against the real
// rows the importer wrote.
//
// This edits one real order in the dev store and puts it back at the
// end. Run the importer afterwards to restore its line items.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-order-webhook.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const { data: store, error: lookup } = await db
  .from("stores")
  .select("id, shop_domain")
  .eq("status", "connected")
  .maybeSingle();
// A query that could not run is not an empty result. This reported
// "nothing to check" and exited 0 when the request had failed outright,
// so a check of a security boundary passed without reaching it.
if (lookup) {
  console.log(`could not look for a store: ${lookup.message}`);
  process.exit(1);
}
if (!store) {
  console.log("no connected store — nothing to check");
  process.exit(0);
}

const send = (order, shop = store.shop_domain) =>
  db.rpc("abo_shopify_upsert_order", { p_shop: shop, p_order: order });

const orderCount = async () =>
  (await db.from("orders").select("*", { count: "exact", head: true }).eq("store_id", store.id))
    .count;
const idOf = async (ext) =>
  (await db.from("orders").select("id").eq("external_id", ext).single()).data.id;

const before = await orderCount();

const { data: existing } = await db
  .from("orders")
  .select("external_id, order_number, tags, total")
  .eq("store_id", store.id)
  .not("order_number", "is", null)
  .limit(1)
  .single();
const numericId = existing.external_id.split("/").pop();

console.log(`updating ${existing.order_number} as Shopify would`);
await send({
  id: Number(numericId),
  name: existing.order_number,
  created_at: "2026-09-14T10:00:00-04:00",
  updated_at: "2026-09-14T11:00:00-04:00",
  current_total_price: "1234.50",
  currency: "USD",
  financial_status: "paid",
  fulfillment_status: "fulfilled",
  tags: "cod, priority ,  ",
  line_items: [{ id: 991, title: "A thing", sku: "X-1", quantity: 2, price: "617.25" }],
});

// The trap: a REST id written straight in becomes a second row for an
// order that already exists, and nothing complains.
check("the same order did not become a second row", (await orderCount()) === before);

const { data: updated } = await db
  .from("orders")
  .select("total, tags, financial_status, fulfilment_status")
  .eq("external_id", existing.external_id)
  .single();
check("the total was updated", Number(updated.total) === 1234.5);
// "cod, priority" is one string over REST and an array over GraphQL.
check("tags were split, not stored as one long tag", updated.tags.join("|") === "cod|priority");
check("an empty tag was dropped", !updated.tags.includes(""));
check("status matches the importer's casing", updated.financial_status === "PAID");
check("fulfilment came across too", updated.fulfilment_status === "FULFILLED");

const { data: lines } = await db
  .from("order_line_items")
  .select("sku")
  .eq("order_id", await idOf(existing.external_id));
check("the line came with it", lines.length === 1 && lines[0].sku === "X-1");

// An order edited in Shopify can lose a line. Merging rather than
// replacing would leave the removed one behind for ever.
await send({
  id: Number(numericId),
  name: existing.order_number,
  created_at: "2026-09-14T10:00:00-04:00",
  current_total_price: "617.25",
  currency: "USD",
  tags: "",
  line_items: [],
});
const { count: nowLines } = await db
  .from("order_line_items")
  .select("*", { count: "exact", head: true })
  .eq("order_id", await idOf(existing.external_id));
check("a removed line is gone, not left behind", nowLines === 0);
check(
  "and tags cleared rather than kept",
  (await db.from("orders").select("tags").eq("external_id", existing.external_id).single()).data
    .tags.length === 0
);

console.log("\nrequests that should change nothing");
check("an order for a shop we do not hold is ignored",
  (await send({ id: 1, name: "#x" }, "not-ours.myshopify.com")).data === 0);
check("and wrote no row", (await orderCount()) === before);
check("an order with no id is ignored", (await send({ name: "#no-id" })).data === 0);

console.log("\nthe store is marked fresh, which is what the assistant reports");
const { data: s } = await db
  .from("stores")
  .select("last_synced_at")
  .eq("id", store.id)
  .single();
check("last_synced_at moved to now", Date.now() - Date.parse(s.last_synced_at) < 60_000);

console.log("\nputting the order back the way the importer had it");
await send({
  id: Number(numericId),
  name: existing.order_number,
  created_at: "2026-09-14T10:00:00-04:00",
  current_total_price: String(existing.total),
  currency: "USD",
  tags: (existing.tags ?? []).join(", "),
  line_items: [],
});
console.log("  (run the importer to restore its line items)");

console.log(fails.length === 0 ? "\nthe webhook and the importer agree" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
