// The checks that decide whether a Shopify callback is real.
//
// None of this needs a Shopify account, and all of it runs on input a
// browser handed us. A loose domain test sends a merchant's
// authorization to somebody else's server; an unverified signature hands
// a token to whoever asks. Both look like working code until they don't.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-shopify.mjs

import { createHmac } from "node:crypto";
import {
  SHOPIFY_SCOPES,
  authorizeUrl,
  normalizeShopDomain,
  verifyCallbackHmac,
} from "../src/lib/shopify.ts";

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
  })
);
check("it points at the merchant's own store", url.host === "carefone.myshopify.com");
check("it carries the state back", url.searchParams.get("state") === "abc-123");
check("every scope is a read", SHOPIFY_SCOPES.every((s) => s.startsWith("read_")));
check("no write scope is requested", !url.searchParams.get("scope")?.includes("write_"));
check("a bad shop cannot build a URL", refuses(() => authorizeUrl({ shop: "evil.com", clientId: "x", redirectUri: "y", state: "z" })));

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

console.log(fails.length === 0 ? "\nevery guard holds" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
