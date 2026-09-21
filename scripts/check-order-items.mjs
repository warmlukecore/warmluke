// The lines inside the orders are a list of the store's, like the
// orders themselves.
//
// A merchant asked for "a SKU section for my orders" and got a
// hand-typed copy seeded with made-up rows, because no list showed the
// order lines the import had already brought. Now one does: one row
// per SKU per order, read through the same functions as every other
// store list, searchable by SKU or order number, with a cancelled
// order's lines saying so, and a section that can be built over it and
// counted on the server.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-order-items.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { readStoreRows, STORE_TABLES } from "../src/lib/store-read.ts";
import { buildSystemPrompt } from "../src/lib/ai.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const must = ({ error, data }) => {
  if (error) throw new Error(error.message);
  return data;
};

console.log("the list is declared once, and the prompt reads it from there");
{
  const spec = STORE_TABLES.order_line_items;
  check("order items are one of the store's lists", !!spec && spec.view === "store_order_items");
  const prompt = buildSystemPrompt([], "Test", "en-IN", "INR", null).join("\n");
  for (const [table, s] of Object.entries(STORE_TABLES)) {
    check(`the prompt says what "${table}" means, in the list's own words`, prompt.includes(`"${table}" — ${s.what}`));
  }
  check(
    "and the source_table choices are the same list",
    prompt.includes(`"source_table": "<${Object.keys(STORE_TABLES).join("|")}`)
  );
}

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const me = await signInAsCheckUser(client, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const project = await throwawayProject(admin, me.user.id, "order-items");
const stamp = Date.now().toString(36);

try {
  const store = must(
    await admin
      .from("stores")
      .insert({
        project_id: project.id,
        shop_domain: `items-${stamp}.myshopify.com`,
        status: "connected",
        currency: "INR",
        timezone: "Asia/Kolkata",
      })
      .select("id")
      .single()
  );
  const [aman] = must(
    await admin
      .from("customers")
      .insert([{ store_id: store.id, external_id: `c-${stamp}`, name: "Aman Kumar", orders_count: 2, total_spent: 3494 }])
      .select("id")
  );
  const order = async (n, extra = {}) =>
    must(
      await admin
        .from("orders")
        .insert({
          store_id: store.id,
          external_id: `o-${stamp}-${n}`,
          order_number: `#${n}`,
          placed_at: new Date(Date.now() - n * 3600e3).toISOString(),
          total: 100 * n,
          currency: "INR",
          financial_status: "PENDING",
          customer_id: aman.id,
          tags: [],
          ...extra,
        })
        .select("id")
        .single()
    ).id;
  const o1 = await order(1001);
  const o2 = await order(1002, { cancelled_at: new Date().toISOString() });
  must(
    await admin.from("order_line_items").insert([
      { store_id: store.id, order_id: o1, title: "Boat Airdopes 141", variant_title: "Black", sku: "BA141-BLK", quantity: 2, price: 1299 },
      { store_id: store.id, order_id: o1, title: "Clear Phone Case", sku: "CASE-M", quantity: 1, price: 299 },
      { store_id: store.id, order_id: o2, title: "Boat Airdopes 141", variant_title: "Black", sku: "BA141-BLK", quantity: 3, price: 1299 },
    ])
  );

  console.log("\nread like any other store list");
  const all = await readStoreRows(admin, store.id, "order_line_items", 50);
  check("one row per SKU per order", all.total === 3 && all.rows.length === 3);
  const first = all.rows[0].data;
  check(
    "each carries its order's number, day and customer",
    first.order_number?.startsWith("#") && /^\d{4}-\d{2}-\d{2}$/.test(first.placed_at) && first.customer_name === "Aman Kumar"
  );
  check("and the line's own total", all.rows.some((r) => r.data.sku === "CASE-M" && Number(r.data.line_total) === 299));
  const cancelled = all.rows.find((r) => r.data.order_number === "#1002");
  check("a cancelled order's line says so, and is still here", cancelled?.data.status === "Cancelled");

  const bySku = await readStoreRows(admin, store.id, "order_line_items", 50, "BA141");
  check("searchable by SKU", bySku.rows.length === 2 && bySku.rows.every((r) => r.data.sku === "BA141-BLK"));
  const byOrder = await readStoreRows(admin, store.id, "order_line_items", 50, "#1001");
  check(
    "and by order number — the SKU list for one order",
    byOrder.rows.length === 2 && byOrder.rows.every((r) => r.data.order_number === "#1001")
  );

  console.log("\na section over it, built through the one door");
  const built = await client.rpc("abo_build", {
    p_project: project.id,
    p_request: null,
    p_op: "module_insert",
    p_payload: { name: "order-items", nav_label: "Order items", route: "/modules/order-items", source_table: "order_line_items", icon: "receipt" },
  });
  check("the owner can build one", !built.error && !!built.data?.id);
  if (built.error) console.log("     →", built.error.message);

  console.log("\nand counted on the server");
  const stats = await client.rpc("abo_section_stats", {
    p_module: built.data?.id,
    p_stats: [
      { label: "Units", op: "sum", field: "quantity", where: { op: "!=", args: [{ field: "status" }, { const: "Cancelled" }] } },
      { label: "Lines", op: "count" },
    ],
    p_scope: {},
  });
  if (stats.error) console.log("     →", stats.error.message);
  // One result per stat, in the order asked.
  const out = stats.data ?? [];
  check("units of live lines add up, the cancelled order left out", Number(out[0]?.value) === 3);
  check("and every line is counted", out[1]?.count === 3);
} finally {
  await project.remove();
}

console.log(fails.length === 0 ? "\nthe order items are a list of the store's" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
