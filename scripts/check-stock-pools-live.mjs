// Stock by SKU, seen (0213, docs/domain/stock-by-sku.md phase 1).
//
// A store's SKUs listed more than once, made from a blank, or a blank
// with designs on it, one row each: how many listings, the count a pool
// would start from (the lowest), how far apart, and what could be sold
// (own plus the blank's, for a design). A blank is any field of the
// owner's on a stock row naming another SKU of the store, whatever it is
// called. Read through the view and through abo_store_page as a section
// reads it; a stranger sees nothing.
//
//   ENV_FILE=.env.check.local node scripts/check-stock-pools-live.mjs
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
const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let failed = 0;
const check = (what, ok) => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) failed++;
};
const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

const stamp = Date.now();
async function person(tag) {
  const email = `pools_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_aA1!`;
  const made = must(await admin.auth.admin.createUser({ email, password, email_confirm: true }), tag);
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  must(await client.auth.signInWithPassword({ email, password }), `sign in ${tag}`);
  return { id: made.user.id, client };
}

const gid = (type, n) => `gid://shopify/${type}/${n}`;
const LOC = gid("Location", 1);
const owner = await person("owner");
const stranger = await person("stranger");
let projectId = null;
try {
  projectId = must(
    await admin
      .from("projects")
      .insert({ owner_id: owner.id, name: `pools-check ${stamp}` })
      .select("id")
      .single(),
    "project"
  ).id;
  const store = must(
    await admin
      .from("stores")
      .insert({ project_id: projectId, shop_domain: `pools-${stamp}.myshopify.com`, status: "connected" })
      .select("id")
      .single(),
    "store"
  );
  let n = 0;
  // One listing: a product with one variant of this SKU, its stock at the one location.
  const listing = async (title, sku, available, extra = {}) => {
    n += 1;
    const product = must(
      await admin
        .from("products")
        .insert({ store_id: store.id, external_id: gid("Product", n), title })
        .select("id")
        .single(),
      `product ${title}`
    );
    const variant = must(
      await admin
        .from("variants")
        .insert({
          store_id: store.id,
          product_id: product.id,
          external_id: gid("ProductVariant", n),
          inventory_item_id: gid("InventoryItem", n),
          sku,
          ...extra,
        })
        .select("id")
        .single(),
      `variant ${sku}`
    );
    return must(
      await admin
        .from("inventory_levels")
        .insert({ store_id: store.id, variant_id: variant.id, location_id: LOC, location_name: "Warehouse", available })
        .select("id")
        .single(),
      `stock ${sku}`
    ).id;
  };
  await listing("Clear Case · 17 Pro Max", "SHARED-1", 72);
  await listing("Clear Case · 18 Pro Max", "SHARED-1", 168);
  // Shopify counts nothing for an untracked variant: it is no listing of the pool.
  await listing("Clear Case · sample", "SHARED-1", 999, { tracked: false });
  await listing("Matte Case · 17", "SHARED-2", 10);
  await listing("Matte Case · 18", "SHARED-2", 10);
  await listing("Plain Case", "SOLO", 4);
  await listing("Blank Silicone Case", "BLANK", 64);
  const d1a = await listing("Cherry Design · 17", "D-1", 0);
  const d1b = await listing("Cherry Design · 18", "D-1", 2);
  const d2 = await listing("Daisy Design", "D-2", 5);

  // The owner's own fields on their Stock section: a blank named under any field name.
  const stock = must(
    await admin
      .from("modules")
      .insert({
        project_id: projectId,
        name: `stock-${stamp}`,
        nav_label: "Stock",
        route: `stock-${stamp}`,
        source_table: "inventory_levels",
      })
      .select("id")
      .single(),
    "stock section"
  );
  const own = (row, data) => ({ project_id: projectId, module_id: stock.id, store_row_id: row, data });
  must(
    await admin
      .from("records")
      .insert([
        own(d1a, { parent: "BLANK", note: "hello" }),
        own(d1b, { parent: "BLANK" }),
        own(d2, { made_from: "BLANK", qty: "5" }),
      ]),
    "own fields"
  );

  const read = async (client) => {
    const { data, error } = await client.from("store_stock_pools").select("*").eq("store_id", store.id);
    if (error) throw new Error(`read: ${error.message}`);
    return new Map((data ?? []).map((r) => [r.sku, r]));
  };

  console.log("\nwhat is pooled");
  const pools = await read(owner.client);
  check(
    "a SKU listed twice, a blank and its designs, and nothing listed once with no blank",
    [...pools.keys()].toSorted().join(",") === "BLANK,D-1,D-2,SHARED-1,SHARED-2"
  );

  console.log("\na shared SKU");
  const s1 = pools.get("SHARED-1");
  check("counts its tracked listings only", s1?.listings === 2 && s1?.role === "Shared SKU");
  check("starts from the lowest of them", s1?.start_count === 72 && s1?.highest === 168);
  check("and says they disagree, by how much", s1?.counts === "Disagree" && s1?.spread === 96);
  check("can sell what every listing has", s1?.sellable === 72);
  check("one whose listings agree says so", pools.get("SHARED-2")?.counts === "Same everywhere");

  console.log("\na blank and its designs");
  const blank = pools.get("BLANK");
  check("the blank knows how many designs are made from it", blank?.role === "Blank" && blank?.designs === 2);
  const one = pools.get("D-1");
  check("a design names its blank, from a field of the owner's", one?.role === "Design" && one?.draws_from === "BLANK");
  check(
    "and can sell its own plus the blank's",
    one?.start_count === 0 && one?.blank_available === 64 && one?.sellable === 64
  );
  const two = pools.get("D-2");
  check("whatever the field is called", two?.draws_from === "BLANK" && two?.sellable === 69);

  console.log("\nas every reader reads it");
  const again = await read(owner.client);
  check("each row keeps its id, so the owner's own fields stay with it", again.get("SHARED-1")?.id === s1?.id);
  const section = must(
    await admin
      .from("modules")
      .insert({
        project_id: projectId,
        name: `pools-${stamp}`,
        nav_label: "Stock by SKU",
        route: `pools-${stamp}`,
        source_table: "stock_pools",
      })
      .select("id")
      .single(),
    "pools section"
  );
  const { data: page, error: pageError } = await owner.client.rpc("abo_store_page", {
    p_module: section.id,
    // As the app asks (lib/store-read readStorePage): the list's own order, widest apart first.
    p_query: { offset: 0, limit: 50, order: { field: "spread", dir: "desc" } },
  });
  const paged = page?.total === 5 && page?.rows?.[0]?.data?.sku === "SHARED-1";
  check("a section over it reads it a page at a time, widest apart first", paged);
  if (!paged) console.log("     →", pageError?.message ?? JSON.stringify(page).slice(0, 300));
  check("a stranger sees nothing of it", (await read(stranger.client)).size === 0);
} finally {
  if (projectId) await admin.from("projects").delete().eq("id", projectId);
  await admin.auth.admin.deleteUser(owner.id);
  await admin.auth.admin.deleteUser(stranger.id);
}

console.log(failed ? `\n${failed} failed` : "\nstock by SKU, seen as it is");
process.exit(failed ? 1 : 0);
