// A figure over the whole store (0129), counted in the database.
//
// "Revenue by week for six months" was a page of orders and the model's
// own arithmetic. store_metrics counts every order the store holds, by
// one measure and one dimension, in a window, under a few filters. This
// holds the tool to the seeded shop's own rows, the two lists (TypeScript
// and SQL) to each other, and the door to the merchant.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-metrics.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedShop } from "./fixtures/seed-shop.ts";
import { STORE_METRICS } from "../src/lib/store-read.ts";
import { storeTool } from "../src/lib/store-tools.ts";

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
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 300));

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, anonKey), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const owner = createClient(url, anonKey, {
  global: { headers: { Authorization: `Bearer ${me.session.access_token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const project = await throwawayProject(admin, me.user.id, "store metrics");
const inZone = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

try {
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `metrics-${project.id.slice(0, 8)}.myshopify.com`,
      access_token: "opens-nothing",
      currency: "INR",
      timezone: "Asia/Kolkata",
      country: "IN",
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make the store: ${error.message}`);
  await seedShop(admin, store.id);
  const ctx = {
    db: owner,
    store: {
      id: store.id,
      project_id: project.id,
      shop_domain: "",
      timezone: "Asia/Kolkata",
      currency: "INR",
      last_synced_at: null,
    },
  };
  const tool = storeTool("store_metrics");
  const ask = (args) => tool.run(args, ctx);

  // What the shop holds, straight from its rows.
  const { data: orders } = await admin
    .from("orders")
    .select("id, total, placed_at, cancelled_at, financial_status, ship_city, customer_id")
    .eq("store_id", store.id);
  const live = orders.filter((o) => !o.cancelled_at);
  const sum = (rows) => rows.reduce((s, o) => s + Number(o.total ?? 0), 0);

  console.log("one figure over the whole store");
  const revenue = await ask({ measure: "revenue" });
  check("revenue is the sum of every uncancelled order", Math.abs(Number(revenue.total.value) - sum(live)) < 0.01);
  check("and says how many that was", revenue.total.orders === live.length);
  check(
    "in the store's currency, cancelled left out",
    revenue.currency === "INR" && revenue.cancelled_included === false
  );
  const all = await ask({ measure: "orders", filters: { include_cancelled: true } });
  check("asked for, cancelled orders count too", all.total.orders === orders.length);
  if (fails.length) show({ revenue, all: all.total, live: live.length, orders: orders.length });

  console.log("\nbroken down");
  const byMonth = await ask({ measure: "orders", by: "month" });
  const months = new Set(live.map((o) => inZone(o.placed_at).slice(0, 7)));
  check(
    "by month, one group per month with orders, in order",
    byMonth.groups.length === months.size && byMonth.groups.every((g, i, a) => i === 0 || g.key > a[i - 1].key)
  );
  check("the groups add up to the total", byMonth.groups.reduce((s, g) => s + g.orders, 0) === live.length);
  const byCity = await ask({ measure: "revenue", by: "city" });
  const cities = new Set(live.map((o) => o.ship_city ?? "—"));
  check(
    "by city, biggest first",
    byCity.groups.length === cities.size &&
      byCity.groups.every((g, i, a) => i === 0 || Number(g.value) <= Number(a[i - 1].value))
  );
  const { data: lines } = await admin
    .from("order_line_items")
    .select("order_id, quantity, price")
    .eq("store_id", store.id);
  const liveIds = new Set(live.map((o) => o.id));
  const liveLines = lines.filter((l) => liveIds.has(l.order_id));
  const units = liveLines.reduce((s, l) => s + l.quantity, 0);
  const byProduct = await ask({ measure: "units", by: "product" });
  check("units per product add up to every line", byProduct.groups.reduce((s, g) => s + Number(g.value), 0) === units);
  const productRevenue = await ask({ measure: "revenue", by: "product" });
  const lineValue = liveLines.reduce((s, l) => s + Number(l.price ?? 0) * l.quantity, 0);
  check(
    "revenue per product is the value of its lines",
    Math.abs(productRevenue.groups.reduce((s, g) => s + Number(g.value), 0) - lineValue) < 0.01
  );
  if (fails.length)
    show({ byMonth: byMonth.groups, byCity: byCity.groups.slice(0, 3), units, byProduct: byProduct.groups });

  console.log("\na window and a filter");
  const day = inZone(live.map((o) => o.placed_at).sort()[0]);
  const onDay = await ask({ measure: "orders", from: day, to: day });
  const expectDay = live.filter((o) => inZone(o.placed_at) === day).length;
  check("a single day, in the store's own time", onDay.total.orders === expectDay && onDay.total.orders > 0);
  const pending = await ask({ measure: "orders", filters: { status: "PENDING" } });
  check(
    "a status filter, spelled as the store spells it",
    pending.total.orders === live.filter((o) => o.financial_status === "PENDING").length
  );
  const customers = await ask({ measure: "customers" });
  check(
    "customers are counted once each",
    customers.total.value === new Set(live.map((o) => o.customer_id).filter(Boolean)).size
  );
  const backwards = await ask({ measure: "orders", from: "2026-09-10", to: "2026-09-01" }).catch((e) => ({
    error: e.message,
  }));
  check("a window that ends before it starts is refused", /ends before/.test(backwards.error ?? ""));
  check(
    "a date that is not one is refused",
    /not a date/.test((await ask({ measure: "orders", from: "yesterday" })).error ?? "")
  );
  check("a measure that is not one is refused", /not a measure/.test((await ask({ measure: "profit" })).error ?? ""));

  console.log("\nspelling is not held against the asker");
  const pendingRows = await storeTool("search_orders").run({ status: "pending" }, ctx);
  check(
    'search_orders asked for "pending" finds the PENDING orders',
    pendingRows.count > 0 && pendingRows.count === pending.total.orders
  );
  if (fails.length) show({ search: pendingRows.count, metrics: pending.total.orders });

  console.log("\nthe two lists agree");
  for (const m of Object.keys(STORE_METRICS.measures)) {
    const got = await ask({ measure: m });
    check(`measure ${m} is one to the database too`, got.measure === m);
  }
  for (const d of Object.keys(STORE_METRICS.dimensions)) {
    const got = await ask({ measure: "orders", by: d });
    check(`dimension ${d} is one to the database too`, got.by === d);
  }

  console.log("\nthe door");
  const stranger = await createClient(url, anonKey, { auth: { persistSession: false } }).rpc("abo_store_metrics", {
    p_store: store.id,
    p_measure: "revenue",
  });
  check("nobody signed in gets nothing", !!stranger.error);
  const elsewhere = await owner.rpc("abo_store_metrics", { p_store: crypto.randomUUID(), p_measure: "revenue" });
  check("a store that is not theirs is not found", /No such store/.test(elsewhere.error?.message ?? ""));
} finally {
  await project.remove();
}

console.log(
  fails.length === 0 ? "\na figure is counted over the whole store, in the database" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
