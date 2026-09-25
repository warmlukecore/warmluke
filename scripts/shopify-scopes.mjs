// What Shopify says about a connected store: what its token may do,
// and whether the webhooks this app asks for are real.
//
// Not a check — it needs a real store and a real Shopify, so it runs
// by hand. It exists because "did that reconnect take?" had no cheap
// answer: the row said connected, the token worked, and the only way
// to learn that it was a token from before the scopes were widened
// was to call a field and read the refusal.
//
// Two answers, side by side, because they can disagree:
//   what Shopify says the token holds  — the truth, asked live
//   what we recorded at the grant      — stores.granted_scopes (0102)
// A store connected before 0102 has recorded nothing yet; it fills
// itself in at the next token renewal.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/shopify-scopes.mjs
//   ENV_FILE=.env.check.local node … scripts/shopify-scopes.mjs
//   … scripts/shopify-scopes.mjs some-shop.myshopify.com

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { SHOPIFY_API_VERSION } from "../src/lib/shopify.ts";
import { ensureFreshToken } from "../src/lib/shopify-import.ts";
import { missingScopes, scopesFor, WEBHOOK_TOPICS } from "../src/lib/shopify-resources.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
// ensureFreshToken renews through the app's own credentials, which
// live in the env file rather than in this process.
Object.assign(process.env, env);

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const wanted = process.argv[2];

let q = admin.from("stores").select("*").eq("status", "connected");
if (wanted) q = q.eq("shop_domain", wanted);
const { data: stores, error } = await q;
if (error) {
  console.log(`could not read the stores: ${error.message}`);
  process.exit(1);
}
if (!stores?.length) {
  console.log(wanted ? `no connected store called ${wanted}` : "no connected store");
  process.exit(0);
}

const asked = scopesFor();
for (const store of stores) {
  console.log(`\n${store.shop_domain}`);
  let live = null;
  try {
    const token = await ensureFreshToken(admin, store);
    const r = await fetch(`https://${store.shop_domain}/admin/oauth/access_scopes.json`, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    // Same endpoint the Admin API serves everything else from, so a
    // 401 here means the token is dead rather than merely narrow.
    if (!r.ok) throw new Error(`Shopify answered ${r.status} (API ${SHOPIFY_API_VERSION})`);
    live = ((await r.json()).access_scopes ?? []).map((s) => s.handle).sort();
  } catch (e) {
    console.log(`  could not ask Shopify: ${e instanceof Error ? e.message : e}`);
  }

  const recorded = store.granted_scopes ?? null;
  console.log(`  Shopify says : ${live ? live.join(", ") : "—"}`);
  console.log(
    `  we recorded  : ${recorded ? [...recorded].sort().join(", ") : "nothing yet (fills in at the next renewal)"}`
  );

  const short = live ? asked.filter((s) => !live.includes(s)) : missingScopes(recorded);
  console.log(
    `  the install asks for ${asked.length}; still missing ${short.length}${short.length ? ": " + short.join(", ") : ""}`
  );
  if (short.length) console.log("  → a reconnect that finishes is what grants these. Starting one is not enough.");

  // Which ones differ, not merely that some do. Shopify's own two
  // answers — the grant and access_scopes.json — do not always agree
  // to the letter, and "they disagree" with no names attached sends
  // somebody hunting a bug that is not here.
  if (live && recorded) {
    const held = new Set(recorded);
    const onlyLive = live.filter((sc) => !held.has(sc));
    const onlyOurs = [...recorded].filter((sc) => !live.includes(sc)).sort();
    if (onlyLive.length || onlyOurs.length) {
      console.log("  the two answers differ. Shopify's is the one that counts:");
      if (onlyLive.length) console.log(`     Shopify has, we did not record: ${onlyLive.join(", ")}`);
      if (onlyOurs.length) console.log(`     we recorded, Shopify does not list: ${onlyOurs.join(", ")}`);
      const matters = [...onlyOurs, ...onlyLive].filter((sc) => asked.includes(sc));
      console.log(
        matters.length
          ? `     of those, these are ones the install asks for: ${matters.join(", ")}`
          : "     none of them is a scope this app asks for, so nothing here is broken."
      );
    }
  }

  // And the topics, against the enum Shopify actually publishes. A
  // topic misspelled in WEBHOOK_TOPICS is not an error anyone sees:
  // the subscription fails, the store stops being kept fresh, and
  // the only trace is one line in stores.webhook_error. Asked here
  // rather than in a check because a check has no real Shopify.
  try {
    const token = await ensureFreshToken(admin, store);
    const r = await fetch(`https://${store.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: '{ __type(name: "WebhookSubscriptionTopic") { enumValues(includeDeprecated: false) { name } } }',
      }),
    });
    const real = new Set(((await r.json()).data?.__type?.enumValues ?? []).map((v) => v.name));
    if (real.size === 0) throw new Error("Shopify named no topics");
    const invented = WEBHOOK_TOPICS.filter((t) => !real.has(t));
    console.log(`  webhooks     : ${WEBHOOK_TOPICS.length} asked for, ${invented.length} that Shopify does not have`);
    for (const t of invented)
      console.log(`     → ${t} is not a topic. Its subscription will fail and this list will go stale.`);
  } catch (e) {
    console.log(`  could not check the topics: ${e instanceof Error ? e.message : e}`);
  }
}
