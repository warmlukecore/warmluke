// Point a store's webhooks at this deployment.
//
// New stores get this at connect. This is for the ones connected
// before that existed, and for moving a store's webhooks to a
// different URL — a preview deployment, or production after testing
// against localhost.
//
// Not a check: it changes the real Shopify app's subscriptions. It
// prints what it did and then lists what the store actually has, so
// the answer comes from Shopify rather than from this script's hopes.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/subscribe-webhooks.mjs
//   APP_URL=https://warmluke.vercel.app node ... scripts/subscribe-webhooks.mjs
//
// Callers: none. Run by hand.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { ensureFreshToken, graphql } from "../src/lib/shopify-import.ts";
import { subscribeWebhooks } from "../src/lib/shopify-webhooks.ts";
import { webhookAddress } from "../src/lib/shopify.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
// Renewing a token needs the app's own credentials, and this runs
// with no signed-in user.
Object.assign(process.env, env);

const APP = process.env.APP_URL ?? "https://warmluke.vercel.app";
const SECRET = env.SHOPIFY_CLIENT_SECRET;
const db = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);

const { data: stores } = await db
  .from("stores")
  .select("id, shop_domain, access_token, refresh_token, token_expires_at")
  .eq("status", "connected");

if (!stores?.length) {
  console.log("no connected stores");
  process.exit(0);
}

for (const store of stores) {
  // Each store has its own address; the last segment is what the
  // database looks the store up from, so a delivery cannot claim to be
  // from a shop it did not come from.
  const address = `${APP}/api/shopify/webhooks/${webhookAddress(store.shop_domain, SECRET)}`;
  console.log(`${store.shop_domain} → ${address}`);
  const token = await ensureFreshToken(db, store);

  const result = await subscribeWebhooks(store.shop_domain, token, address);
  if (result.added.length) console.log(`  added    ${result.added.join(", ")}`);
  if (result.moved.length) console.log(`  moved    ${result.moved.join(", ")}`);
  if (result.already.length) console.log(`  already  ${result.already.length} topics`);
  for (const f of result.failed) console.log(`  FAILED   ${f}`);

  // What Shopify says it will actually send, which is the only
  // answer that counts.
  const live = await graphql(
    store.shop_domain,
    token,
    `{ webhookSubscriptions(first: 50) {
         nodes { topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
       } }`
  );
  const nodes = live.webhookSubscriptions.nodes ?? [];
  console.log(`\n  Shopify will send ${nodes.length}:`);
  for (const n of nodes) {
    const url = n.endpoint?.callbackUrl ?? n.endpoint?.__typename ?? "?";
    console.log(`    ${n.topic.padEnd(26)} ${url}`);
  }
}
