// Rows we hold that Shopify no longer has.
//
// Webhooks are how the store stays current, and a delete that is never
// delivered leaves a row here for good. Reconciliation only upserts,
// so walking Shopify again does not remove it either — the app simply
// goes on showing a product the merchant deleted last week.
//
// A pass has just read the whole of Shopify, so what it imported IS
// Shopify's count: the gap needs no second API call to find. But only
// for rows the pass could have seen. One a webhook brought in after the
// pass began is new, not gone, and an order older than Shopify's
// sixty-day window was never going to come back; both used to put
// "Some rows are gone from Shopify" on a store that had lost nothing.
//
// It is reported and never acted on. A page that failed quietly, or a
// bulk file that came back short, looks exactly like a deletion, and a
// wrong delete does not come back. Ending the silence is the fix; the
// sweep would be a worse problem wearing its clothes.
//
// On a throwaway store with the seeded shop in it, every resource done,
// so the step reaches the finished branch and asks Shopify nothing.
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

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(
  createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY),
  env
);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const project = await throwawayProject(admin, me.user.id, "drift");
const DAY = 86_400_000;
const later = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await later(1100);
  const began = new Date().toISOString();
  await admin.from("import_runs").insert(
    RESOURCES.map((resource) => ({
      store_id: store.id,
      resource,
      status: "done",
      imported: nodes[resource].length,
      started_at: began,
      finished_at: began,
    }))
  );
  const rowsOf = async (table) =>
    (await admin.from(table).select("id", { count: "exact", head: true }).eq("store_id", store.id)).count ?? 0;
  const setRun = (resource, patch) =>
    admin.from("import_runs").update(patch).eq("store_id", store.id).eq("resource", resource);
  const step = async () => (await importStep(admin, store, {})).body;
  // An order of its own: no lines, refunds or payments to share ids with the seed's.
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
  const products = await rowsOf("products");

  console.log("a pass that brought back everything we hold");
  const agreed = await step();
  check("says it is done", agreed.done === true);
  check("and reports no drift at all", agreed.drift === undefined);
  check("nor a warning about it", agreed.drift_note === undefined);

  console.log("\na pass that came back two products short");
  // What a delete webhook that never arrived leaves behind.
  await setRun("products", { imported: products - 2 });
  const short = await step();
  check("the gap is named", short.drift?.products?.holding === products);
  check("against what the pass brought", short.drift?.products?.imported === products - 2);
  check("and it is said plainly", /removed there/i.test(short.drift_note ?? ""));
  check("a resource that agrees is not mentioned", short.drift?.customers === undefined);

  // Stock is never compared this way. A pass counts variants and the
  // table holds levels, so a store with two locations would be told
  // for ever that rows had gone missing — which is what happened.
  await setRun("inventory", { imported: 1 });
  check("stock is never counted this way at all", (await step()).drift?.inventory === undefined);

  // More here than the pass brought is a loss. Fewer is a webhook that
  // landed mid-pass, and must not read as one.
  await setRun("products", { imported: products + 5 });
  check("a pass that brought back more is not a loss", (await step()).drift?.products === undefined);

  console.log("\nrows the pass could not have seen");
  await setRun("products", { imported: products });
  const orders = await rowsOf("orders");
  // An order by webhook after the pass began: in Shopify, and not in the pass.
  await SHOPIFY_RESOURCES.orders.save(admin, store.id, [anOrder(1, new Date().toISOString())]);
  check("an order that came in after the pass began is not a loss", (await step()).drift?.orders === undefined);
  // The same order, had it been here before the pass began.
  await setRun("orders", { started_at: new Date(Date.now() + 1000).toISOString() });
  const missed = await step();
  check("an order the pass did not bring back still is", missed.drift?.orders?.holding === orders + 1);

  // Ninety days old, held since before the pass: outside the sixty days
  // Shopify hands back without read_all_orders, so no pass returns it.
  await SHOPIFY_RESOURCES.orders.save(admin, store.id, [anOrder(2, new Date(Date.now() - 90 * DAY).toISOString())]);
  await setRun("orders", { imported: orders + 1, started_at: new Date(Date.now() + 1000).toISOString() });
  check("an order older than the window Shopify returns is not a loss", (await step()).drift?.orders === undefined);

  console.log("\na recheck starts the pass again");
  await later(1100);
  const asked = new Date().toISOString();
  await importStep(admin, store, { recheck: true });
  const { data: restarted } = await admin.from("import_runs").select("started_at").eq("store_id", store.id);
  check(
    "every resource's pass begins at the recheck",
    (restarted ?? []).length === RESOURCES.length &&
      (restarted ?? []).every((r) => Date.parse(r.started_at) >= Date.parse(asked))
  );

  // The whole point of reporting rather than sweeping.
  check("and nothing was deleted", (await rowsOf("products")) === products);
} finally {
  await project.remove();
}

console.log(fails.length === 0 ? "\nwhat is missing is said, not swept" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
