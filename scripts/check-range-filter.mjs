// A price between a lowest and a highest (0194, Tanish, 6 Oct): read as
// the merchant reads a section, on the seeded shop. A filter over a
// number or an amount is a Min and a Max, either left open, across the
// whole list from the server: the store's own total, a field of the
// merchant's beside each order, and a section of their own; the cards
// count the same rows the table lists, and a blank is in no range.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-range-filter.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedShop } from "./fixtures/seed-shop.ts";
import { STORE_TABLES, readStorePage, readStoreRows } from "../src/lib/store-read.ts";
import { inRange, readRange } from "../src/lib/filters.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") throw new Error("not the check project's env; this writes");

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const db = createClient(url, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${me.session.access_token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const project = await throwawayProject(admin, me.user.id, "range filter");

const section = async (name, source_table, columns, filters) => {
  const { data: mod, error } = await admin
    .from("modules")
    .insert({ project_id: project.id, name, nav_label: name, icon: "table", route: `/${name}`, source_table })
    .select("id")
    .single();
  if (error) throw new Error(`could not make ${name}: ${error.message}`);
  await admin
    .from("ui_schemas")
    .insert({ module_id: mod.id, schema_json: { columns, features: { filters } }, version: 1, created_by: "user" });
  return mod.id;
};
const count = async (moduleId, scope) =>
  (
    await db.rpc("abo_section_stats", {
      p_module: moduleId,
      p_stats: [{ op: "count" }],
      p_scope: { search: "", search_fields: [], filters: {}, computed: [], currency_fields: [], ...scope },
    })
  ).data?.[0]?.count;

try {
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `range-${project.id.slice(0, 8)}.myshopify.com`,
      access_token: "opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      country: "IN",
      last_synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make the store: ${error.message}`);
  await seedShop(admin, store.id);
  const all = (await readStoreRows(db, store.id, "orders", 200)).rows.map((r) => r.data);
  const totals = all.map((o) => Number(o.total)).sort((a, b) => a - b);
  // A band with orders on both sides of it, from what the shop holds.
  const low = totals[Math.floor(totals.length / 4)];
  const high = totals[Math.floor((totals.length * 3) / 4)];
  const inside = (r) => all.filter((o) => inRange(o.total, readRange(r))).length;

  const cols = STORE_TABLES.orders.columns;
  const orders = await section(
    "range-orders",
    "orders",
    [{ field: "weight", label: "Weight", type: "number" }],
    [{ field: "total", label: "Total", options: [] }]
  );
  const page = (filters, columns = cols) =>
    readStorePage(db, orders, "orders", { page: 0, size: 200, search: "", filters, sort: null }, null, columns, null, [
      "total",
      "status",
    ]);

  console.log("the store's own total, between a lowest and a highest");
  const band = `${low}..${high}`;
  const between = await page({ total: band });
  check(
    `${low} to ${high}: the orders inside, and only them`,
    between.total === inside(band) && between.rows.every((r) => r.data.total >= low && r.data.total <= high)
  );
  check("some orders are outside it, so it narrowed", between.total > 0 && between.total < all.length);
  check("from a lowest up", (await page({ total: `${high}..` })).total === inside(`${high}..`));
  check("up to a highest", (await page({ total: `..${low}` })).total === inside(`..${low}`));
  check(
    "beside another filter, both hold",
    (await page({ total: band, status: all[0].status })).total ===
      all.filter((o) => o.status === all[0].status && inRange(o.total, readRange(band))).length
  );
  check("a range asks for no list of values", !("total" in (await page({})).facets));
  check(
    "the cards count the rows the table lists",
    (await count(orders, { ranges: { total: { min: low, max: high } } })) === between.total
  );

  console.log("\na field of the merchant's beside each order");
  const ids = between.rows.slice(0, 3).map((r) => r.id);
  const { error: recErr } = await admin.from("records").insert([
    { project_id: project.id, module_id: orders, store_row_id: ids[0], data: { weight: 2.5 } },
    { project_id: project.id, module_id: orders, store_row_id: ids[1], data: { weight: "7" } },
    { project_id: project.id, module_id: orders, store_row_id: ids[2], data: { weight: "" } },
  ]);
  if (recErr) throw new Error(`could not add the weights: ${recErr.message}`);
  const withWeight = [...cols, { field: "weight", label: "Weight", type: "number" }];
  const heavy = await page({ weight: "2.." }, withWeight);
  check(
    "its own number, typed as a number or as words: both found",
    heavy.total === 2 && heavy.rows.every((r) => ids.slice(0, 2).includes(r.id))
  );
  check("a blank is in no range, not 0", (await page({ weight: "..1" }, withWeight)).total === 0);
  check("the cards count them too", (await count(orders, { ranges: { weight: { min: 2 } } })) === 2);

  console.log("\na section of their own");
  const price = { field: "price", label: "Price", type: "currency" };
  const catalogue = await section(
    "range-catalogue",
    null,
    [{ field: "name", label: "Name", type: "text" }, price],
    [{ field: "price", label: "Price", options: [] }]
  );
  await admin.from("records").insert(
    [
      ["Mug", 300],
      ["Lamp", 1299],
      ["Rug", "₹ 2,400"],
      ["Quote", "on request"],
      ["Gift", null],
    ].map(([name, p]) => ({ project_id: project.id, module_id: catalogue, data: { name, price: p } }))
  );
  check(
    "its cards count the rows inside: 1,299 and ₹ 2,400",
    (await count(catalogue, { ranges: { price: { min: 1000 } } })) === 2
  );
  check("and a word or a blank is in none", (await count(catalogue, { ranges: { price: { max: 100000 } } })) === 3);
} finally {
  await project.remove();
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\na price between two, across the whole list");
process.exit(fails.length ? 1 : 0);
