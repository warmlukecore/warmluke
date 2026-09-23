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
import { installLink, installLinkFor, readShopAddress } from "../src/lib/shop-address.ts";
import { entryTarget, isProjectId } from "../src/lib/shopify-entry.ts";
import { ownPath } from "../src/lib/paths.ts";

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

// The app's own topics go past the dispatcher to a function each. The
// same failure is possible three ways — subscribed and never routed,
// routed to a function no migration defines, or never subscribed at
// all — and each is a store that goes on saying "connected" after the
// merchant removed the app.
console.log("\nand every topic about the app itself lands too");
{
  const hooks = readFileSync(new URL("../src/lib/shopify-webhooks.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/app/api/shopify/webhooks/[token]/route.ts", import.meta.url), "utf8");
  const block = hooks.match(/LIFECYCLE_TOPICS[^=]*=\s*\{([^}]*)\}/)?.[1] ?? "";
  const lifecycle = [...block.matchAll(/([A-Z_]+):\s*"([a-z_]+)"/g)].map((m) => ({ topic: m[1], fn: m[2] }));
  const allSql = migrations.map((f) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8")).join("\n");
  check("the app's own topics are declared", lifecycle.length > 0);
  check("app/uninstalled is one of them", lifecycle.some((l) => l.topic === "APP_UNINSTALLED"));
  check("every one is subscribed at connect", /SUBSCRIBED[^;]*LIFECYCLE_TOPICS/.test(hooks) && /for \(const topic of SUBSCRIBED\)/.test(hooks));
  check("and the webhook route sends them past the dispatcher", /LIFECYCLE_TOPICS\[/.test(route));
  for (const { topic, fn } of lifecycle) {
    check(`${topic}'s ${fn} is defined by a migration`, allSql.includes(`create or replace function public.${fn}(`));
    check(`and it is not also a resource topic`, !WEBHOOK_TOPICS.includes(topic));
  }
  // The erasure spares a store connected after the uninstall it is about.
  const redact = migrations.filter((f) =>
    readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8").toLowerCase().includes("function public.abo_shopify_shop_redact(p_shop text)")
  ).at(-1);
  const redactSql = redact ? readFileSync(new URL(`../supabase/migrations/${redact}`, import.meta.url), "utf8") : "";
  check("shop/redact spares a store connected in the last 48 hours", /connected_at > now\(\) - interval '48 hours'/.test(redactSql));
}

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

// ── Shopify sending a merchant to us ─────────────────────────────
//
// Installing from the listing, or opening the app from the Shopify
// admin, arrives with the store in a signed query. That is the only
// time Shopify names the store without anybody typing it — and so the
// one place a hand-made link could pretend Shopify sent it.
console.log("\nand a merchant Shopify sends us is only believed when Shopify signed it");
{
  const SECRET = "check-app-secret";
  const ORIGIN = "https://warmluke.example";
  const signed = (q, secret = SECRET) => {
    const message = Object.entries(q).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
    return { ...q, hmac: createHmac("sha256", secret).update(message).digest("hex") };
  };
  const at = (seconds) => String(Math.floor(Date.now() / 1000) + seconds);
  const install = { shop: "mystore.myshopify.com", timestamp: at(0), host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbXlzdG9yZQ" };
  const go = (query, project) => entryTarget({ query, secret: SECRET, origin: ORIGIN, project });
  const where = (r) => new URL(r.to);

  const ok = go(signed(install));
  check("a signed install goes to the connect page", ok.ok && where(ok).pathname === "/connect");
  check("with the store Shopify named", where(ok).searchParams.get("shop") === "mystore.myshopify.com");
  const PROJECT = "11111111-2222-3333-4444-555555555555";
  check("and the project they tapped from, when there is one", where(go(signed(install), PROJECT)).searchParams.get("project") === PROJECT);
  check("a cookie that is not a project id is not carried", !where(go(signed(install), "../../admin")).searchParams.has("project"));
  check("an id is only an id", isProjectId(PROJECT) && !isProjectId("x") && !isProjectId(`${PROJECT}'`));

  const refusedTo = (r) => !r.ok && where(r).pathname === "/dashboard" && where(r).searchParams.get("shopify") === "failed";
  check("unsigned: refused", refusedTo(go(install)));
  check("signed with another secret: refused", refusedTo(go(signed(install, "not-ours"))));
  check("a store swapped after signing: refused", refusedTo(go({ ...signed(install), shop: "evil.myshopify.com" })));
  check("an old signature: refused", refusedTo(go(signed({ ...install, timestamp: at(-3600) }))));
  check("a signed but crooked shop: refused", refusedTo(go(signed({ ...install, shop: "evil.com?x=.myshopify.com" }))));

  // The one-tap link is configuration, and must stay Shopify's.
  check("the listing is a one-tap link", installLink("https://apps.shopify.com/warmluke") === "https://apps.shopify.com/warmluke");
  check("so is Shopify's admin", !!installLink("https://admin.shopify.com/oauth/install?client_id=x"));
  check("none configured: none", installLink(undefined) === null && installLink("") === null);
  check("another host: none", installLink("https://evil.example/apps.shopify.com") === null);
  check("a lookalike: none", installLink("https://apps.shopify.com.evil.example/") === null);
  check("plain http: none", installLink("http://apps.shopify.com/warmluke") === null);
  check("userinfo in front: none", installLink("https://evil@apps.shopify.com/warmluke") === null);
  check("not a URL: none", installLink("apps.shopify.com/warmluke") === null);
  // With no listing, Shopify's own install link, from the client id.
  check("a client id gives Shopify's install link",
    installLinkFor("2fbfb378521dd14d5be638893ae3f97c") === "https://admin.shopify.com/oauth/install?client_id=2fbfb378521dd14d5be638893ae3f97c");
  check("and that link is one installLink accepts", installLink(installLinkFor("2fbfb378521dd14d5be638893ae3f97c")) !== null);
  check("no client id: no link", installLinkFor(undefined) === null && installLinkFor("") === null);
  check("a client id that could smuggle a query in: no link", installLinkFor("abc&redirect_uri=https://evil.example") === null);

  // Where signing in sends them next.
  check("our own page is followed", ownPath("/connect?shop=mystore.myshopify.com"));
  check("another site dressed as a path is not", !ownPath("//evil.example") && !ownPath("/\\evil.example"));
  check("a full URL is not", !ownPath("https://evil.example/") && !ownPath("javascript:alert(1)"));
  check("nothing is not", !ownPath(null) && !ownPath(undefined) && !ownPath(""));

  const proxySrc = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
  check("the site's root passes Shopify's query on untouched",
    /has\("shop"\) && req\.nextUrl\.searchParams\.has\("hmac"\)/.test(proxySrc) && /api\/shopify\/entry\$\{req\.nextUrl\.search\}/.test(proxySrc));
  const entrySrc = readFileSync(new URL("../src/app/api/shopify/entry/route.ts", import.meta.url), "utf8");
  check("the entry writes nothing", !/\.from\(|\.rpc\(|insert|update\(/.test(entrySrc));
  check("and spends the project hint", /cookies\.delete\(CONNECT_PROJECT_COOKIE\)/.test(entrySrc));
  const startSrc = readFileSync(new URL("../src/app/api/shopify/start/route.ts", import.meta.url), "utf8");
  check("one tap goes to the listing, else Shopify's own link, and nowhere else",
    /installLink\(process\.env\.NEXT_PUBLIC_SHOPIFY_INSTALL_URL\) \?\? installLinkFor\(process\.env\.SHOPIFY_CLIENT_ID\)/.test(startSrc));
  check("and ?check only answers", /searchParams\.has\("check"\)\) return NextResponse\.json\(\{ oneTap: !!to \}\)/.test(startSrc));
  for (const page of ["login", "signup"]) {
    const src = readFileSync(new URL(`../src/app/${page}/page.tsx`, import.meta.url), "utf8");
    check(`${page} follows next only through ownPath`, /if \(ownPath\(next\)\)/.test(src) && !/next\?\.startsWith/.test(src));
  }
}

// ── What an import ticket reaches is what the importer writes ─────
//
// The background worker writes with a ticket, and the policies that
// accept it are listed by hand in SQL, because SQL cannot read the
// registry. So the list is held to the registry here: a resource that
// gains a table the worker cannot write would fail its import with
// nobody watching, and a table on the list that no resource writes is
// reach the worker was never meant to have.
console.log("\nand an import ticket reaches exactly the tables the importer writes");
{
  const MARK = "_import_ticket";
  const holding = readdirSync(new URL("../supabase/migrations", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8").includes(MARK));
  check("a migration grants the ticket its tables", holding.length > 0);
  const sql = holding.length
    ? readFileSync(new URL(`../supabase/migrations/${holding.at(-1)}`, import.meta.url), "utf8")
    : "";
  const list = sql.match(/foreach t in array array\[([^\]]+)\]/);
  const granted = new Set([...(list?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  const writes = new Set(RESOURCES.flatMap((r) => SHOPIFY_RESOURCES[r].tables));
  writes.add("import_runs");
  const missingGrant = [...writes].filter((t) => !granted.has(t));
  const extraGrant = [...granted].filter((t) => !writes.has(t));
  check(`every table the importer writes is granted${missingGrant.length ? `: missing ${missingGrant}` : ""}`, missingGrant.length === 0);
  check(`and nothing else is${extraGrant.length ? `: ${extraGrant}` : ""}`, extraGrant.length === 0);
  check("never the store row, its actions, or its privacy requests",
    !["stores", "store_actions", "shopify_data_requests", "projects", "modules", "records"].some((t) => granted.has(t)));
  check("the policies are for anon and a ticket only", /for all to anon/.test(sql) && !/to (authenticated|public)[^;]*abo_import_holds/.test(sql));

  // The worker holds no secret: its authority is the ticket it is sent.
  const worker = readFileSync(new URL("../src/app/api/shopify/import/worker/route.ts", import.meta.url), "utf8");
  check("the worker uses the ticket client and nothing stronger", /ticketClient\(ticket\)/.test(worker) && !/SERVICE_ROLE|getUserClient/.test(worker));
  check("and never writes the ticket to a log", !/console\.\w+\([^)]*ticket/.test(worker));
  const src = readdirSync(new URL("../src", import.meta.url), { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"));
  check("no code on the server reads a service-role key", !src.some((s) => /SERVICE_ROLE/.test(s)));
}

console.log(fails.length === 0 ? "\nevery guard holds" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
