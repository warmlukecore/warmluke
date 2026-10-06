// Scout on the database (0189): the seeded shop profiled for its owner, in
// one call, with the fields and values its rows really hold; nothing of it
// for an account that cannot see that shop. Read-only.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-scout-live.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, signInAsOwner } from "./owner-session.mjs";
import { profileStore, scoutLines } from "../src/lib/scout.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log("not a check project: this reads the seeded shop, which is only there");
  process.exit(0);
}
const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const { data: shop } = await admin
  .from("stores")
  .select("id, project_id")
  .eq("shop_domain", "seed-shop.myshopify.com")
  .eq("status", "connected")
  .maybeSingle();
if (!shop) {
  console.log("no seeded shop on this database — nothing to check");
  process.exit(0);
}
const { data: owned } = await admin.from("projects").select("owner_id").eq("id", shop.project_id).single();
const { data: ownerUser } = await admin.auth.admin.getUserById(owned.owner_id);
const as = async (signIn) => {
  const c = createClient(url, anon);
  const s = await signIn(c);
  return s.session
    ? createClient(url, anon, { global: { headers: { Authorization: `Bearer ${s.session.access_token}` } } })
    : null;
};
const owner = await as((c) => signInAsOwner(c, env, ownerUser.user.email));
const stranger = await as((c) => signInAsCheckUser(c, env));
if (!owner || !stranger) {
  console.log("could not sign in the owner and a stranger");
  process.exit(1);
}

console.log("the owner");
const t0 = Date.now();
const profile = await profileStore(owner, shop.id);
const ms = Date.now() - t0;
const orders = profile?.store_orders;
check("the shop is profiled in one call", !!orders && orders.sampled > 0);
check(`quickly (${ms} ms)`, ms < 3000);
check("its orders' status, with how many hold each", (orders?.columns?.status?.values?.PAID ?? 0) > 0);
check("an id is not taken for a category", orders?.columns?.id?.values == null);
const brief = scoutLines(profile ?? {}, {});
check(
  "the brief names the orders' fields",
  brief.some((l) => l.startsWith("  orders ") && l.includes("order_number text") && l.includes("status badge {"))
);

console.log("\nsomeone who cannot see the shop");
const theirs = await profileStore(stranger, shop.id);
check("reads none of it", theirs !== null && Object.keys(theirs).length === 0);

console.log(fails.length === 0 ? "\nthe store is scouted for its owner alone" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
