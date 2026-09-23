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
  grantedScopes,
  normalizeShopDomain,
  verifyCallbackHmac,
  verifyWebhookHmac,
  tokenNeedsRefresh,
} from "../src/lib/shopify.ts";
import {
  EXTENDED_ORDER_HISTORY_SCOPE,
  missingScopes,
  PLANNED_SCOPES,
  RESOURCES,
  SHOPIFY_RESOURCES,
  SHOPIFY_SCOPES,
  WEBHOOK_TOPICS,
  scopesFor,
} from "../src/lib/shopify-resources.ts";
import { COUNTED } from "../src/lib/store-read.ts";
import { ACTION_SCOPES } from "../src/lib/store-actions.ts";
import { readShopAddress } from "../src/lib/shop-address.ts";

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

// ── What a merchant types, read the way they mean it ─────────────
//
// The connect box took one spelling and refused the rest, so a
// merchant who typed their store's name, or pasted its address from
// the browser, was told they were wrong about their own shop. The
// risk in forgiving is reading something that is not a store as if it
// were one, so the half of this that matters most is the refusals.
console.log("\nand what a merchant types is read the way they mean it");
{
  const reads = (input, want) => {
    const r = readShopAddress(input);
    return "domain" in r && r.domain === want;
  };
  const refused = (input) => "error" in readShopAddress(input);
  const W = "mystore.myshopify.com";

  // The spellings a real person has to hand.
  check("the bare name", reads("mystore", W));
  check("the full address", reads(W, W));
  check("in capitals, with spaces round it", reads("  MyStore.MyShopify.com  ", W));
  check("copied with https and a path", reads("https://mystore.myshopify.com/admin/orders?page=2", W));
  check("with http", reads("http://mystore.myshopify.com", W));
  check("the new admin's address", reads("https://admin.shopify.com/store/mystore/products/123", W));
  check("the new admin without https", reads("admin.shopify.com/store/mystore", W));
  check("in quotes, from a chat", reads('"mystore.myshopify.com"', W));
  check("with a full stop after it", reads("mystore.myshopify.com.", W));
  check("with www in front", reads("www.mystore.myshopify.com", W));
  check("with a port", reads("mystore.myshopify.com:443", W));
  check("the name with a slash after it", reads("mystore/", W));
  check("hyphens and digits", reads("my-store-2", "my-store-2.myshopify.com"));
  check("the name with only a scheme", reads("https://mystore", W));
  check("in curly quotes, as a document writes them", reads("\u201cmystore.myshopify.com\u201d", W));
  check("with a zero-width space pasted into it", reads("mystore\u200b.myshopify.com", W));
  // Userinfo looks like a host and is not. Here the real host is the store.
  check("junk before an @ does not change the store", reads("https://anything@mystore.myshopify.com", W));

  // Nothing that is not a store gets read as one.
  check("nothing typed", refused("   "));
  check("the store's name rather than its address", refused("My Store"));
  check("the suffix trick", refused("evil.com?x=.myshopify.com"));
  check("the subdomain trick", refused("shop.myshopify.com.evil.com"));
  // The dangerous way round: it looks like the store and goes to evil.com.
  check("a store before an @ is not the host", refused("https://mystore.myshopify.com@evil.com"));
  check("a leading hyphen", refused("-shop"));
  check("a store inside a store", refused("a.b.myshopify.com"));
  check("myshopify.com on its own", refused("myshopify.com"));
  check("Shopify's admin with no store in it", refused("https://admin.shopify.com/settings"));
  check("an admin path with no handle", refused("admin.shopify.com/store/"));
  check("a script instead of an address", refused("javascript:alert(1)"));
  check("another scheme", refused("ftp://mystore.myshopify.com"));
  check("a page of text", refused("a".repeat(5000)));
  check("not a string at all", refused(undefined) && refused(null) && refused(42));
  // A garbled scheme must not leave "https" or "http" to be read as a store.
  check("a scheme written twice", refused("https://https://mystore.myshopify.com"));
  check("a scheme missing its colon", refused("http//mystore.myshopify.com"));
  check("a name with something after it", refused("mystore/admin") && refused("mystore:8080"));
  check("a name in another script", refused("\u092e\u0947\u0930\u093e\u0938\u094d\u091f\u094b\u0930"));
  const shopifys = readShopAddress("mystore.shopify.com");
  check("Shopify's own site, one letter short", "error" in shopifys && !/own domain/.test(shopifys.hint ?? ""));
  check("Shopify's sign-in page", refused("https://accounts.shopify.com/store-login"));

  // A custom domain is refused with somewhere to go, not a guess.
  const custom = readShopAddress("mystore.com");
  check("a shop's own domain is refused", "error" in custom);
  check("and names what they typed", /mystore\.com/.test(custom.error ?? ""));
  check("and says where the real address is", /Settings/.test(custom.hint ?? "") && /Domains/.test(custom.hint ?? ""));

  // Whatever the road, the answer passes the check the callback uses.
  const inputs = ["mystore", "MyStore.myshopify.com", "https://admin.shopify.com/store/abc-9", "x/", "a1.myshopify.com"];
  const accepted = inputs.map(readShopAddress).filter((r) => "domain" in r);
  check("what it accepts, the strict check accepts too",
    accepted.length === inputs.length && accepted.every((r) => !refuses(() => normalizeShopDomain(r.domain))));

  // The callback reads what came back from Shopify and must stay
  // strict: forgiveness is for people typing, never for a redirect
  // somebody could have forged.
  const callback = readFileSync(new URL("../src/app/api/shopify/callback/route.ts", import.meta.url), "utf8");
  const install = readFileSync(new URL("../src/app/api/shopify/install/route.ts", import.meta.url), "utf8");
  check("the callback still reads Shopify's answer strictly", /normalizeShopDomain\(q\.shop/.test(callback));
  check("and never the forgiving way", !/readShopAddress/.test(callback));
  check("the install reads what was typed the forgiving way", /readShopAddress\(shop\)/.test(install));
  check("and still holds the answer to the strict check", /normalizeShopDomain\(read\.domain\)/.test(install));
}

console.log("\nthe authorize URL asks for the reads, and only the writes an action needs");
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
check("every resource scope is a read", SHOPIFY_SCOPES.every((s) => s.startsWith("read_")));
// This used to say "no write scope is requested", and that was the
// guarantee while the app could only read. It cannot say that any
// more — so it says the stronger thing instead: the only writes
// asked for are the ones an action in the registry declares, and
// all of them are. A write scope nobody's action needs is
// permission nobody can account for, and it would ride in on the
// next reconnect without a line of code asking for it.
const askedFor = (url.searchParams.get("scope") ?? "").split(",").filter(Boolean);
const writesAsked = askedFor.filter((s) => s.startsWith("write_"));
check(
  "no write is asked for that no action needs",
  writesAsked.every((s) => ACTION_SCOPES.includes(s))
);
check(
  "and every write an action needs is asked for",
  ACTION_SCOPES.every((s) => writesAsked.includes(s))
);
check("nothing is asked for that is neither a read nor an action's write", askedFor.every((s) => s.startsWith("read_") || ACTION_SCOPES.includes(s)));
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

console.log("\nwhat a grant came with is read from the grant");
// Shopify reports the granted scopes as one comma-separated string,
// and how it spaces them is not ours to rely on.
check("a plain list is split", String(grantedScopes("read_orders,read_products")) === "read_orders,read_products");
check("spaces around the commas are dropped", String(grantedScopes(" read_orders , read_products ")) === "read_orders,read_products");
check("a single scope is a list of one", grantedScopes("read_orders")?.length === 1);
// Null, never [], for every shape of nothing: a store whose grant was
// never recorded is unknown, and a caller that reads [] as "granted
// nothing" will refuse a token that works.
check("an empty string is unknown, not empty", grantedScopes("") === null);
check("undefined is unknown", grantedScopes(undefined) === null);
check("a string of only commas is unknown", grantedScopes(" , , ") === null);

console.log("\nand what is missing is measured against it");
check("an unknown grant reports nothing missing", missingScopes(null).length === 0);
check("an empty grant is treated as unknown too", missingScopes([]).length === 0);
check("a full grant reports nothing missing", missingScopes(scopesFor({}), {}).length === 0);
// The case this exists for: a token from before the scopes were added.
const older = scopesFor({}).filter((s) => !PLANNED_SCOPES.includes(s));
check("a grant from before the new scopes names them", PLANNED_SCOPES.every((s) => missingScopes(older, {}).includes(s)));
check("and names nothing the token already holds", missingScopes(older, {}).every((s) => !older.includes(s)));
// A grant wider than the install asked for is a reconnect from a
// deployment that asked for more, not a fault.
check("a wider grant reports nothing missing", missingScopes([...scopesFor({}), "read_themes"], {}).length === 0);
check("the flag-gated scope counts once it is asked for", missingScopes(scopesFor({}), { SHOPIFY_READ_ALL_ORDERS: "true" }).includes(EXTENDED_ORDER_HISTORY_SCOPE));

console.log("\nand the callback and the function agree on the arguments");
// PostgREST refuses an rpc call naming a parameter the function does
// not have, and it refuses it at runtime, in the one request nobody
// can retry — the merchant is already back from Shopify with a code
// that is spent. Nothing else in the build compares these two.
const CONNECT = "create or replace function public.abo_shopify_connect(";
const connectIn = migrations.filter((f) =>
  readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8").toLowerCase().includes(CONNECT)
);
const connectSql = readFileSync(new URL(`../supabase/migrations/${connectIn.at(-1)}`, import.meta.url), "utf8");
const signature = connectSql.slice(connectSql.toLowerCase().indexOf(CONNECT)).split(") returns")[0];
const declared = new Set([...signature.matchAll(/^\s*(p_[a-z_]+)\s+\S/gm)].map((m) => m[1]));
const routeSrc = readFileSync(new URL("../src/app/api/shopify/callback/route.ts", import.meta.url), "utf8")
  // Comments first: a parameter named in prose is not one passed.
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
const call = routeSrc.slice(routeSrc.indexOf('rpc("abo_shopify_connect"'));
const passed = new Set([...call.slice(0, call.indexOf("});")).matchAll(/\b(p_[a-z_]+)\s*:/g)].map((m) => m[1]));
check("the function was found", declared.size > 0);
check("the call was found", passed.size > 0);
for (const p of passed) check(`${p} is a parameter of the function`, declared.has(p));
for (const p of declared) check(`${p} is passed by the callback`, passed.has(p));

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
