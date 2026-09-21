// The checks that decide whether a Shopify callback is real.
//
// None of this needs a Shopify account, and all of it runs on input a
// browser handed us. A loose domain test sends a merchant's
// authorization to somebody else's server; an unverified signature hands
// a token to whoever asks. Both look like working code until they don't.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-shopify.mjs

import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import {
  authorizeUrl,
  normalizeShopDomain,
  verifyCallbackHmac,
  verifyWebhookHmac,
  tokenNeedsRefresh,
} from "../src/lib/shopify.ts";
import {
  EXTENDED_ORDER_HISTORY_SCOPE,
  PLANNED_SCOPES,
  RESOURCES,
  SHOPIFY_RESOURCES,
  SHOPIFY_SCOPES,
  WEBHOOK_TOPICS,
  scopesFor,
} from "../src/lib/shopify-resources.ts";
import { COUNTED } from "../src/lib/store-read.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const refuses = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

console.log("\nonly a real shop domain gets through");
check("a normal store is accepted", normalizeShopDomain("carefone.myshopify.com") === "carefone.myshopify.com");
check("case and spaces are normalised", normalizeShopDomain("  CareFone.MyShopify.com ") === "carefone.myshopify.com");
check("hyphens are fine", normalizeShopDomain("care-fone-2.myshopify.com").startsWith("care-fone-2"));
check("a lookalike host is refused", refuses(() => normalizeShopDomain("evil.com")));
check("a suffix trick is refused", refuses(() => normalizeShopDomain("evil.com?x=.myshopify.com")));
check("a prefix trick is refused", refuses(() => normalizeShopDomain("notmyshopify.com")));
check("a subdomain trick is refused", refuses(() => normalizeShopDomain("shop.myshopify.com.evil.com")));
check("a leading hyphen is refused", refuses(() => normalizeShopDomain("-shop.myshopify.com")));
check("an empty domain is refused", refuses(() => normalizeShopDomain("")));
check("an overlong domain is refused", refuses(() => normalizeShopDomain("a".repeat(260) + ".myshopify.com")));

console.log("\nthe authorize URL asks for read access and nothing more");
const url = new URL(
  authorizeUrl({
    shop: "carefone.myshopify.com",
    clientId: "test-client",
    redirectUri: "https://warmluke.vercel.app/api/shopify/callback",
    state: "abc-123",
    scopes: scopesFor({}),
  })
);
check("it points at the merchant's own store", url.host === "carefone.myshopify.com");
check("it carries the state back", url.searchParams.get("state") === "abc-123");
check("every scope is a read", SHOPIFY_SCOPES.every((s) => s.startsWith("read_")));
check("no write scope is requested", !url.searchParams.get("scope")?.includes("write_"));
check("a bad shop cannot build a URL", refuses(() => authorizeUrl({ shop: "evil.com", clientId: "x", redirectUri: "y", state: "z", scopes: [] })));

console.log("\nthe scope Shopify has to approve stays out until it has");
// Asking for an unapproved scope fails the whole authorization, not
// just that one scope — so a store that would otherwise connect
// perfectly well cannot connect at all.
check("it is absent by default", !scopesFor({}).includes(EXTENDED_ORDER_HISTORY_SCOPE));
check("it is absent when the flag is off", !scopesFor({ SHOPIFY_READ_ALL_ORDERS: "false" }).includes(EXTENDED_ORDER_HISTORY_SCOPE));
check("it appears once the flag is on", scopesFor({ SHOPIFY_READ_ALL_ORDERS: "true" }).includes(EXTENDED_ORDER_HISTORY_SCOPE));
check("the other scopes are unaffected", SHOPIFY_SCOPES.every((sc) => scopesFor({}).includes(sc)));
check("the authorize URL never carries it by default", !url.searchParams.get("scope")?.includes(EXTENDED_ORDER_HISTORY_SCOPE));

console.log("\neach resource is declared once, and the rest is derived from it");
check("every resource asks for at least one scope", RESOURCES.every((r) => SHOPIFY_RESOURCES[r].scopes.length > 0));
check("every scope a resource asks for is in the install", RESOURCES.every((r) => SHOPIFY_RESOURCES[r].scopes.every((s) => SHOPIFY_SCOPES.includes(s))));
check("no scope is asked for twice", new Set(SHOPIFY_SCOPES).size === SHOPIFY_SCOPES.length);
// Asked for ahead of the resource that will use them, so that every
// merchant reconnects once rather than once per pack. The moment a
// resource claims one, it must leave this list — two declarations of
// the same scope is how one of them goes stale.
const claimed = new Set(RESOURCES.flatMap((r) => SHOPIFY_RESOURCES[r].scopes));
for (const s of PLANNED_SCOPES) {
  check(`"${s}" is still waiting for its resource`, !claimed.has(s));
}
check("every planned scope is a read", PLANNED_SCOPES.every((s) => s.startsWith("read_")));
check("and is in what the install asks for", PLANNED_SCOPES.every((s) => SHOPIFY_SCOPES.includes(s)));
check("every resource writes at least one table", RESOURCES.every((r) => SHOPIFY_RESOURCES[r].tables.length > 0));
check("a resource with no bulk road still has a page", RESOURCES.every((r) => SHOPIFY_RESOURCES[r].bulk || SHOPIFY_RESOURCES[r].page.includes("$after")));

// store-read cannot import the registry — the chat panel imports it,
// and the registry reaches node:crypto — so the two lists are kept
// apart and made to agree here. A resource that gains a table nobody
// counts shows a store as smaller than it is, and drift is measured
// off those counts.
const written = [...new Set(RESOURCES.flatMap((r) => SHOPIFY_RESOURCES[r].tables))];
for (const t of written) check(`"${t}" is counted in a store's copy`, COUNTED.includes(t));
for (const t of COUNTED) check(`"${t}" is a table some resource writes`, written.includes(t));
check("no topic is listened for twice", new Set(WEBHOOK_TOPICS).size === WEBHOOK_TOPICS.length);
check("a child limit names a real path", RESOURCES.every((r) => SHOPIFY_RESOURCES[r].children.every((c) => c.path.length > 0 && c.limit > 0)));

// A topic subscribed in TypeScript and unhandled in SQL is a webhook
// that arrives, is signed, and is dropped on the floor — the store goes
// stale on exactly the events it asked to hear about. The database's
// dispatcher is the latest migration that defines it.
console.log("\nevery topic a resource listens for lands somewhere in the database");
const DEFINES = "create or replace function public.abo_shopify_webhook(";
const migrations = readdirSync(new URL("../supabase/migrations", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();
const defines = migrations.filter((f) =>
  readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8").includes(DEFINES)
);
const dispatcher = readFileSync(new URL(`../supabase/migrations/${defines.at(-1)}`, import.meta.url), "utf8");
const fn = dispatcher.slice(dispatcher.indexOf(DEFINES));
const handled = new Set([...fn.matchAll(/'([a-z_]+\/[a-z_]+)'/g)].map((m) => m[1]));
// ORDERS_CREATE on the wire is orders/create in the header Shopify sends.
const wire = (t) => t.toLowerCase().replace(/_([a-z]+)$/, "/$1");
check("the dispatcher was found", defines.length > 0 && handled.size > 0);
for (const t of WEBHOOK_TOPICS) check(`${t} has a handler`, handled.has(wire(t)));
const subscribed = new Set(WEBHOOK_TOPICS.map(wire));
for (const t of handled) check(`${t} is subscribed`, subscribed.has(t));

console.log("\na callback has to be signed by Shopify");
const SECRET = "shpss_test_secret";
const sign = (params) => {
  const message = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", SECRET).update(message).digest("hex");
};
const now = new Date();
const base = {
  shop: "carefone.myshopify.com",
  code: "the-code",
  state: "abc-123",
  timestamp: String(Math.floor(now.getTime() / 1000)),
};
const good = { ...base, hmac: sign(base) };

check("a genuine callback passes", !refuses(() => verifyCallbackHmac(good, SECRET, now)));
check("a tampered shop is refused", refuses(() => verifyCallbackHmac({ ...good, shop: "evil.myshopify.com" }, SECRET, now)));
check("a swapped code is refused", refuses(() => verifyCallbackHmac({ ...good, code: "other-code" }, SECRET, now)));
check("a missing signature is refused", refuses(() => verifyCallbackHmac(base, SECRET, now)));
check("a wrong secret is refused", refuses(() => verifyCallbackHmac(good, "wrong-secret", now)));
check("a malformed signature is refused", refuses(() => verifyCallbackHmac({ ...good, hmac: "nothex" }, SECRET, now)));
check("a short signature is refused", refuses(() => verifyCallbackHmac({ ...good, hmac: "ab".repeat(8) }, SECRET, now)));

console.log("\nand it has to be recent");
const old = { ...base, timestamp: String(Math.floor(now.getTime() / 1000) - 600) };
check("a ten-minute-old callback is refused", refuses(() => verifyCallbackHmac({ ...old, hmac: sign(old) }, SECRET, now)));
const future = { ...base, timestamp: String(Math.floor(now.getTime() / 1000) + 600) };
check("a future-dated callback is refused", refuses(() => verifyCallbackHmac({ ...future, hmac: sign(future) }, SECRET, now)));
const fresh = { ...base, timestamp: String(Math.floor(now.getTime() / 1000) - 60) };
check("a one-minute-old callback still passes", !refuses(() => verifyCallbackHmac({ ...fresh, hmac: sign(fresh) }, SECRET, now)));
check("a missing timestamp is refused", refuses(() => verifyCallbackHmac({ ...good, timestamp: undefined }, SECRET, now)));

console.log("\nand a webhook body has to be signed too");
const body = JSON.stringify({ shop_domain: "acme.myshopify.com", customer: { id: 12345 } });
const digest = (b, secret = SECRET) => createHmac("sha256", secret).update(b, "utf8").digest("base64");
check("a correctly signed body passes", !refuses(() => verifyWebhookHmac(body, digest(body), SECRET)));
check("an unsigned body is refused", refuses(() => verifyWebhookHmac(body, null, SECRET)));
check("a body signed with another secret is refused", refuses(() => verifyWebhookHmac(body, digest(body, "wrong"), SECRET)));
// The one that matters: a tampered body keeps the old, still-valid-looking
// signature. Verifying the parsed object instead of the bytes would pass this.
const tampered = JSON.stringify({ shop_domain: "attacker.myshopify.com", customer: { id: 12345 } });
check("a tampered body is refused", refuses(() => verifyWebhookHmac(tampered, digest(body), SECRET)));
check("a short signature is refused", refuses(() => verifyWebhookHmac(body, "YWJj", SECRET)));

console.log("\nand an expiring token is renewed before it dies");
const at = (mins) => new Date(now.getTime() + mins * 60_000).toISOString();
check("a token with an hour left is left alone", !tokenNeedsRefresh(at(60), now));
check("a token with two minutes left is left alone", !tokenNeedsRefresh(at(2), now));
// Renewed early on purpose: one that passes the check and then dies
// mid-import fails halfway through, with rows already written.
check("a token with thirty seconds left is renewed", tokenNeedsRefresh(at(0.5), now));
check("an already-expired token is renewed", tokenNeedsRefresh(at(-10), now));
// A store connected before expiring tokens has nothing to refresh with.
// Reporting it as refreshable would send it into a refresh that cannot
// work, instead of telling the merchant to reconnect.
check("a store with no expiry is not called refreshable", !tokenNeedsRefresh(null, now));
check("an unparseable expiry is not called refreshable", !tokenNeedsRefresh("whenever", now));

console.log(fails.length === 0 ? "\nevery guard holds" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
