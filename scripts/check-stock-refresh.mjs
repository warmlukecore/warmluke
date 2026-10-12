// Stock is counted whole (0207).
//
// Shopify's stock webhook carries available alone, and a sale or a
// fulfilment moves on hand and committed too, so those froze at the last
// import. Now any webhook that can move stock marks its variants due, and
// the import worker reads each due one's whole count from Shopify. This
// holds the marking (stock levels by inventory item, orders and
// fulfilments by line, nothing else), the count (Shopify stood in for:
// all four numbers written, a deleted variant settled), a webhook landing
// mid-count kept for the next round, a page Shopify refuses held back a
// quarter of an hour, the stock webhook no longer claiming a row fresh,
// the nightly share counted longest ago, and the walls: only the store's
// own ticket reaches its marks, and nobody signed in does.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-stock-refresh.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { refreshStock } from "../src/lib/shopify-import.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const holding = (ticket) =>
  createClient(URL_, ANON, { global: { headers: { "x-import-ticket": ticket } }, auth: { persistSession: false } });

let failed = 0;
const check = (what, ok) => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) failed++;
};

const stamp = Date.now();
const SHOP = `stock-${stamp}.myshopify.com`;
const gid = (type, n) => `gid://shopify/${type}/${n}`;
const LOC = gid("Location", 1);

// Shopify, stood in for: only calls to the stand-in shop are answered here.
const realFetch = globalThis.fetch;
let shopify = null;
globalThis.fetch = (url, init) => (String(url).includes(SHOP) ? shopify(JSON.parse(init.body)) : realFetch(url, init));
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const counted = (n, q) => ({
  id: gid("ProductVariant", n),
  inventoryItem: {
    inventoryLevels: {
      nodes: [
        {
          location: { id: LOC, name: "Warehouse" },
          quantities: [
            { name: "available", quantity: q.available },
            { name: "on_hand", quantity: q.on_hand },
            { name: "committed", quantity: q.committed },
            { name: "incoming", quantity: q.incoming ?? 0 },
          ],
        },
      ],
    },
  },
});

const { data: made } = await admin.auth.admin.createUser({
  email: `stock_${stamp}@example.com`,
  password: `pw_${stamp}_aA1!`,
  email_confirm: true,
});
const owner = made.user;
let projectId = null;
try {
  const { data: project } = await admin
    .from("projects")
    .insert({ owner_id: owner.id, name: `stock-check ${stamp}` })
    .select("id")
    .single();
  projectId = project.id;
  const { data: store, error: se } = await admin
    .from("stores")
    .insert({ project_id: projectId, shop_domain: SHOP, status: "connected" })
    .select("id")
    .single();
  if (se) throw new Error(`could not make the store: ${se.message}`);
  const { data: product } = await admin
    .from("products")
    .insert({ store_id: store.id, external_id: gid("Product", 1), title: "Cherry Heart Case" })
    .select("id")
    .single();
  const variants = {};
  for (const n of [1, 2, 3]) {
    const { data: v, error: ve } = await admin
      .from("variants")
      .insert({
        store_id: store.id,
        product_id: product.id,
        external_id: gid("ProductVariant", n),
        inventory_item_id: gid("InventoryItem", 100 + n),
        sku: `SKU-${n}`,
      })
      .select("id")
      .single();
    if (ve) throw new Error(`could not make variant ${n}: ${ve.message}`);
    variants[n] = v.id;
    // As Tanish's rows were: available moved by webhooks, the rest frozen.
    await admin.from("inventory_levels").insert({
      store_id: store.id,
      variant_id: v.id,
      location_id: LOC,
      location_name: "Warehouse",
      available: 64,
      on_hand: 108,
      committed: 1,
      incoming: 0,
      updated_at: new Date(Date.UTC(2026, 9, n)).toISOString(),
    });
  }
  const due = async () => {
    const { data } = await admin.from("stock_refresh_due").select("variant_id, due_at").eq("store_id", store.id);
    return new Map((data ?? []).map((d) => [d.variant_id, d.due_at]));
  };
  const mark = (topic, body, shop = SHOP) =>
    admin.rpc("abo_stock_mark", { p_shop: shop, p_topic: topic, p_body: body });

  console.log("\nwhat a webhook marks");
  const { data: one } = await mark("inventory_levels/update", {
    inventory_item_id: 101,
    location_id: 1,
    available: 63,
  });
  check("a stock level marks its variant, found by inventory item", one === 1 && (await due()).has(variants[1]));
  const { data: two } = await mark("orders/create", {
    line_items: [{ variant_id: 2 }, { variant_id: 3 }, { variant_id: 999 }, { variant_id: null }],
  });
  check("an order marks its lines' variants, and none it does not have", two === 2);
  const { data: ful } = await mark("fulfillments/create", { line_items: [{ variant_id: 1 }] });
  check("a fulfilment marks its lines too", ful === 1);
  const { data: none } = await mark("products/update", { id: 1, variants: [{ inventory_item_id: 101 }] });
  check("a topic that cannot move stock marks nothing", none === 0);
  const { data: elsewhere } = await mark("orders/create", { line_items: [{ variant_id: 2 }] }, "nobody.myshopify.com");
  check("nor does a shop that is not here", elsewhere === 0);
  const { data: odd, error: oddError } = await mark("orders/updated", { line_items: { not: "a list" } });
  check("an odd payload marks nothing and stops nothing", odd === 0 && !oddError);

  console.log("\nwho reaches the marks");
  const { data: ticket } = await admin.rpc("abo_import_mint", { p_store: store.id });
  const worker = holding(ticket);
  const { data: seen } = await worker.from("stock_refresh_due").select("variant_id").eq("store_id", store.id);
  check("the store's own ticket", seen?.length === 3);
  const signedIn = createClient(URL_, ANON, { auth: { persistSession: false } });
  await signedIn.auth.signInWithPassword({ email: `stock_${stamp}@example.com`, password: `pw_${stamp}_aA1!` });
  const { data: theirs } = await signedIn.from("stock_refresh_due").select("variant_id").eq("store_id", store.id);
  check("not the owner signed in", (theirs ?? []).length === 0);
  const { data: blind } = await holding("x".repeat(64)).from("stock_refresh_due").select("variant_id");
  check("nor a made-up ticket", (blind ?? []).length === 0);

  console.log("\na count");
  const token = { id: store.id, shop_domain: SHOP, access_token: "tok", refresh_token: null, token_expires_at: null };
  const asked = [];
  shopify = async (body) => {
    asked.push(body.variables.ids);
    // A webhook for variant 2 lands while Shopify is answering the first page.
    if (asked.length === 1) await mark("orders/updated", { line_items: [{ variant_id: 2 }] });
    return json(200, {
      data: {
        nodes: body.variables.ids.map((id) =>
          id.endsWith("/3") ? null : counted(Number(id.split("/").pop()), { available: 60, on_hand: 61, committed: 1 })
        ),
      },
    });
  };
  const more = await refreshStock(worker, token, Date.now() + 60_000);
  check("asks Shopify for every due variant", asked[0]?.length === 3);
  check(
    "and once more for the one marked again mid-count",
    asked.length === 2 && asked[1].join() === gid("ProductVariant", 2)
  );
  check("until none is due", more === false && (await due()).size === 0);
  const { data: level } = await admin
    .from("inventory_levels")
    .select("available, on_hand, committed, updated_at")
    .eq("variant_id", variants[1])
    .single();
  check(
    "writing all four numbers, as Shopify counts them",
    level?.available === 60 && level?.on_hand === 61 && level?.committed === 1
  );
  check("as of now", Date.now() - Date.parse(level?.updated_at) < 60_000);
  const { data: gone } = await admin.from("inventory_levels").select("on_hand").eq("variant_id", variants[3]).single();
  check("a variant Shopify no longer has is settled, untouched", gone?.on_hand === 108);

  console.log("\na page Shopify refuses");
  await mark("orders/create", { line_items: [{ variant_id: 1 }] });
  shopify = async () => json(401, { errors: "[API] Invalid API key or access token" });
  let refused = null;
  try {
    await refreshStock(worker, token, Date.now() + 60_000);
  } catch (e) {
    refused = e;
  }
  const later = (await due()).get(variants[1]);
  check("says so to the worker", refused !== null);
  check("and waits a quarter of an hour", !!later && Date.parse(later) > Date.now() + 14 * 60_000);
  await admin.from("stock_refresh_due").delete().eq("store_id", store.id);

  console.log("\nthe stock webhook");
  const { data: before } = await admin
    .from("inventory_levels")
    .select("updated_at")
    .eq("variant_id", variants[2])
    .single();
  await admin.rpc("abo_shopify_set_inventory", {
    p_shop: SHOP,
    p_level: { inventory_item_id: 102, location_id: 1, available: 7, updated_at: new Date().toISOString() },
  });
  const { data: after } = await admin
    .from("inventory_levels")
    .select("available, updated_at")
    .eq("variant_id", variants[2])
    .single();
  check(
    "moves available, and leaves when the row was last counted whole",
    after?.available === 7 && after?.updated_at === before?.updated_at
  );

  console.log("\nthe nightly share");
  await admin.from("inventory_levels").update({ updated_at: "2026-01-01T00:00:00Z" }).eq("variant_id", variants[3]);
  const { data: share } = await admin.rpc("abo_stock_recount", { p_store: store.id, p_most: 1 });
  const marked = await due();
  check("marks the variants counted longest ago", share === 1 && marked.has(variants[3]) && marked.size === 1);
} finally {
  globalThis.fetch = realFetch;
  if (projectId) await admin.from("projects").delete().eq("id", projectId);
  await admin.auth.admin.deleteUser(owner.id);
}

console.log(failed ? `\n${failed} failed` : "\nstock is counted whole, whatever moved it");
process.exit(failed ? 1 : 0);
