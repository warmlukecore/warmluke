// An order carries its shipment, and what was given back (0193, Tanish,
// 6 Oct): read as the merchant reads the orders list, on the seeded shop.
// Each order says its latest shipment's status, courier, tracking number,
// shipped and delivered days, and how many shipments it went in; a refunded
// one what was refunded; a cancelled or refunded order what it was worth,
// never a bare 0. The list filters by shipment status and finds an order by
// its tracking number, across the whole list, from the server.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-order-shipments.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { seedShop } from "./fixtures/seed-shop.ts";
import { STORE_TABLES, readStorePage, readStoreRows } from "../src/lib/store-read.ts";

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
const project = await throwawayProject(admin, me.user.id, "order shipments");

try {
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      project_id: project.id,
      provider: "shopify",
      status: "connected",
      shop_domain: `ships-${project.id.slice(0, 8)}.myshopify.com`,
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

  const { rows } = await readStoreRows(db, store.id, "orders", 100);
  const all = rows.map((r) => r.data);
  const by = (pred) => all.find(pred);

  console.log("an order says where it is");
  const shipped = by((o) => o.shipment_status === "DELIVERED" && o.delivered_at);
  check(
    "its latest shipment: status, courier, tracking, shipped and delivered days, how many",
    !!shipped &&
      !!shipped.carrier &&
      !!shipped.tracking_number &&
      /^\d{4}-\d{2}-\d{2}$/.test(shipped.shipped_at) &&
      shipped.shipments === 1
  );
  const unsent = by((o) => !o.shipment_status);
  check(
    "one not yet sent says nothing, not a wrong status",
    !!unsent && unsent.shipments === null && unsent.carrier === null
  );

  console.log("\nnever a bare 0 for an order that was worth more");
  const refunded = by((o) => o.financial_status === "REFUNDED");
  check(
    "a refunded order: 0 now, what it was, and what was given back",
    Number(refunded?.total) === 0 && Number(refunded?.total_original) > 0 && Number(refunded?.refunded) > 0
  );
  const part = by((o) => o.financial_status === "PARTIALLY_REFUNDED");
  check(
    "a part refund: what is left, what it was, what went back, adding up",
    Number(part?.total) + Number(part?.refunded) === Number(part?.total_original)
  );
  const cancelled = by((o) => o.status === "Cancelled");
  check(
    "a cancelled order: 0 now, and what it was worth",
    Number(cancelled?.total) === 0 && Number(cancelled?.total_original) > 0
  );
  check(
    "the total column says what it was, beside the 0",
    STORE_TABLES.orders.columns.find((c) => c.field === "total")?.was === "total_original"
  );

  console.log("\nfound and narrowed by it, across the whole list");
  const { data: mod } = await admin
    .from("modules")
    .insert({
      project_id: project.id,
      name: "ships-orders",
      nav_label: "Orders",
      icon: "table",
      route: "/ships-orders",
      source_table: "orders",
    })
    .select("id")
    .single();
  await admin
    .from("ui_schemas")
    .insert({ module_id: mod.id, schema_json: { columns: [] }, version: 1, created_by: "user" });
  const page = (state) =>
    readStorePage(
      db,
      mod.id,
      "orders",
      { page: 0, size: 50, search: "", filters: {}, sort: null, ...state },
      null,
      STORE_TABLES.orders.columns,
      null,
      []
    );
  const delivered = all.filter((o) => o.shipment_status === "DELIVERED").length;
  const onlyDelivered = await page({ filters: { shipment_status: "DELIVERED" } });
  check(
    "filtered by shipment status, from the server",
    onlyDelivered.total === delivered && onlyDelivered.rows.every((r) => r.data.shipment_status === "DELIVERED")
  );
  const found = await page({ search: shipped.tracking_number });
  check(
    "an order found by its tracking number",
    found.rows.some((r) => r.data.order_number === shipped.order_number)
  );

  console.log("\nan order sent in two shipments");
  const { data: order } = await admin
    .from("orders")
    .select("id")
    .eq("store_id", store.id)
    .eq("order_number", shipped.order_number)
    .single();
  const { error: addErr } = await admin.from("fulfillments").insert({
    store_id: store.id,
    order_id: order.id,
    external_id: `gid://shopify/Fulfillment/second-${project.id.slice(0, 8)}`,
    status: "SUCCESS",
    shipment_status: "IN_TRANSIT",
    carrier: "Blue Dart",
    tracking_number: "BD123456789IN",
    shipped_at: new Date().toISOString(),
  });
  if (addErr) throw new Error(`could not add a second shipment: ${addErr.message}`);
  const again = (await readStoreRows(db, store.id, "orders", 100)).rows
    .map((r) => r.data)
    .find((o) => o.order_number === shipped.order_number);
  check(
    "says its latest, and that there were two",
    again?.shipment_status === "IN_TRANSIT" && again?.carrier === "Blue Dart" && again?.shipments === 2
  );
} finally {
  await project.remove();
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\nan order says where it is, and what it was");
process.exit(fails.length ? 1 : 0);
