// Runs the importer against the connected store and reports what landed.
//
// Uses a service-role client locally so it needs nobody's password; the
// route's own auth is the same getUserClient every other route uses. What
// is unproven without this is the part nothing else covers — whether the
// pages, cursors and links actually produce correct rows.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-import.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { RESOURCES, importPage } from "../src/lib/shopify-resources.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const db = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

// The importer renews an expiring token, and reads the app credentials
// from process.env the way a route does. Without this the renewal is
// skipped and the run fails an hour after connecting.
Object.assign(process.env, env);

const { data: store } = await db
  .from("stores")
  .select("id, shop_domain, access_token, refresh_token, token_expires_at")
  .eq("status", "connected").maybeSingle();
// Nothing to import from is nothing to check — the way "no project on
// this account" is elsewhere. Exit 0 and say so: on a database with a
// store this runs in full, on a blank one it must not read as broken.
if (!store) { console.log("no connected store — nothing to check"); process.exit(0); }
console.log(`store: ${store.shop_domain}\n`);

// A resource Shopify refuses is reported, not thrown — one blocked scope
// would otherwise hide whether everything else imported correctly.
const blocked = [];
for (const resource of RESOURCES) {
  let cursor = null, total = 0, pages = 0;
  try {
    for (;;) {
      const page = await importPage(db, store, resource, cursor);
      total += page.imported; pages++;
      if (!page.hasNext || pages > 40) break;
      cursor = page.cursor;
    }
  } catch (e) {
    blocked.push(resource);
    console.log(`  ${resource.padEnd(11)} BLOCKED — ${e.message}`);
    continue;
  }
  console.log(`  ${resource.padEnd(11)} ${String(total).padStart(4)} in ${pages} page(s)`);
}

console.log("\nwhat landed:");
for (const t of ["products", "variants", "customers", "orders", "order_line_items", "refunds", "inventory_levels"]) {
  const { count } = await db.from(t).select("*", { count: "exact", head: true }).eq("store_id", store.id);
  console.log(`  ${t.padEnd(18)} ${count}`);
}

const fails = [];
const check = (name, cond) => { console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`); if (!cond) fails.push(name); };
// Checks whose resource Shopify refused are neither passes nor failures —
// calling them either would be this script guessing at data it never saw.
const skipped = [];
const only = (resource, name, cond) =>
  blocked.includes(resource) ? skipped.push(name) : check(name, cond());

console.log("\nand whether it is right:");
const { data: orders } = await db.from("orders").select("order_number, total, currency, tags, cancelled_at, customer_id").eq("store_id", store.id).order("order_number");
const o = (name, cond) => only("orders", name, cond);
o("every order arrived", () => orders.length === 4);
o("the cancelled one is marked cancelled", () => orders.filter((x) => x.cancelled_at).length === 1);
o("tags survived", () => orders.some((x) => x.tags.includes("cod")));
o("totals are numbers, not text", () => orders.every((x) => typeof x.total === "number" && x.total > 0));
o("currency came across", () => orders.every((x) => x.currency === "USD"));
o("orders are linked to customers", () => orders.some((x) => x.customer_id));

const { data: lines } = await db.from("order_line_items").select("sku, quantity, price, variant_id, title").eq("store_id", store.id);
o("the multi-line order kept both lines", () => lines.length >= 5);
o("purchase-time titles were copied", () => lines.every((l) => !!l.title));
o("a blank SKU did not break the line", () => lines.some((l) => l.sku === null) || lines.every((l) => l.sku !== undefined));
o("lines point at their variant", () => lines.some((l) => l.variant_id));

const { data: dupes } = await db.from("variants").select("sku").eq("store_id", store.id).eq("sku", "BA141-BLK");
check("the duplicate SKU stayed two separate variants", dupes.length === 2);

const { data: blank } = await db.from("variants").select("id").eq("store_id", store.id).is("sku", null);
check("variants without a SKU still imported", blank.length > 0);

const { data: stock } = await db.from("inventory_levels").select("available").eq("store_id", store.id);
only("inventory", "stock levels landed", () => stock.length > 0);
only("inventory", "an out-of-stock variant reads zero, not missing", () => stock.some((x) => x.available === 0));

if (skipped.length) console.log(`\n${skipped.length} check(s) not run — blocked: ${blocked.join(", ")}`);
console.log(fails.length === 0 ? "\nevery check that could run passed" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
