// The store address, as the connect route reads it.
//
// check-shopify holds the reading itself. This holds the route: that
// what a merchant typed reaches the reader, that what it refuses comes
// back as a 400 with the hint the box shows, and that nothing a person
// can send — a number, a list, a script — becomes a 500.
//
// A deployment with Shopify configured answers a good address with the
// URL of that store's own approval screen, and that is checked. One
// without it (the check database's) answers 503, which still proves
// the address was read and accepted, because a bad one is refused
// before the route looks at its settings.
//
//   ENV_FILE=.env.check.local APP_URL=http://127.0.0.1:3102 node scripts/check-connect-address.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

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

const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const me = await signInAsCheckUser(client, env);
if (!me.session) {
  console.log(`could not sign in as the check user — ${me.why}`);
  process.exit(1);
}
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const project = await throwawayProject(admin, me.user.id, "connect-address");

const install = async (shop, token = me.session.access_token) => {
  const res = await fetch(`${APP}/api/shopify/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ projectId: project.id, shop }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

try {
  console.log("nobody signed in gets nowhere");
  check("no session, 401", (await install("mystore", null)).status === 401);

  console.log("\nwhat is not a store comes back as a 400, with somewhere to go");
  for (const [what, shop] of [
    ["the store's name rather than its address", "My Store"],
    ["the suffix trick", "evil.com?x=.myshopify.com"],
    ["a store before an @", "https://mystore.myshopify.com@evil.com"],
    ["Shopify's admin with no store in it", "https://admin.shopify.com/settings"],
    ["a script", "javascript:alert(1)"],
    ["a page of text", "a".repeat(5000)],
  ]) {
    const r = await install(shop);
    check(`${what}: 400 with a reason`, r.status === 400 && typeof r.body.error === "string" && r.body.error.length > 0);
  }
  const custom = await install("mystore.com");
  check("a shop's own domain: 400", custom.status === 400);
  check("and the hint says where the real address is", /Domains/.test(custom.body.hint ?? ""));

  console.log("\nand what a person cannot type is refused, not crashed on");
  for (const [what, shop] of [
    ["a number", 42],
    ["a list", ["mystore"]],
    ["an object", { shop: "mystore" }],
  ]) {
    check(`${what}: 400`, (await install(shop)).status === 400);
  }

  console.log("\nand every way a merchant writes their store reaches the same one");
  // A name nobody owns, so a configured deployment makes a pending row
  // for a store that cannot exist, under a project that is removed.
  const handle = `wl-check-${Date.now().toString(36)}`;
  const domain = `${handle}.myshopify.com`;
  let configured = false;
  for (const [what, shop] of [
    ["the bare name", handle],
    ["in capitals", domain.toUpperCase()],
    ["copied from the browser", `https://${domain}/admin/orders`],
    ["the new admin's address", `https://admin.shopify.com/store/${handle}/products`],
  ]) {
    const r = await install(shop);
    if (r.status === 503) {
      check(`${what}: read and accepted (Shopify is not configured here)`, true);
      continue;
    }
    configured = true;
    const to = typeof r.body.url === "string" ? new URL(r.body.url) : null;
    check(`${what}: sent to ${domain}'s own approval screen`, r.status === 200 && to?.hostname === domain);
  }

  // One row per store however it was written, not one per spelling —
  // and none at all where nothing was sent to Shopify.
  const { data: rows } = await admin.from("stores").select("shop_domain").eq("project_id", project.id);
  check(
    configured ? "one store, however many ways it was written" : "and nothing was written",
    (rows ?? []).length === (configured ? 1 : 0) && (rows ?? []).every((r) => r.shop_domain === domain)
  );
} finally {
  await project.remove();
}

console.log(fails.length === 0 ? "\nthe address is read the way it was meant" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
