// Products, customers and stock arriving by webhook.
//
// The same disagreement the order webhook has: Shopify's webhooks
// speak REST and the importer speaks GraphQL, so ids are bare numbers
// on one side and gids on the other, and tags are a comma string
// against an array. Neither mismatch raises anything — it quietly
// doubles rows, or writes "cod, priority" as a single tag — so each is
// checked against the rows the importer actually wrote.
//
// Stock is the one that cannot work by accident: the payload names an
// inventory item, never a variant, so this also proves the importer
// stored that id in the first place.
//
// Everything it changes is put back.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-catalog-webhooks.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { shopifyStores } from "./owner-session.mjs";

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

// Never the seeded shop: these write into the store, and the read checks
// count on its rows staying as seeded.
let store = null;
let lookup = null;
try {
  [store = null] = await shopifyStores(db, "id, shop_domain");
} catch (e) {
  lookup = e;
}
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

/** The numeric id Shopify's REST payloads carry, out of a gid. */
const bare = (gid) => String(gid).split("/").pop();
const countOf = async (table) =>
  (await db.from(table).select("*", { count: "exact", head: true }).eq("store_id", store.id)).count;

// ── Products ────────────────────────────────────────────────────
console.log("a product changed in Shopify");
const { data: product } = await db
  .from("products")
  .select("id, external_id, title, handle, status, tags")
  .eq("store_id", store.id)
  .limit(1)
  .maybeSingle();
if (!product) {
  console.log("nothing imported yet — run the importer first");
  process.exit(0);
}

const productsBefore = await countOf("products");
await db.rpc("abo_shopify_upsert_product", {
  p_shop: store.shop_domain,
  p_product: {
    id: bare(product.external_id),
    title: "Renamed by webhook",
    handle: product.handle,
    status: "active",
    // One string here, an array in GraphQL.
    tags: "cod, priority",
    updated_at: new Date().toISOString(),
  },
});

const after = async () =>
  (await db.from("products").select("title, tags").eq("id", product.id).single()).data;
const now = await after();
check("the new title is there", now.title === "Renamed by webhook");
check("and the tags became two, not one", now.tags?.length === 2 && now.tags[0] === "cod");
check("without a second copy of the product", (await countOf("products")) === productsBefore);

const strangerCount = await countOf("products");
await db.rpc("abo_shopify_upsert_product", {
  p_shop: "someone-else.myshopify.com",
  p_product: { id: bare(product.external_id), title: "Not yours" },
});
check("a shop we do not have is ignored", (await countOf("products")) === strangerCount);
check("and it did not touch ours", (await after()).title === "Renamed by webhook");

// Put the title and tags back before anything else runs.
await db
  .from("products")
  .update({ title: product.title, tags: product.tags, status: product.status })
  .eq("id", product.id);

// ── Customers ───────────────────────────────────────────────────
console.log("\na customer changed in Shopify");
const { data: customer } = await db
  .from("customers")
  .select("id, external_id, name, email, city, tags, orders_count")
  .eq("store_id", store.id)
  .limit(1)
  .maybeSingle();
if (customer) {
  const customersBefore = await countOf("customers");
  await db.rpc("abo_shopify_upsert_customer", {
    p_shop: store.shop_domain,
    p_customer: {
      id: bare(customer.external_id),
      // REST sends the halves; GraphQL sends one displayName.
      first_name: "Webhook",
      last_name: "Person",
      email: customer.email,
      tags: "vip, wholesale",
      orders_count: 9,
      default_address: { city: "Leeds", zip: "LS1" },
      updated_at: new Date().toISOString(),
    },
  });
  const row = (await db.from("customers").select("*").eq("id", customer.id).single()).data;
  check("the two name halves become one name", row.name === "Webhook Person");
  check("the address is picked out of the payload", row.city === "Leeds");
  check("the tags became two", row.tags?.length === 2);
  check("and there is still one customer", (await countOf("customers")) === customersBefore);

  await db
    .from("customers")
    .update({
      name: customer.name,
      city: customer.city,
      tags: customer.tags,
      orders_count: customer.orders_count,
    })
    .eq("id", customer.id);
} else {
  console.log("  --    no customers imported");
}

// ── Stock ───────────────────────────────────────────────────────
console.log("\nstock moved in Shopify");
const { data: variant } = await db
  .from("variants")
  .select("id, external_id, inventory_item_id")
  .eq("store_id", store.id)
  .not("inventory_item_id", "is", null)
  .limit(1)
  .maybeSingle();

if (!variant) {
  check("the importer stored the inventory item id (re-import if this fails)", false);
} else {
  const { data: level } = await db
    .from("inventory_levels")
    .select("id, variant_id, location_id, location_name, available")
    .eq("variant_id", variant.id)
    .not("location_id", "is", null)
    .limit(1)
    .maybeSingle();

  const levelsBefore = await countOf("inventory_levels");
  const locationId = level?.location_id ?? "gid://shopify/Location/1";
  await db.rpc("abo_shopify_set_inventory", {
    p_shop: store.shop_domain,
    p_level: {
      inventory_item_id: bare(variant.inventory_item_id),
      location_id: bare(locationId),
      available: 4242,
      updated_at: new Date().toISOString(),
    },
  });

  const row = (
    await db
      .from("inventory_levels")
      .select("available, location_name")
      .eq("variant_id", variant.id)
      .eq("location_id", locationId)
      .maybeSingle()
  ).data;
  check("the level is found by its inventory item, not its variant", !!row);
  check("and carries the new count", row?.available === 4242);
  if (level) {
    check("the location's name was not blanked", row?.location_name === level.location_name);
    check("and no second row appeared", (await countOf("inventory_levels")) === levelsBefore);
    await db.from("inventory_levels").update({ available: level.available }).eq("id", level.id);
  }

  // Two different locations may share a name. The key used to be the
  // name, so the second one landed on the first one's row and one
  // shop's stock quietly overwrote the other's.
  const twinLocation = "gid://shopify/Location/424242";
  await db.rpc("abo_shopify_set_inventory", {
    p_shop: store.shop_domain,
    p_level: {
      inventory_item_id: bare(variant.inventory_item_id),
      location_id: bare(twinLocation),
      available: 7,
      updated_at: new Date().toISOString(),
    },
  });
  const both = await db
    .from("inventory_levels")
    .select("location_id, available")
    .eq("variant_id", variant.id);
  check(
    "a second location keeps its own row",
    (both.data ?? []).some((r) => r.location_id === twinLocation)
  );
  check(
    "and does not overwrite the first",
    // The first row is still its own row with its own number. Its
    // value was put back a few lines up, so what matters is that it
    // is not the seven this second location just reported.
    (both.data ?? []).some((r) => r.location_id === locationId && r.available !== 7)
  );
  await db.from("inventory_levels").delete().eq("location_id", twinLocation);

  // A level for a variant nobody has imported is almost always the two
  // webhooks arriving out of order. It used to be discarded with a
  // success answer, so Shopify never sent that number again and the
  // stock stayed wrong for good. Now it fails, which is what makes
  // Shopify try again once the product has landed.
  const orphanBefore = await countOf("inventory_levels");
  const orphan = await db.rpc("abo_shopify_set_inventory", {
    p_shop: store.shop_domain,
    p_level: { inventory_item_id: "999999999", location_id: "1", available: 5 },
  });
  check("a level for an unknown item is refused, not swallowed", !!orphan.error);
  check(
    "and says why, so the log is readable",
    /arrived before its product/i.test(orphan.error?.message ?? "")
  );
  check(
    "nothing is written against nothing",
    (await countOf("inventory_levels")) === orphanBefore
  );

  // A shop nobody has connected is not a timing problem, and retrying
  // it for two days would only get the topic switched off.
  const unknownShop = await db.rpc("abo_shopify_set_inventory", {
    p_shop: "not-a-shop.myshopify.com",
    p_level: { inventory_item_id: "1", location_id: "1", available: 5 },
  });
  check("but an unknown shop is not retried", !unknownShop.error);
}

console.log(fails.length === 0 ? "\nthe catalogue keeps itself current" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
