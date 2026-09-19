// Who buys most and what sells, over the whole store rather than the
// page that happened to load.
//
// Three customers whose names sort the opposite way to their spend,
// and a page of two: the page has to hold the two biggest spenders,
// not the two earliest names. Then the sales view: an order counts
// unless it was cancelled, a line whose
// product is gone is still a row, and a product's title is today's,
// not the one it sold under. A pending (cash on delivery) order is a
// sale; a cancelled one is not. Then the two lists Luke and a connected
// assistant answer from, and the webhook road for the spend figure.
//
//   node scripts/check-leaders.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { readStoreRows, storeLeaders, STORE_TABLES } from "../src/lib/store-read.ts";
import { storeOverlap } from "../src/lib/describe.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 320));

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const client = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
const me = await signInAsCheckUser(client, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const project = await throwawayProject(admin, me.user.id, "leaders");
const stamp = Date.now().toString(36);
const shop = `leaders-${stamp}.myshopify.com`;
const { data: store, error: storeErr } = await admin
  .from("stores")
  .insert({ project_id: project.id, shop_domain: shop, status: "connected", currency: "INR" })
  .select("id")
  .single();
if (storeErr) throw new Error(storeErr.message);
const sid = store.id;
const must = ({ error }) => {
  if (error) throw new Error(error.message);
};

try {
  // ── Customers: names one way, spend the other ────────────────
  must(
    await admin.from("customers").insert([
      { store_id: sid, external_id: `c-${stamp}-a`, name: "Aarav", orders_count: 1, total_spent: 100 },
      { store_id: sid, external_id: `c-${stamp}-b`, name: "Bhavna", orders_count: 3, total_spent: 5000 },
      { store_id: sid, external_id: `c-${stamp}-c`, name: "Chirag", orders_count: 2, total_spent: 900 },
      // Never synced since the column arrived: no figure, but orders.
      { store_id: sid, external_id: `c-${stamp}-d`, name: "Devi", orders_count: 4, total_spent: null },
    ])
  );

  console.log("a page of customers, cut in the section's own order");
  const byName = await readStoreRows(admin, sid, "customers", 2);
  check("with no sort it is still A-Z", byName.rows.map((r) => r.data.name).join(",") === "Aarav,Bhavna");
  const bySpend = await readStoreRows(admin, sid, "customers", 2, undefined, { field: "total_spent", dir: "desc" });
  check("sorted by spend, the page holds the two biggest spenders", bySpend.rows.map((r) => r.data.name).join(",") === "Bhavna,Chirag");
  check("and says how many there are in all", bySpend.total === 4);
  const asc = await readStoreRows(admin, sid, "customers", 4, undefined, { field: "total_spent", dir: "asc" });
  check("the one with no figure sorts last either way", asc.rows.at(-1)?.data.name === "Devi" && bySpend.rows.every((r) => r.data.name !== "Devi"));
  const bogus = await readStoreRows(admin, sid, "customers", 2, undefined, { field: "customer_name", dir: "desc" });
  check("a field that is not a column of the table falls back to A-Z", bogus.rows[0]?.data.name === "Aarav");
  check("the spend column is on the section", STORE_TABLES.customers.columns.some((c) => c.field === "total_spent" && c.type === "currency"));

  // ── Sales: what counts and what does not ────────────────────
  const { data: prods, error: pErr } = await admin
    .from("products")
    .insert([
      { store_id: sid, external_id: `p-${stamp}-1`, title: "Ski Wax (renamed)", handle: `wax-${stamp}`, status: "ACTIVE" },
      { store_id: sid, external_id: `p-${stamp}-2`, title: "Snowboard", handle: `board-${stamp}`, status: "ACTIVE" },
    ])
    .select("id, title");
  if (pErr) throw new Error(pErr.message);
  const [wax, board] = prods;
  const order = async (ext, financial, cancelled, placed) => {
    const { data, error } = await admin
      .from("orders")
      .insert({
        store_id: sid, external_id: `o-${stamp}-${ext}`, order_number: `#${ext}`, placed_at: placed,
        total: 0, currency: "INR", financial_status: financial, cancelled_at: cancelled,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  };
  const paid1 = await order(1, "PAID", null, "2026-09-01T10:00:00Z");
  const paid2 = await order(2, "PAID", null, "2026-09-10T10:00:00Z");
  const pending = await order(3, "PENDING", null, "2026-09-11T10:00:00Z");
  const cancelled = await order(4, "PAID", "2026-09-12T10:00:00Z", "2026-09-12T09:00:00Z");
  must(
    await admin.from("order_line_items").insert([
      // Wax: 2 + 3 units across two paid orders, sold under its old title.
      { store_id: sid, order_id: paid1, product_id: wax.id, title: "Ski Wax", quantity: 2, price: 100 },
      { store_id: sid, order_id: paid2, product_id: wax.id, title: "Ski Wax", quantity: 3, price: 100 },
      // Board: one paid unit and two awaiting payment count; the
      // cancelled ten do not.
      { store_id: sid, order_id: paid1, product_id: board.id, title: "Snowboard", quantity: 1, price: 9000 },
      { store_id: sid, order_id: pending, product_id: board.id, title: "Snowboard", quantity: 2, price: 9000 },
      { store_id: sid, order_id: cancelled, product_id: board.id, title: "Snowboard", quantity: 10, price: 9000 },
      // A product gone from Shopify: the line still knows what it sold.
      { store_id: sid, order_id: paid2, product_id: null, title: "Old Gloves", quantity: 4, price: 50 },
    ])
  );

  console.log("\nwhat sold, from every order that was not cancelled");
  const sales = await readStoreRows(admin, sid, "product_sales", 10);
  const row = (t) => sales.rows.find((r) => r.data.title === t)?.data;
  check("one row per product, three products", sales.rows.length === 3 && sales.total === 3);
  check("units and revenue add up across orders", row("Ski Wax (renamed)")?.units === 5 && Number(row("Ski Wax (renamed)")?.revenue) === 500);
  check("and the title is today's, not the one it sold under", !!row("Ski Wax (renamed)") && !row("Ski Wax"));
  check("a pending order counts, a cancelled one does not", row("Snowboard")?.units === 3 && row("Snowboard")?.orders === 2);
  check("a product gone from Shopify is still a row", row("Old Gloves")?.units === 4);
  check("the best seller comes first without asking", sales.rows[0]?.data.title === "Ski Wax (renamed)");
  check("when it last sold is the latest uncancelled order", String(row("Ski Wax (renamed)")?.last_sold).startsWith("2026-09-10"));
  if (fails.length) show(sales.rows.map((r) => r.data));
  const byRevenue = await readStoreRows(admin, sid, "product_sales", 1, undefined, { field: "revenue", dir: "desc" });
  check("sorted by revenue it is the board", byRevenue.rows[0]?.data.title === "Snowboard");
  const found = await readStoreRows(admin, sid, "product_sales", 10, "gloves");
  check("and it can be searched by title", found.rows.length === 1 && found.rows[0].data.title === "Old Gloves");

  console.log("\nthe two lists a question is answered from");
  const leaders = await storeLeaders(admin, sid);
  check("top customers, biggest spender first", leaders.top_customers.map((c) => c.name).join(",") === "Bhavna,Chirag,Aarav,Devi");
  check("with their orders and spend", leaders.top_customers[0]?.orders === 3 && leaders.top_customers[0]?.spent === 5000);
  check("the unsynced one is there, with no figure", leaders.top_customers.at(-1)?.spent === null);
  check("best sellers, most units first", leaders.best_sellers.map((b) => b.title).join(",") === "Ski Wax (renamed),Old Gloves,Snowboard");
  check("the cancelled ten never appear", leaders.best_sellers.find((b) => b.title === "Snowboard")?.units === 3);
  check("in the shop's currency", leaders.best_sellers[0]?.currency === "INR" && leaders.best_sellers[0]?.revenue === 500);

  console.log("\nthe owner reads the view under their own rights");
  const { data: theirs, error: rlsErr } = await client.from("product_sales").select("title").eq("store_id", sid);
  check("their store's rows come back", !rlsErr && (theirs ?? []).length === 3);
  // Somebody else's store, made for this run: the view runs with the
  // reader's own rights, so their rows must not come back — not filtered
  // out on the way, absent.
  const { data: other, error: userErr } = await admin.auth.admin.createUser({
    email: `leaders-other-${stamp}@warmluke.test`,
    password: `pw-${stamp}-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (userErr) throw new Error(userErr.message);
  const theirProject = await throwawayProject(admin, other.user.id, "leaders-other");
  try {
    const { data: theirStore } = await admin
      .from("stores")
      .insert({ project_id: theirProject.id, shop_domain: `other-${stamp}.myshopify.com`, status: "connected" })
      .select("id")
      .single();
    const { data: theirOrder } = await admin
      .from("orders")
      .insert({ store_id: theirStore.id, external_id: `o-${stamp}-x`, order_number: "#x", placed_at: "2026-09-01T00:00:00Z", total: 0, currency: "INR", financial_status: "PAID" })
      .select("id")
      .single();
    must(await admin.from("order_line_items").insert({ store_id: theirStore.id, order_id: theirOrder.id, title: `Secret Item ${stamp}`, quantity: 1, price: 1 }));
    const { data: seen } = await admin.from("product_sales").select("title").eq("store_id", theirStore.id);
    check("the other store has a sale, seen with the master key", (seen ?? []).length === 1);
    const { data: notTheirs } = await client.from("product_sales").select("title").eq("store_id", theirStore.id);
    check("and nobody else's rows come back to this owner", (notTheirs ?? []).length === 0);
    const { data: unfiltered } = await client.from("product_sales").select("title");
    check("even asked for everything", !(unfiltered ?? []).some((r) => String(r.title).startsWith("Secret Item")));
  } finally {
    await theirProject.remove();
    await admin.auth.admin.deleteUser(other.user.id);
  }

  console.log("\nthe webhook road carries the spend");
  const { data: n, error: hookErr } = await admin.rpc("abo_shopify_upsert_customer", {
    p_shop: shop,
    p_customer: { id: 991, first_name: "Esha", last_name: "K", orders_count: "2", total_spent: "1234.50", updated_at: "2026-09-19T00:00:00Z" },
  });
  check("a customer webhook lands the figure", !hookErr && n === 1);
  const { data: esha } = await admin.from("customers").select("total_spent, orders_count").eq("store_id", sid).eq("name", "Esha K").single();
  check("as Shopify's number", Number(esha?.total_spent) === 1234.5 && esha?.orders_count === 2);
  await admin.rpc("abo_shopify_upsert_customer", {
    p_shop: shop,
    p_customer: { id: 991, first_name: "Esha", last_name: "K", orders_count: "3", updated_at: "2026-09-19T01:00:00Z" },
  });
  const { data: again } = await admin.from("customers").select("total_spent, orders_count").eq("store_id", sid).eq("name", "Esha K").single();
  check("a later payload without it keeps the one we had", Number(again?.total_spent) === 1234.5 && again?.orders_count === 3);

  console.log("\nthe card warns when a hand-kept list would copy it");
  const facts = { shop_domain: shop, currency: "INR", counts: { orders: 4, order_line_items: 6, customers: 5 } };
  const plan = (nav_label) => ({ changeType: "NEW_MODULE", targetModuleId: null, newModule: { name: "x", nav_label, icon: "table" } });
  check("“Order Items” is the order lines, not the orders", /order lines/.test(storeOverlap(plan("Order Items"), facts)[0] ?? ""));
  check("“Best Sellers” is product sales", /product sales/.test(storeOverlap(plan("Best Sellers"), facts)[0] ?? ""));

  console.log("\nand through the door a connected assistant uses");
  const tool = async (name, args) => {
    const res = await fetch(`${APP}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${me.session.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { project_id: project.id, ...args } } }),
    });
    const j = await res.json();
    try { return JSON.parse(j.result.content[0].text); } catch { return j; }
  };
  const overview = await tool("store_overview", {});
  check("store_overview names the top customer", overview?.top_customers?.[0]?.name === "Bhavna");
  check("and the best seller", overview?.best_sellers?.[0]?.title === "Ski Wax (renamed)");
  if (!overview?.top_customers) show(overview);
  const searched = await tool("search_store", { table: "product_sales", limit: 5 });
  check("search_store can look in product sales", searched?.table === "product_sales" && searched?.showing === 3);
  if (searched?.showing !== 3) show(searched);

  console.log("\na best-sellers section, built the way a merchant would get it");
  await admin.from("projects").update({ auto_build: true }).eq("id", project.id);
  const built = await tool("submit_design", {
    request: `Best sellers ${stamp}`,
    plans: [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: `best-sellers-${stamp}`, nav_label: `Best Sellers ${stamp}`, icon: "table", source_table: "product_sales" },
        newSchema: null,
        explanation: "What sells, most units first.",
      },
      {
        changeType: "FEATURE_UPDATE",
        targetModuleId: `#best-sellers-${stamp}`,
        features: {
          defaultSort: { field: "units", dir: "desc" },
          stats: [{ label: "Units sold", op: "sum", field: "units" }, { label: "Products", op: "count" }],
        },
        explanation: "Ranked, with the totals on top.",
      },
    ],
  });
  check("it builds", built?.status === "built");
  if (built?.status !== "built") show(built);
  const { data: section } = await admin
    .from("modules").select("id, source_table").eq("project_id", project.id).eq("name", `best-sellers-${stamp}`).maybeSingle();
  check("as a section over product sales", section?.source_table === "product_sales");
  const { data: schema } = section
    ? await admin.from("ui_schemas").select("schema_json").eq("module_id", section.id).order("version", { ascending: false }).limit(1).maybeSingle()
    : { data: null };
  const cols = (schema?.schema_json?.columns ?? []).map((c) => c.field);
  check("with the view's own columns", ["title", "units", "revenue", "orders", "last_sold"].every((c) => cols.includes(c)));
  check("and the sort the design asked for", schema?.schema_json?.features?.defaultSort?.field === "units");
} finally {
  await admin.from("stores").delete().eq("id", sid);
  await project.remove();
  const { count } = await admin.from("customers").select("id", { count: "exact", head: true }).eq("store_id", sid);
  check("the store is gone, and everything under it", (count ?? 0) === 0);
}

console.log(fails.length === 0 ? "\nwho buys most and what sells, over the whole store" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
