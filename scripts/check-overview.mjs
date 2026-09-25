// The Overview's numbers, against the real database.
//
// A page of rows cannot say how a store is doing; abo_store_overview
// counts on the server. So every rule it states is tried here with rows
// built to break it: a cancelled order, an order older than the window,
// a second currency, cash on delivery, a store in a timezone Postgres
// has never heard of, and somebody else asking.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-overview.mjs

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
const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const stamp = Date.now();
const made = [];
async function person(tag) {
  const email = `ovw_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_aA1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (!data.user) throw new Error(`could not create ${tag}: ${error?.message}`);
  made.push(data.user.id);
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`could not sign in ${tag}: ${e.message}`);
  return { id: data.user.id, client };
}

const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
const projects = [];

try {
  const owner = await person("owner");
  const stranger = await person("stranger");

  const project = async (name) => {
    const { data } = await admin.from("projects").insert({ name, owner_id: owner.id }).select("id").single();
    projects.push(data.id);
    return data.id;
  };
  const p = await project("overview-check");
  const { data: store } = await admin
    .from("stores")
    .insert({
      project_id: p,
      shop_domain: `ovw-${stamp}.myshopify.com`,
      status: "connected",
      currency: "INR",
      timezone: "Asia/Kolkata",
      connected_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  const { data: cust } = await admin
    .from("customers")
    .insert({ store_id: store.id, external_id: `c-${stamp}`, name: "Meera" })
    .select("id")
    .single();
  const order = (n, o) => ({
    store_id: store.id,
    external_id: `o-${stamp}-${n}`,
    order_number: `#${n}`,
    currency: "INR",
    ...o,
  });
  const { error: oe } = await admin.from("orders").insert([
    order(1, {
      placed_at: ago(0),
      total: 1000,
      total_original: 1000,
      financial_status: "PAID",
      fulfilment_status: "UNFULFILLED",
      customer_id: cust.id,
    }),
    order(2, {
      placed_at: ago(0),
      total: 500,
      total_original: 500,
      financial_status: "PENDING",
      fulfilment_status: "UNFULFILLED",
      gateway: "Cash on Delivery (COD)",
    }),
    order(3, {
      placed_at: ago(3),
      total: 200,
      total_original: 250,
      financial_status: "PAID",
      fulfilment_status: "FULFILLED",
    }),
    order(4, {
      placed_at: ago(0),
      total: 9999,
      total_original: 9999,
      financial_status: "PAID",
      fulfilment_status: "UNFULFILLED",
      cancelled_at: ago(0),
    }),
    order(5, {
      placed_at: ago(40),
      total: 777,
      total_original: 777,
      financial_status: "PAID",
      fulfilment_status: "UNFULFILLED",
    }),
    order(6, {
      placed_at: ago(0),
      total: 50,
      total_original: 50,
      financial_status: "PAID",
      fulfilment_status: "FULFILLED",
      currency: "USD",
    }),
    order(7, {
      placed_at: ago(1),
      total: 300,
      total_original: 300,
      financial_status: "PENDING",
      fulfilment_status: "FULFILLED",
      gateway: "Cash on Delivery (COD)",
    }),
    order(8, {
      placed_at: ago(1),
      total: 100,
      total_original: 100,
      financial_status: "PENDING",
      fulfilment_status: "FULFILLED",
      gateway: "Bank Deposit",
    }),
  ]);
  if (oe) throw new Error(`could not seed orders: ${oe.message}`);
  const { data: prod } = await admin
    .from("products")
    .insert({ store_id: store.id, external_id: `p-${stamp}`, title: "Vase" })
    .select("id")
    .single();
  const { data: v } = await admin
    .from("variants")
    .insert({ store_id: store.id, external_id: `v-${stamp}`, product_id: prod.id, title: "Blue", tracked: true })
    .select("id")
    .single();
  await admin
    .from("inventory_levels")
    .insert({ store_id: store.id, variant_id: v.id, available: 0, on_hand: 0, incoming: 0 });
  // One only promised away (on the shelf, none free): watched, after the
  // one with nothing at all.
  const { data: promised } = await admin
    .from("variants")
    .insert({ store_id: store.id, external_id: `v4-${stamp}`, product_id: prod.id, title: "Promised", tracked: true })
    .select("id")
    .single();
  await admin
    .from("inventory_levels")
    .insert({ store_id: store.id, variant_id: promised.id, available: 0, on_hand: 3 });
  // One nobody tracks, and one with stock: neither is anything to watch.
  const { data: others } = await admin
    .from("variants")
    .insert([
      { store_id: store.id, external_id: `v2-${stamp}`, product_id: prod.id, title: "Untracked", tracked: false },
      { store_id: store.id, external_id: `v3-${stamp}`, product_id: prod.id, title: "Plenty", tracked: true },
    ])
    .select("id, title");
  await admin.from("inventory_levels").insert([
    { store_id: store.id, variant_id: others.find((x) => x.title === "Untracked").id, available: 0, on_hand: 0 },
    { store_id: store.id, variant_id: others.find((x) => x.title === "Plenty").id, available: 9, on_hand: 9 },
  ]);

  console.log("the owner's numbers");
  const { data: o, error } = await owner.client.rpc("abo_store_overview", { p_project: p });
  check("the owner can read it", !error && !!o?.store);
  if (error) console.log("     →", error.message);
  const inr = (o?.money ?? []).find((m) => m.currency === "INR");
  const usd = (o?.money ?? []).find((m) => m.currency === "USD");
  check("it says which windows it counted", o?.days === 30 && o?.chart_days === 14);
  check("orders today leave out the cancelled one", o?.orders?.today === 3);
  check("and yesterday is yesterday in the store's own days", o?.orders?.yesterday === 2);
  check("the window leaves out the order from 40 days ago", o?.orders?.window === 6);
  check("collected is what was paid, cancelled not counted", Number(inr?.collected) === 1200);
  check("awaiting is what is still pending", Number(inr?.awaiting) === 900 && inr?.awaiting_count === 3);
  check("and says what most of it waits on, from the orders", inr?.awaiting_by === "Cash on Delivery (COD)");
  check("another currency is kept apart, never added", Number(usd?.collected) === 50 && (o?.money ?? []).length === 2);
  check("nothing pending in a currency names no method", usd?.awaiting_by === null);
  check("to fulfil counts open work whenever it came in", o?.to_fulfil === 3);
  check("every day of the chart is present", (o?.daily ?? []).length === 14);
  check("today's bar is the same count as orders today", (o?.daily ?? []).at(-1)?.orders === 3);
  check(
    "stock is counted in the list's own words",
    o?.stock?.["Out of stock"] === 1 && o?.stock?.["All promised"] === 1
  );
  check(
    "only tracked variants with nothing left are watched",
    o?.watching === 2 && (o?.stock_watch ?? []).map((w) => w.variant).join(",") === "Blue,Promised"
  );
  check(
    "the emptiest first, each with the list's word for it",
    o?.stock_watch?.[0]?.stock_state === "Out of stock" && o?.stock_watch?.[1]?.stock_state === "All promised"
  );
  check(
    "and the store is named with its own timezone",
    o?.store?.timezone === "Asia/Kolkata" && o?.store?.currency === "INR"
  );

  console.log("\nthe windows are the caller's to choose");
  const week = await owner.client.rpc("abo_store_overview", { p_project: p, p_days: 7, p_chart_days: 7 });
  check("a week counts the week", !week.error && week.data?.orders?.window === 6 && week.data?.days === 7);
  check("and draws seven days", (week.data?.daily ?? []).length === 7);
  const day = await owner.client.rpc("abo_store_overview", { p_project: p, p_days: 1 });
  check("one day is today alone", !day.error && day.data?.orders?.window === 3);
  for (const [what, args] of [
    ["no days at all", { p_days: 0 }],
    ["more than a year", { p_days: 400 }],
    ["a chart of a hundred days", { p_chart_days: 100 }],
  ]) {
    const bad = await owner.client.rpc("abo_store_overview", { p_project: p, ...args });
    check(`${what} is refused`, bad.error?.code === "22023");
  }

  console.log("\nsomebody else");
  const theirs = await stranger.client.rpc("abo_store_overview", { p_project: p });
  check("is refused, not handed zeros", theirs.error?.code === "42501");
  const signedOut = await createClient(URL_, ANON).rpc("abo_store_overview", { p_project: p });
  check("and so is nobody at all", !!signedOut.error);

  console.log("\nthe awkward cases");
  const bare = await project("overview-no-store");
  const none = await owner.client.rpc("abo_store_overview", { p_project: bare });
  check("a project with no store says so, without an error", !none.error && none.data?.store === null);
  const odd = await project("overview-odd-zone");
  await admin.from("stores").insert({
    project_id: odd,
    shop_domain: `ovw2-${stamp}.myshopify.com`,
    status: "connected",
    timezone: "Mars/Olympus_Mons",
  });
  const zone = await owner.client.rpc("abo_store_overview", { p_project: odd });
  check("a timezone Postgres does not know falls back to UTC", !zone.error && zone.data?.store?.timezone === "UTC");
  check("and an empty store is all zeros, not nulls", zone.data?.orders?.today === 0 && zone.data?.to_fulfil === 0);

  console.log("\nwhat the detail view reads");
  const byCustomer = await owner.client.from("orders").select("id").eq("store_id", store.id).eq("customer_id", cust.id);
  check("a customer's orders can be found by the owner", !byCustomer.error && (byCustomer.data ?? []).length === 1);
  const byStranger = await stranger.client.from("orders").select("id").eq("customer_id", cust.id);
  check("and not by anybody else", (byStranger.data ?? []).length === 0);
} finally {
  for (const id of projects) await admin.from("projects").delete().eq("id", id);
  for (const id of made) await admin.auth.admin.deleteUser(id);
}

console.log(fails.length === 0 ? "\nthe overview counts what it says it counts" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
