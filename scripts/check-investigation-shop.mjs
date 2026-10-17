// The investigations' shop (scripts/fixtures/shops.ts, ethnic), seeded as
// an eval case seeds it, on the check project: the database's own tools
// read it as the cases expect (evals/expect.mjs), so a paid run is never
// spent on a fixture that does not say what its case is graded on.
//
// RTO by payment over settled shipments (abo_rto_cohorts), what runs out
// before the restock (abo_stock_cover), and the campaign spending on it
// (abo_ads_stock), each under the owner's own rights.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-investigation-shop.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { SHOPS } from "./fixtures/shops.ts";
import { seedBusiness, shopNodes } from "./fixtures/business-shop.ts";
import { SEED_CURRENCY, SEED_TIMEZONE } from "./fixtures/seed-shop.ts";
import { EXPECT, viewOf } from "../evals/expect.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [
      l.slice(0, l.indexOf("=")).trim(),
      l
        .slice(l.indexOf("=") + 1)
        .trim()
        .replace(/^"|"$/g, ""),
    ])
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

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, anon), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const owner = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${me.session.access_token}` } } });
const project = await throwawayProject(admin, me.user.id, "investigation shop");

try {
  const now = Date.now();
  const store = must(
    await admin
      .from("stores")
      .insert({
        project_id: project.id,
        provider: "shopify",
        status: "connected",
        shop_domain: `inv-${now.toString(36)}.myshopify.com`,
        currency: SEED_CURRENCY,
        timezone: SEED_TIMEZONE,
        country: "IN",
      })
      .select("id")
      .single()
  );
  await seedBusiness(admin, store.id, SHOPS.ethnic, now);
  const view = viewOf(shopNodes(SHOPS.ethnic, now), now, SHOPS.ethnic);
  const rpc = async (fn, args) => must(await owner.rpc(fn, args));

  console.log("RTO, as i-rto-why is graded");
  const [rate, before, , cod] = EXPECT["ethnic-rto-why"](view).answer;
  const byPay = await rpc("abo_rto_cohorts", { p_store: store.id, p_days: 14, p_by: "payment", p_min: 20 });
  check(
    `the last 14 days against the 14 before: ${byPay.now?.rate}% against ${byPay.before?.rate}%`,
    byPay.now?.rate === rate.any[0] && byPay.before?.rate === before.any[0]
  );
  const codGroup = byPay.groups?.find((g) => g.name === "COD");
  check(`COD is where it rose: ${codGroup?.rate}%`, codGroup?.rate === cod.any[0] && codGroup.change > 0);
  const byCourier = await rpc("abo_rto_cohorts", { p_store: store.id, p_days: 14, p_by: "courier", p_min: 20 });
  check(
    "both couriers moved alike, so no courier is to blame",
    new Set((byCourier.groups ?? []).map((g) => g.rate)).size === 1
  );

  console.log("\nwhat runs out, as i-runs-out is graded");
  const [, ...days] = EXPECT["ethnic-runs-out"](view).answer;
  const cover = await rpc("abo_stock_cover", { p_store: store.id, p_days: 28, p_limit: 50 });
  const short = (cover.variants ?? []).filter((v) => v.runs_out_before_restock);
  check(`the restock time is the owner's: ${cover.lead_days} days`, cover.lead_days === SHOPS.ethnic.restockDays);
  check(
    `the sizes that run out first, in the days expected: ${short.map((v) => `${v.variant} ${v.days_left}`).join(", ")}`,
    short.length === days.length &&
      short
        .map((v) => v.days_left)
        .toSorted((a, b) => a - b)
        .join() ===
        days
          .map((d) => d.any[0])
          .toSorted((a, b) => a - b)
          .join()
  );

  console.log("\nads on that stock, as i-ads-stock is graded");
  const [campaign] = EXPECT["ethnic-ads-stock"](view).answer;
  const ads = await rpc("abo_ads_stock", { p_store: store.id, p_days: 7, p_sales_days: 28, p_cover: null });
  const first = ads.campaigns?.[0];
  check(
    `the campaign spending most on it first: ${first?.campaign}, ${first?.spend} spent`,
    first?.campaign === campaign.names[0] && first.spend === 10500 && first.share_running_out > 0.5
  );
  const brand = ads.campaigns?.find((c) => c.campaign === "Brand awareness");
  check("a campaign with no orders of its own sells nothing known", brand?.orders === 0 && brand.products === null);
  const { data: account } = await admin
    .from("store_connections")
    .select("account_ref")
    .eq("store_id", store.id)
    .eq("provider", "meta_ads")
    .single();
  check("the ad days are marked a dated export", /^dated export, \d{4}-\d{2}-\d{2}$/.test(account?.account_ref ?? ""));
} finally {
  await project.remove();
}

console.log(
  fails.length ? `\n${fails.length} FAILED` : "\nthe investigations' shop says, in the database, what its cases expect"
);
process.exit(fails.length ? 1 : 0);
