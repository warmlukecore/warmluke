// Rows we hold that Shopify no longer has.
//
// Webhooks are how the store stays current, and a delete that is never
// delivered leaves a row here for good. Reconciliation only upserts, so
// walking Shopify again did not remove it either: the app went on
// showing a product the merchant deleted last week, under a warning
// whose one button could not clear it.
//
// Every write marks its row seen (0123). A row the last finished pass
// did not see is named on the strip; one the pass before missed too is
// removed, the way a delete webhook removes it, and comes back with the
// next pass that brings it. Rows a pass could never have seen are not
// counted: one that arrived after it began, and an order older than
// the sixty days Shopify returns without read_all_orders.
//
// On a throwaway store with the seeded shop in it. A pass here is its
// start (the database stamps it) and every row written again, so the
// step reaches the finished branch and asks Shopify nothing.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-drift.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedNodes, seedShop } from "./fixtures/seed-shop.ts";
import { RESOURCES, SHOPIFY_RESOURCES } from "../src/lib/shopify-resources.ts";
import { importStep } from "../src/lib/import-step.ts";

const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log(`${envFile} does not declare CHECK_PROJECT=1, and this writes; nothing checked`);
  process.exit(0);
}

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
// The strip reads the finished import as the store's owner, and only
// the owner may remove anything.
const owner = createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${me.session.access_token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const project = await throwawayProject(admin, me.user.id, "drift");
const DAY = 86_400_000;
const beat = () => new Promise((r) => setTimeout(r, 50));

try {
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `drift-${project.id.slice(0, 8)}.myshopify.com`,
      access_token: "opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      country: "IN",
      // What a store that was never granted older orders holds.
      granted_scopes: ["read_orders", "read_products", "read_customers"],
    })
    .select("id, shop_domain, access_token")
    .single();
  if (error) throw new Error(`could not make the store: ${error.message}`);
  await seedShop(admin, store.id);
  const nodes = seedNodes();
  await admin.from("import_runs").insert(
    RESOURCES.map((resource) => ({
      store_id: store.id,
      resource,
      status: "done",
      imported: nodes[resource].length,
      finished_at: new Date().toISOString(),
    }))
  );

  const rowsOf = async (table) =>
    (await admin.from(table).select("id", { count: "exact", head: true }).eq("store_id", store.id)).count ?? 0;
  const step = async () => (await importStep(owner, store, {})).body;
  /** A finished pass: it begins, it writes what Shopify still has, it ends. */
  const pass = async ({ without = [] } = {}) => {
    await beat();
    await admin.from("import_runs").update({ started_at: new Date().toISOString() }).eq("store_id", store.id);
    await beat();
    for (const r of RESOURCES) {
      await SHOPIFY_RESOURCES[r].save(
        admin,
        store.id,
        nodes[r].filter((n) => !without.includes(n.id))
      );
    }
    await admin.from("import_runs").update({ finished_at: new Date().toISOString() }).eq("store_id", store.id);
  };
  const products = await rowsOf("products");
  const [first, second] = nodes.products;

  console.log("a pass that saw everything");
  await pass();
  const agreed = await step();
  check("says it is done", agreed.done === true);
  check("and names nothing", agreed.drift === undefined && agreed.drift_note === undefined);
  check("and removes nothing", agreed.removed === undefined);

  console.log("\na pass two products short");
  // What a delete webhook that never arrived leaves behind.
  await pass({ without: [first.id, second.id] });
  const short = await step();
  check("the two are counted", short.drift?.products?.missing === 2);
  check(
    "and named",
    [first.title, second.title].every((t) => short.drift?.products?.examples.includes(t))
  );
  check("and it is said plainly", /deleted there/i.test(short.drift_note ?? ""));
  check("a resource that agrees is not mentioned", short.drift?.customers === undefined);
  check("stock is never counted this way", short.drift?.inventory === undefined);
  check("one short pass removes nothing", short.removed === undefined && (await rowsOf("products")) === products);

  console.log("\nthe same two missing from the next pass as well");
  await pass({ without: [first.id, second.id] });
  const twice = await step();
  check("they are removed", twice.removed?.products === 2 && (await rowsOf("products")) === products - 2);
  check("and no longer named", twice.drift?.products === undefined);
  const { error: refused } = await admin.rpc("abo_store_forget_unseen", { p_store: store.id });
  check("nobody but the owner may remove", /sign in first/.test(refused?.message ?? ""));

  console.log("\na pass that brings them back");
  await pass();
  check("they are here again", (await rowsOf("products")) === products);
  check("and nothing is named", (await step()).drift === undefined);

  console.log("\nrows no pass could have seen");
  const orders = await rowsOf("orders");
  // An order by webhook after the pass began: in Shopify, and not in the pass.
  const anOrder = (n, at) => ({
    ...nodes.orders[0],
    id: `gid://shopify/Order/${99999000 + n}`,
    name: `#${9000 + n}`,
    createdAt: at,
    updatedAt: at,
    lineItems: { nodes: [] },
    refunds: [],
    transactions: [],
  });
  await SHOPIFY_RESOURCES.orders.save(admin, store.id, [anOrder(1, new Date().toISOString())]);
  check("an order that came in after the pass began is not named", (await step()).drift?.orders === undefined);
  // No pass below writes it, so it would be missed twice and taken; out
  // of the way, so the next case is about the window alone.
  await admin.from("orders").delete().eq("store_id", store.id).eq("order_number", "#9001");
  // Ninety days old: outside the window, so no pass returns it, and two
  // passes that miss it neither name it nor take it.
  await SHOPIFY_RESOURCES.orders.save(admin, store.id, [anOrder(2, new Date(Date.now() - 90 * DAY).toISOString())]);
  await pass();
  await pass();
  const aged = await step();
  check("an order older than the window is not named", aged.drift?.orders === undefined);
  check("nor removed", (await rowsOf("orders")) >= orders + 1);

  console.log("\na pass that stopped half way is no evidence");
  await pass({ without: [first.id] });
  await admin.from("import_runs").update({ status: "failed" }).eq("store_id", store.id).eq("resource", "products");
  await pass({ without: [first.id] });
  await admin.from("import_runs").update({ status: "done" }).eq("store_id", store.id).eq("resource", "products");
  const stopped = await step();
  check("a row it missed is named", stopped.drift?.products?.missing === 1);
  check("but not removed on its word", stopped.removed === undefined && (await rowsOf("products")) === products);

  console.log("\na recheck starts the pass");
  await beat();
  const before = (
    await admin.from("import_runs").select("started_at").eq("store_id", store.id).eq("resource", "orders").single()
  ).data.started_at;
  await importStep(owner, store, { recheck: true });
  const after = (
    await admin
      .from("import_runs")
      .select("started_at, prev_started_at")
      .eq("store_id", store.id)
      .eq("resource", "orders")
      .single()
  ).data;
  check("its clock moves on", Date.parse(after.started_at) > Date.parse(before));
  check("and the finished pass before it is kept", after.prev_started_at === before);
} finally {
  await project.remove();
}

console.log(fails.length === 0 ? "\nwhat is missing is named, and gone once it is sure" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
