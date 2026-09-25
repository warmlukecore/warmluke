// What each resource's page query costs Shopify to run.
//
// Not a check: it needs a real store, and no check has one. It
// exists because a query can be perfectly valid and still refused.
// Shopify prices a query BEFORE running it, from what it asks for
// rather than what comes back, and refuses anything over 1000. So a
// three-level query priced at 1598 fails on every store in the
// world, empty or not — and nothing in the build says a word,
// because the schema is happy and the fixtures never call Shopify.
//
// That is exactly how the returns query shipped broken. Run this
// after adding or widening any page query.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/shopify-query-cost.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { SHOPIFY_API_VERSION } from "../src/lib/shopify.ts";
import { ensureFreshToken, PAGE } from "../src/lib/shopify-import.ts";
import { RESOURCES, SHOPIFY_RESOURCES } from "../src/lib/shopify-resources.ts";

/** Shopify's ceiling for one query. Not ours to change. */
const LIMIT = 1000;

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
Object.assign(process.env, env);

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const { data: store } = await admin.from("stores").select("*").eq("status", "connected").limit(1).maybeSingle();
if (!store) {
  console.log("no connected store — nothing to price against");
  process.exit(0);
}
const token = await ensureFreshToken(admin, store);

const price = async (query) => {
  const r = await fetch(`https://${store.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { n: PAGE, after: null } }),
  });
  const body = await r.json();
  // On a refusal the cost is only in the message; on success it is
  // in the extensions. Both are the same number.
  const refused = (body.errors ?? []).find((e) => /exceeds the single query max cost/.test(e.message));
  return {
    cost: refused
      ? Number(/cost is (\d+)/.exec(refused.message)?.[1] ?? NaN)
      : (body.extensions?.cost?.requestedQueryCost ?? null),
    refused: !!refused,
    other: !refused && body.errors ? String(body.errors[0].message).split("\n")[0] : null,
  };
};

console.log(`${store.shop_domain}, API ${SHOPIFY_API_VERSION}, PAGE=${PAGE}, ceiling ${LIMIT}\n`);
let over = 0;
for (const resource of RESOURCES) {
  const { cost, refused, other } = await price(SHOPIFY_RESOURCES[resource].page);
  const bar = cost === null ? "" : "█".repeat(Math.max(1, Math.round((cost / LIMIT) * 30)));
  const note = refused ? "  REFUSED — over the ceiling" : other ? `  (${other.slice(0, 60)})` : "";
  if (refused) over++;
  console.log(`  ${resource.padEnd(12)} ${String(cost ?? "?").padStart(5)}  ${bar}${note}`);
}
console.log(
  over ? `\n${over} query/queries would be refused on every store.` : "\nevery page query fits inside one request."
);
process.exit(over === 0 ? 0 : 1);
