// A routed question gets the rows it needs — from the store, through
// the same functions everything else reads through — and a turn that
// was not a question gets exactly what it got before.
//
// Slices are proven with routes written by hand, no model in the way:
// a ranking cuts biggest-first, a lookup searches the words, a span
// keeps to its days, a sales span goes through the function, stock
// goes through the low-stock read. Then the engine, with a real
// router, is asked a question and a build request; then the MCP tool.
// The two halves that need the router are played back from tapes/ by
// default (model-tape.ts), so they run in CI too; recorded with
// MODEL_TAPE=record against the real router, with the server recording.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-ask-store.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { fetchSlice } from "../src/lib/slice.ts";
import { storeContextFor } from "../src/lib/engine.ts";
import { keyFor } from "../src/lib/model-tape.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";
if (env.TYPESAFE_API_KEY && !process.env.TYPESAFE_API_KEY) process.env.TYPESAFE_API_KEY = env.TYPESAFE_API_KEY;
process.env.MODEL_TAPE ??= "replay";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 320));

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const me = await signInAsCheckUser(client, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const project = await throwawayProject(admin, me.user.id, "ask-store");
const stamp = Date.now().toString(36);
const must = ({ error, data }) => {
  if (error) throw new Error(error.message);
  return data;
};
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

try {
  const store = must(
    await admin.from("stores").insert({ project_id: project.id, shop_domain: `ask-${stamp}.myshopify.com`, status: "connected", currency: "INR", timezone: "Asia/Kolkata" }).select("id, timezone").single()
  );
  const [aarav, bhavna, chirag] = must(
    await admin.from("customers").insert([
      { store_id: store.id, external_id: `c-${stamp}-a`, name: "Aarav Singh", phone: "+91 98100 00001", orders_count: 1, total_spent: 100 },
      { store_id: store.id, external_id: `c-${stamp}-b`, name: "Bhavna Mehta", phone: "+91 98100 00002", orders_count: 3, total_spent: 5000 },
      { store_id: store.id, external_id: `c-${stamp}-c`, name: "Chirag Rao", phone: "+91 98100 00003", orders_count: 2, total_spent: 900 },
    ]).select("id")
  );
  const [wax, board] = must(
    await admin.from("products").insert([
      { store_id: store.id, external_id: `p-${stamp}-1`, title: "Ski Wax", handle: `wax-${stamp}`, status: "ACTIVE" },
      { store_id: store.id, external_id: `p-${stamp}-2`, title: "Snowboard", handle: `board-${stamp}`, status: "ACTIVE" },
    ]).select("id")
  );
  const order = async (n, placed, customer, extra = {}) =>
    must(
      await admin.from("orders").insert({ store_id: store.id, external_id: `o-${stamp}-${n}`, order_number: `#${n}`, placed_at: placed, total: 100 * n, currency: "INR", financial_status: "PAID", customer_id: customer, tags: [], ...extra }).select("id").single()
    ).id;
  const o1 = await order(1, daysAgo(2), aarav.id);
  const o2 = await order(2, daysAgo(1), bhavna.id);
  const o3 = await order(3, daysAgo(0.5), chirag.id, { financial_status: "PENDING" });
  const o4 = await order(4, daysAgo(40), bhavna.id, { cancelled_at: daysAgo(39) });
  must(
    await admin.from("order_line_items").insert([
      { store_id: store.id, order_id: o1, product_id: wax.id, title: "Ski Wax", quantity: 2, price: 50 },
      { store_id: store.id, order_id: o2, product_id: wax.id, title: "Ski Wax", quantity: 3, price: 50 },
      { store_id: store.id, order_id: o3, product_id: board.id, title: "Snowboard", quantity: 1, price: 300 },
      { store_id: store.id, order_id: o4, product_id: board.id, title: "Snowboard", quantity: 10, price: 300 },
    ])
  );
  const { data: v } = await admin.from("variants").insert({ store_id: store.id, product_id: wax.id, external_id: `v-${stamp}`, title: "Default", sku: `WAX-${stamp}` }).select("id").single();
  must(await admin.from("inventory_levels").insert({ store_id: store.id, variant_id: v.id, location_name: "Main", available: 3 }));

  const route = (o) => ({ list: "customers", window: "all", month: null, kind: "ranking", needles: [], confidence: { list: 1, kind: 1, window: 1 }, ms: 0, ...o });
  const S = (r) => fetchSlice(admin, store, route(r));

  console.log("a route becomes rows");
  let s = await S({});
  check("customers ranked: biggest spender first", s?.rows[0]?.name === "Bhavna Mehta" && s?.rows.length === 3);
  check("and the rows carry no ids", !("id" in (s?.rows[0] ?? {})) && !("store_id" in (s?.rows[0] ?? {})));
  s = await S({ kind: "lookup", needles: ["Aarav", "phone", "number"] });
  check("a lookup finds by any of the words", s?.rows.length === 1 && s?.rows[0]?.name === "Aarav Singh" && /Aarav/.test(s.what));
  s = await S({ list: "orders", kind: "lookup", needles: ["#2", "paid"] });
  check("an order by its number", s?.rows.length === 1 && s?.rows[0]?.order_number === "#2");
  s = await S({ list: "customers", kind: "ranking", window: "this_week" });
  check("customers over a span are that span's orders, with names, to rank from", s?.rows.length === 3 && s?.rows[0]?.order_number === "#3" && "customer_name" in s.rows[0] && /rank or count customers/.test(s.what));
  s = await S({ list: "orders", kind: "total", window: "this_week" });
  check("orders in the last seven days, and not the one from forty days ago", s?.rows.length === 3 && s?.total === 3 && /last 7 days/.test(s.what));
  s = await S({ list: "orders", kind: "ranking", window: "all" });
  check("orders ranked: biggest first, cancelled one included and marked", s?.rows[0]?.order_number === "#4" && s?.rows[0]?.status === "Cancelled");
  s = await S({ list: "sales", kind: "ranking", window: "this_month" });
  check("sales in a span go through the function: the cancelled ten do not count", s?.rows[0]?.title === "Ski Wax" && s?.rows[0]?.units === 5 && s?.rows.find((r) => r.title === "Snowboard")?.units === 1);
  s = await S({ list: "sales", kind: "ranking", window: "all" });
  check("sales all time go through the view", s?.rows[0]?.title === "Ski Wax" && s?.rows[0]?.units === 5);
  s = await S({ list: "stock", kind: "ranking" });
  check("what is running low comes from the low-stock read", s?.rows.length === 1 && s?.rows[0]?.available === 3);
  s = await S({ list: "stock", kind: "lookup", needles: ["ski wax", "wax"] });
  check("stock of something, by the product's name", s?.rows.length === 1 && s?.rows[0]?.product === "Ski Wax");
  s = await S({ list: "products", kind: "lookup", needles: ["snowboard"] });
  check("a product, whatever the case", s?.rows.length === 1 && s?.rows[0]?.title === "Snowboard");
  s = await S({ list: "customers", kind: "lookup", needles: ["Nobody"] });
  check("nothing matched is an empty slice, not an error", s?.rows.length === 0 && s?.total === 0);

  if (!keyFor(process.env.TYPESAFE_API_KEY)) {
    console.log("\n  skip  no TYPESAFE_API_KEY — the engine and the tool were not asked a real question");
  } else {
    console.log("\nthe engine, asked a question and asked for a build");
    // Asked twice before it is called a failure.
    //
    // The router answers over the network with a three second budget,
    // and askJev turns everything — a timeout, an outage, a reply it
    // could not read — into the same null that low confidence gives.
    // So a slow afternoon at the other end looked exactly like this
    // question having stopped routing, and turned a whole CI run red
    // for a reason that had nothing to do with the commit.
    //
    // Twice, not more: a question this plain routes on the first or
    // second ask, and anything that needs a third is a regression
    // worth seeing.
    let asked = await storeContextFor(client, project.id, "who is my top buyer?");
    if (!asked?.snapshot?.slice) {
      console.log("  ..    no route the first time; asking once more");
      asked = await storeContextFor(client, project.id, "who is my top buyer?");
    }
    check("a question brings its rows into the snapshot", asked?.snapshot?.slice?.read_as?.list === "customers" && asked?.snapshot?.slice?.rows?.[0]?.name === "Bhavna Mehta");
    if (!asked?.snapshot?.slice) show(asked?.snapshot);
    const build = await storeContextFor(client, project.id, "make me a returns section with a reason and refund amount");
    check("a build request brings nothing extra", build?.snapshot?.slice === undefined);
    check("and the fixed snapshot is still there either way", (build?.snapshot?.top_customers?.length ?? 0) > 0 && (asked?.snapshot?.recent?.length ?? 0) > 0);

    console.log("\nand through the door a connected assistant uses");
    const tool = async (name, args) => {
      const res = await fetch(`${APP}/api/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${me.session.access_token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { project_id: project.id, ...args } } }),
      });
      // The server has to record or play back as this process does, or its
      // router answers from a different place than this one's.
      if (res.headers.get("x-model-tape") !== process.env.MODEL_TAPE) {
        throw new Error(`the server at ${APP} is ${res.headers.get("x-model-tape") ? `in ${res.headers.get("x-model-tape")} mode` : "calling the real router"}, and this check is in ${process.env.MODEL_TAPE} mode; start it with MODEL_TAPE=${process.env.MODEL_TAPE}`);
      }
      const j = await res.json();
      try { return JSON.parse(j.result.content[0].text); } catch { return j; }
    };
    const top = await tool("ask_store", { question: "who is my top buyer?" });
    check("ask_store answers a ranking with the rows", top?.read_as?.list === "customers" && top?.rows?.[0]?.name === "Bhavna Mehta");
    if (!top?.rows) show(top);
    const one = await tool("ask_store", { question: "is #2 paid?" });
    check("and a lookup with the one row", one?.read_as?.kind === "lookup" && one?.rows?.length === 1 && one?.rows?.[0]?.order_number === "#2");
    if (one?.rows?.length !== 1) show(one);
    const week = await tool("ask_store", { question: "how many orders this week?" });
    check("and a total with the span's rows", week?.read_as?.window === "this_week" && week?.total === 3);
    if (week?.total !== 3) show(week);
    const no = await tool("ask_store", { question: "make me a returns section" });
    check("a build request is not routed, and says which tools to use", no?.could_not_route === true && /search_orders/.test(no?.note ?? ""));
    const empty = await tool("ask_store", { question: "" });
    check("no question is an error, not a route", typeof empty?.error === "string");
  }
} finally {
  await project.remove();
}

console.log(fails.length === 0 ? "\na question gets its rows, and a build request gets what it always got" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
