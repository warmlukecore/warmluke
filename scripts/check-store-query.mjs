// Any list, counted exactly (0217): abo_store_query and store_campaign_results.
//
// On a throwaway store with ad spend and orders of its own: totals over
// every row, grouped by a column and by week; filters on numbers, words
// and lists; rows a page at a time with the count of all; the store's own
// orders set beside each campaign's spend (ROAS, by the campaign's name or
// id); and every way in that is not one — a column the list lacks, a
// condition that is not one, a list that is not one, a value written as
// SQL, a stranger, nobody signed in.
//
//   ENV_FILE=.env.check.local node scripts/check-store-query.mjs
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
const anon = createClient(URL_, ANON, { auth: { persistSession: false } });

let failed = 0;
const check = (what, ok) => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) failed++;
};

const stamp = Date.now();
async function person(tag) {
  const email = `query_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_aA1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (!data.user) throw new Error(`could not create ${tag}: ${error?.message}`);
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: signIn } = await client.auth.signInWithPassword({ email, password });
  if (signIn) throw new Error(`could not sign in ${tag}: ${signIn.message}`);
  return { id: data.user.id, client };
}

const owner = await person("owner");
const stranger = await person("stranger");
let projectId = null;
try {
  const { data: project } = await admin
    .from("projects")
    .insert({ owner_id: owner.id, name: `query-check ${stamp}` })
    .select("id")
    .single();
  projectId = project.id;
  const { data: store } = await admin
    .from("stores")
    .insert({
      project_id: projectId,
      shop_domain: `query-${stamp}.myshopify.com`,
      status: "connected",
      timezone: "Asia/Kolkata",
      currency: "INR",
    })
    .select("id")
    .single();
  const { data: conn } = await admin
    .from("store_connections")
    .insert({
      project_id: projectId,
      store_id: store.id,
      provider: "meta_ads",
      account_ref: "act_1",
      status: "connected",
      connected_by: owner.id,
    })
    .select("id")
    .single();
  const spend = (campaign_id, campaign_name, day, amount, purchases = 0, value = 0) => ({
    project_id: projectId,
    store_id: store.id,
    connection_id: conn.id,
    provider: "meta_ads",
    campaign_id,
    campaign_name,
    day,
    spend: amount,
    currency: "INR",
    clicks: 10,
    purchases,
    purchase_value: value,
  });
  const put = await admin
    .from("ad_spend")
    .insert([
      spend("111", "Diwali", "2026-10-05", 1000, 5, 9000),
      spend("111", "Diwali", "2026-10-06", 1500, 6, 9500),
      spend("111", "Diwali", "2026-10-13", 500, 1, 900),
      spend("222", "Retarget", "2026-10-06", 300, 2, 2000),
    ]);
  check("a store with ad spend to count", !put.error);
  if (put.error) console.log("     →", put.error.message);
  // The store's own orders: two by the campaign's name, one by its id, one by another, one cancelled,
  // and one at 2am in India on the 7th, which is still the 6th in UTC.
  const order = (n, day, total, utm, cancelled = false, at = "12:00:00") => ({
    store_id: store.id,
    external_id: `gid://shopify/Order/${stamp}${n}`,
    order_number: `#Q${n}`,
    source: "shopify",
    total,
    placed_at: `${day}T${at}+05:30`,
    utm_campaign: utm,
    cancelled_at: cancelled ? `${day}T13:00:00+05:30` : null,
  });
  const sold = await admin
    .from("orders")
    .insert([
      order(1, "2026-10-06", 1200, "diwali"),
      order(2, "2026-10-06", 800, "Diwali "),
      order(3, "2026-10-06", 1000, "111"),
      order(4, "2026-10-06", 5000, "something-else"),
      order(5, "2026-10-06", 9999, "Diwali", true),
      order(6, "2026-10-07", 100, null, false, "02:00:00"),
    ]);
  check("and orders of its own", !sold.error);
  if (sold.error) console.log("     →", sold.error.message);
  const ask = (client, list, spec) => client.rpc("abo_store_query", { p_store: store.id, p_list: list, p_spec: spec });

  console.log("\ntotals over every row");
  const { data: byCampaign, error: e1 } = await ask(owner.client, "ad_spend", {
    measures: [
      { fn: "sum", field: "spend", as: "spent" },
      { fn: "count", as: "days" },
    ],
    group_by: [{ field: "campaign_name" }],
  });
  check("summed by campaign, biggest first", !e1 && byCampaign?.groups?.[0]?.campaign_name === "Diwali");
  if (e1) console.log("     →", e1.message);
  check("exactly", Number(byCampaign?.groups?.[0]?.spent) === 3000 && Number(byCampaign?.groups?.[1]?.spent) === 300);
  check(
    "with the overall totals beside them",
    Number(byCampaign?.totals?.spent) === 3300 && Number(byCampaign?.totals?.days) === 4
  );
  const { data: byWeek } = await ask(owner.client, "ad_spend", {
    measures: [{ fn: "sum", field: "spend", as: "spent" }],
    group_by: [{ field: "day", by: "week" }],
    order: { by: "day_week", desc: false },
  });
  check(
    "and by week, the Monday each starts on",
    byWeek?.groups?.length === 2 &&
      byWeek.groups[0].day_week === "2026-10-05" &&
      Number(byWeek.groups[0].spent) === 2800
  );
  const { data: span } = await ask(owner.client, "ad_spend", {
    measures: [{ fn: "sum", field: "spend", as: "spent" }],
    date_field: "day",
    from: "2026-10-06",
    to: "2026-10-06",
  });
  check("over a span of days", Number(span?.totals?.spent) === 1800);
  const { data: filtered } = await ask(owner.client, "ad_spend", {
    measures: [{ fn: "count", as: "n" }],
    where: [
      { field: "spend", op: "gt", value: 400 },
      { field: "campaign_name", op: "contains", value: "wal" },
    ],
  });
  check("filtered by a number and by words", Number(filtered?.totals?.n) === 3);
  const { data: listed } = await ask(owner.client, "ad_spend", {
    measures: [{ fn: "count", as: "n" }],
    where: [{ field: "campaign_id", op: "in", value: ["222", "999"] }],
  });
  check("and by a list of values", Number(listed?.totals?.n) === 1);
  const { data: byDay } = await ask(owner.client, "orders", {
    measures: [{ fn: "count", as: "n" }],
    group_by: [{ field: "placed_ts", by: "day" }],
  });
  const { data: onThe7th } = await ask(owner.client, "orders", {
    measures: [{ fn: "count", as: "n" }],
    date_field: "placed_ts",
    from: "2026-10-07",
    to: "2026-10-07",
  });
  check(
    "a moment in time falls on the store's own day, not UTC's",
    Number(byDay?.groups?.find((g) => g.placed_ts_day === "2026-10-07")?.n) === 1 && Number(onThe7th?.totals?.n) === 1
  );

  console.log("\nrows, a page at a time");
  const { data: page2 } = await ask(owner.client, "ad_spend", {
    limit: 2,
    offset: 2,
    order: { by: "day", desc: false },
  });
  check(
    "a page on, with the count of all",
    page2?.matched === 4 && page2?.showing === 2 && page2.rows[0].day === "2026-10-06" && !("store_id" in page2.rows[0])
  );

  console.log("\nwhat the ads cost beside what the store sold");
  const { data: roas } = await ask(owner.client, "campaign_results", {
    where: [
      { field: "campaign_id", op: "eq", value: "111" },
      { field: "day", op: "eq", value: "2026-10-06" },
    ],
  });
  const row = roas?.rows?.[0];
  check(
    "the store's own orders that day, by the campaign's name or id, cancelled ones left out",
    Number(row?.store_orders) === 3 && Number(row?.store_revenue) === 3000
  );
  check(
    "and ROAS from them, beside the platform's claim",
    Number(row?.store_roas) === 2 && Number(row?.cost_per_order) === 500 && Number(row?.platform_roas) === 6.33
  );
  const { data: total } = await ask(owner.client, "campaign_results", {
    measures: [
      { fn: "sum", field: "spend", as: "spent" },
      { fn: "sum", field: "store_revenue", as: "sold" },
    ],
    group_by: [{ field: "campaign_name" }],
  });
  check(
    "summed over a campaign's days",
    Number(total?.groups?.find((g) => g.campaign_name === "Diwali")?.sold) === 3000
  );

  console.log("\nnothing but the list's own");
  const noColumn = await ask(owner.client, "ad_spend", {
    measures: [{ fn: "sum", field: "spend; drop table orders" }],
  });
  check("a column the list lacks is refused", /no column/.test(noColumn.error?.message ?? ""));
  const noOp = await ask(owner.client, "ad_spend", { where: [{ field: "spend", op: "; delete", value: 1 }] });
  check("a condition that is not one is refused", /Not a condition/.test(noOp.error?.message ?? ""));
  const noList = await ask(owner.client, "pg_user", {});
  check("a list that is not one is refused", /not one of the store's lists/.test(noList.error?.message ?? ""));
  const sql = await ask(owner.client, "ad_spend", {
    measures: [{ fn: "count", as: "n" }],
    where: [{ field: "campaign_name", op: "eq", value: "' or 1=1 --" }],
  });
  check("a value written as SQL is only a value", !sql.error && Number(sql.data?.totals?.n) === 0);
  const sumWords = await ask(owner.client, "ad_spend", { measures: [{ fn: "sum", field: "campaign_name" }] });
  check("words are not summed", /needs a column of numbers/.test(sumWords.error?.message ?? ""));

  console.log("\nwho may ask");
  const theirs = await ask(stranger.client, "ad_spend", { measures: [{ fn: "count" }] });
  check("a stranger is refused", /Not a store you can read/.test(theirs.error?.message ?? ""));
  const nobody = await ask(anon, "ad_spend", { measures: [{ fn: "count" }] });
  check("and so is nobody signed in", !!nobody.error);
  const { data: still } = await admin.from("orders").select("id").eq("store_id", store.id);
  check("and nothing was changed by any of it", still?.length === 6);
} finally {
  if (projectId) await admin.from("projects").delete().eq("id", projectId);
  await admin.auth.admin.deleteUser(owner.id);
  await admin.auth.admin.deleteUser(stranger.id);
}

if (failed) {
  console.error(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nany list is counted exactly, and only by those who may read it");
