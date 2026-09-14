// What a stranger with the public key can do.
//
// The anon key is not a secret — it ships in the browser bundle of
// every page. So the question this file asks is the only one that
// matters about the webhook path: holding that key and nothing else,
// can somebody write into a merchant's store?
//
// Until 0037 the answer was yes, including erasing one outright. The
// signature was checked in the Next.js route, and an attacker has no
// reason to use the route.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-webhook-gate.mjs

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

// Exactly what a stranger has: the URL and the anon key.
const stranger = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
// Used only to read the store back and to put it right afterwards.
const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const { data: store } = await admin
  .from("stores")
  .select("id, shop_domain")
  .eq("status", "connected")
  .maybeSingle();
if (!store) {
  console.log("no connected store — nothing to check");
  process.exit(0);
}
const countOf = async (table) =>
  (await admin.from(table).select("*", { count: "exact", head: true }).eq("store_id", store.id))
    .count;

console.log("holding only the public key");
const refused = async (fn, args) => !!(await stranger.rpc(fn, args)).error;

check(
  "cannot write an order",
  await refused("abo_shopify_upsert_order", {
    p_shop: store.shop_domain,
    p_order: { id: 1, name: "#forged" },
  })
);
check(
  "cannot rewrite a product",
  await refused("abo_shopify_upsert_product", {
    p_shop: store.shop_domain,
    p_product: { id: 1, title: "forged" },
  })
);
check(
  "cannot move stock",
  await refused("abo_shopify_set_inventory", {
    p_shop: store.shop_domain,
    p_level: { inventory_item_id: 1, location_id: 1, available: 0 },
  })
);

// The one that mattered most: this erases a merchant's imported data.
const ordersBefore = await countOf("orders");
const productsBefore = await countOf("products");
check(
  "cannot erase the store",
  await refused("abo_shopify_shop_redact", { p_shop: store.shop_domain })
);
check(
  "and the store is still there",
  (await countOf("orders")) === ordersBefore && (await countOf("products")) === productsBefore
);

console.log("\nthe one door it can knock on");
const body = JSON.stringify({ id: 987654321, title: "forged by a stranger" });
check(
  "an unsigned call is refused",
  await refused("abo_shopify_webhook", {
    p_topic: "products/update",
    p_shop: store.shop_domain,
    p_raw: body,
    p_hmac: null,
  })
);
check(
  "a made-up signature is refused",
  await refused("abo_shopify_webhook", {
    p_topic: "products/update",
    p_shop: store.shop_domain,
    p_raw: body,
    p_hmac: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  })
);
check("and nothing was written", (await countOf("products")) === productsBefore);

console.log("\nand Shopify itself still gets through");
const { data: product } = await admin
  .from("products")
  .select("id, external_id, title")
  .eq("store_id", store.id)
  .limit(1)
  .maybeSingle();
if (product) {
  const real = JSON.stringify({
    id: String(product.external_id).split("/").pop(),
    title: "Signed by Shopify",
    updated_at: new Date().toISOString(),
  });
  const hmac = createHmac("sha256", env.SHOPIFY_CLIENT_SECRET).update(real).digest("base64");
  const { error } = await stranger.rpc("abo_shopify_webhook", {
    p_topic: "products/update",
    p_shop: store.shop_domain,
    p_raw: real,
    p_hmac: hmac,
  });
  check("a properly signed webhook is accepted", !error);
  const row = (await admin.from("products").select("title").eq("id", product.id).single()).data;
  check("and the write really happened", row.title === "Signed by Shopify");
  await admin.from("products").update({ title: product.title }).eq("id", product.id);
} else {
  console.log("  --    nothing imported to sign against");
}

console.log(fails.length === 0 ? "\nthe public key opens nothing" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
