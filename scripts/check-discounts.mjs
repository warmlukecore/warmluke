// The campaigns behind the codes.
//
// Shopify keeps eight concrete discount types under one union, and
// the only part of that this app models is what they share. So the
// thing worth checking is the splitting: DiscountAutomaticFreeShipping
// has to become AUTOMATIC and FREE_SHIPPING, and a ninth type nobody
// has seen has to arrive as itself rather than as null.
//
// Then the two traps money reports fall into. Shopify reports a
// percentage as 0.8 and a column called percent_off holding 0.8 is
// wrong in every report that formats it. And a campaign with no
// usage limit has no uses left to count — null, never zero, or a
// merchant reads "0 left" about a code anybody can still use.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-discounts.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { saveDiscounts, splitDiscountType } from "../src/lib/shopify-import.ts";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

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

console.log("the type name is split, not listed");
const split = (t) => `${splitDiscountType(t).method}/${splitDiscountType(t).kind}`;
check("DiscountCodeBasic", split("DiscountCodeBasic") === "CODE/BASIC");
check("DiscountCodeBxgy", split("DiscountCodeBxgy") === "CODE/BXGY");
check("DiscountCodeFreeShipping", split("DiscountCodeFreeShipping") === "CODE/FREE_SHIPPING");
check("DiscountCodeApp", split("DiscountCodeApp") === "CODE/APP");
check("DiscountAutomaticBasic", split("DiscountAutomaticBasic") === "AUTOMATIC/BASIC");
check("DiscountAutomaticBxgy", split("DiscountAutomaticBxgy") === "AUTOMATIC/BXGY");
check("DiscountAutomaticFreeShipping", split("DiscountAutomaticFreeShipping") === "AUTOMATIC/FREE_SHIPPING");
check("DiscountAutomaticApp", split("DiscountAutomaticApp") === "AUTOMATIC/APP");
// The point of reading the name instead of listing the eight: a
// ninth arrives as itself, and the row says what it is.
check("a type nobody has seen still splits", split("DiscountAutomaticShippingThing") === "AUTOMATIC/SHIPPING_THING");
check("something that is not a discount type is null", split("Order") === "null/null");
check("and nothing at all is null", split(undefined) === "null/null");

const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(anon, env);
if (!me.session) {
  console.log(`no check user: ${me.why}`);
  process.exit(1);
}
const project = await throwawayProject(admin, me.user.id, "discounts");
const stamp = Date.now().toString(36);
const shop = `disc-${stamp}.myshopify.com`;

try {
  const { data: store } = await admin
    .from("stores")
    .insert({ project_id: project.id, shop_domain: shop, status: "connected" })
    .select("id")
    .single();

  // The five shapes the real dev store actually holds, plus an amount
  // discount, which it does not — so all four value shapes are here.
  const node = (n, typename, extra) => ({
    id: `gid://shopify/Discount${typename.startsWith("DiscountCode") ? "Code" : "Automatic"}Node/${stamp}${n}`,
    discount: { __typename: typename, title: `T${n}`, status: "ACTIVE", startsAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", ...extra },
  });
  await saveDiscounts(admin, store.id, [
    node(1, "DiscountCodeBasic", {
      summary: "80% off one-time purchase products • Minimum quantity of 1",
      endsAt: "2026-12-31T23:59:59Z",
      usageLimit: 100, appliesOncePerCustomer: true, asyncUsageCount: 7,
      codes: { nodes: [{ code: "BLACKFRIDAY" }, { code: "BF2026" }] },
      customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.8 } },
    }),
    node(2, "DiscountCodeBasic", {
      summary: "$10 off",
      usageLimit: null, appliesOncePerCustomer: false, asyncUsageCount: 0,
      codes: { nodes: [{ code: "TENOFF" }] },
      customerGets: { value: { __typename: "DiscountAmount", amount: { amount: "10.0", currencyCode: "USD" } } },
    }),
    node(3, "DiscountCodeFreeShipping", {
      summary: "Free shipping on one-time purchase products • Minimum quantity of 3",
      asyncUsageCount: 2, codes: { nodes: [{ code: "FREESHIP" }] },
    }),
    node(4, "DiscountAutomaticBxgy", { summary: "Buy 1 item, get 1 item at 10% off", status: "SCHEDULED" }),
    node(5, "DiscountAutomaticBasic", {
      summary: "30% off The Complete Snowboard (Ice) • Minimum quantity of 3", status: "EXPIRED",
      customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.3 } },
    }),
  ]);

  const rows = (await admin.from("discounts").select("*").eq("store_id", store.id).order("title")).data ?? [];
  check("all five are written", rows.length === 5);
  const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));

  console.log("\nand the numbers are stored the way a report will read them");
  // 0.8 in, 80 out. The single most likely wrong number here.
  check("a percentage is whole percents, not a fraction", Number(byTitle.T1?.percent_off) === 80);
  check("a small one too", Number(byTitle.T5?.percent_off) === 30);
  check("an amount is an amount, with its currency", Number(byTitle.T2?.amount_off) === 10 && byTitle.T2?.currency === "USD");
  check("free shipping has neither", byTitle.T3?.percent_off === null && byTitle.T3?.amount_off === null);
  check("and nor does buy-one-get-one", byTitle.T4?.percent_off === null && byTitle.T4?.amount_off === null);
  // Null is no limit. Zero would be a campaign nobody can use.
  check("no usage limit is null, not zero", byTitle.T2?.usage_limit === null);
  check("a real limit is kept", byTitle.T1?.usage_limit === 100 && byTitle.T1?.times_used === 7);
  check("both codes of a campaign are kept", String(byTitle.T1?.codes) === "BLACKFRIDAY,BF2026");
  check("an automatic discount has no codes, and that is not a loss", String(byTitle.T4?.codes) === "");
  check("the method and kind are split off the type", byTitle.T3?.method === "CODE" && byTitle.T3?.kind === "FREE_SHIPPING");
  check("and Shopify's own sentence is kept whole", byTitle.T4?.summary === "Buy 1 item, get 1 item at 10% off");

  console.log("\nand what a merchant reads");
  const view = (await admin.from("store_discounts").select("*").eq("store_id", store.id).order("title")).data ?? [];
  const v = Object.fromEntries(view.map((r) => [r.title, r]));
  check("running, in their words", v.T1?.state === "Running");
  check("not started", v.T4?.state === "Not started");
  check("finished", v.T5?.state === "Finished");
  check("a percentage reads as a percentage", v.T1?.takes_off === "80% off");
  check("and drops the pointless decimals", v.T5?.takes_off === "30% off");
  check("an amount reads with its currency", v.T2?.takes_off === "USD 10.00 off");
  check("free shipping says so", v.T3?.takes_off === "Free shipping");
  // No number can describe buy-X-get-Y, so the column is empty and
  // the summary is what the answer must quote.
  check("buy-one-get-one has no headline number", v.T4?.takes_off === null);
  check("but it does have the sentence", (v.T4?.summary ?? "").startsWith("Buy 1 item"));
  check("uses left counts down from the limit", Number(v.T1?.uses_left) === 93);
  // The trap: "0 left" about a code anybody can still use.
  check("and is empty when there is no limit", v.T2?.uses_left === null);
  check("the codes are joined for reading", v.T1?.codes === "BLACKFRIDAY, BF2026");

  console.log("\nand the webhook road keeps it fresh without flattening it");
  const { error: hookErr } = await admin.rpc("abo_shopify_upsert_discount", {
    p_shop: shop,
    p_d: {
      admin_graphql_api_id: byTitle.T1.external_id,
      title: "Black Friday, renamed",
      status: "expired",
      updated_at: "2026-09-22T00:00:00Z",
    },
  });
  check("the webhook is accepted", !hookErr);
  if (hookErr) console.log("     →", hookErr.message);
  const fresh = (await admin.from("discounts").select("*").eq("external_id", byTitle.T1.external_id).single()).data;
  check("it renamed it", fresh?.title === "Black Friday, renamed");
  check("with the status in the import's case", fresh?.status === "EXPIRED");
  // The half that matters: a thin payload must not blank the rich row.
  check("and did not blank the percentage", Number(fresh?.percent_off) === 80);
  check("nor the codes", String(fresh?.codes) === "BLACKFRIDAY,BF2026");
  check("nor Shopify's sentence", (fresh?.summary ?? "").startsWith("80% off"));

  console.log("\nand a discount Shopify has never heard of is not invented");
  const before = (await admin.from("discounts").select("id", { count: "exact", head: true }).eq("store_id", store.id)).count;
  const { data: madeUp } = await admin.rpc("abo_shopify_upsert_discount", {
    p_shop: shop,
    p_d: { id: "999999999999", title: "Not ours", status: "active" },
  });
  check("an unknown numeric id writes nothing", madeUp === 0);
  const after = (await admin.from("discounts").select("id", { count: "exact", head: true }).eq("store_id", store.id)).count;
  check("and adds no row", after === before);

  console.log("\nand deleting one reaches it by either name");
  const numeric = byTitle.T3.external_id.split("/").pop();
  const { data: removed } = await admin.rpc("abo_shopify_delete_discount", { p_shop: shop, p_id: numeric });
  check("a numeric id finds the campaign", removed === 1);
  check("and it is gone", !(await admin.from("discounts").select("id").eq("external_id", byTitle.T3.external_id)).data?.length);
} finally {
  await admin.from("projects").delete().eq("id", project.id);
  console.log("\nthe project is gone");
}

console.log(fails.length === 0 ? "\nthe campaigns read the way a merchant reads them" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
