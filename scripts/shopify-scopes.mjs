// What a connected store's token is actually allowed to do.
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
import { missingScopes, scopesFor } from "../src/lib/shopify-resources.ts";

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
  console.log(`  we recorded  : ${recorded ? [...recorded].sort().join(", ") : "nothing yet (fills in at the next renewal)"}`);

  const short = live ? asked.filter((s) => !live.includes(s)) : missingScopes(recorded);
  console.log(`  the install asks for ${asked.length}; still missing ${short.length}${short.length ? ": " + short.join(", ") : ""}`);
  if (short.length) console.log("  → a reconnect that finishes is what grants these. Starting one is not enough.");

  // Worth saying out loud: it means a reconnect happened somewhere
  // this deployment did not write down, or the renewal has not run.
  if (live && recorded && [...recorded].sort().join(",") !== live.join(",")) {
    console.log("  → what we recorded disagrees with Shopify. Shopify is right.");
  }
}
