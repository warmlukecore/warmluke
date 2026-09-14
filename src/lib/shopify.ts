// ─────────────────────────────────────────────────────────────
// Shopify OAuth — the parts that decide whether a request is real.
//
// Everything here runs on input the merchant's browser handed us, or
// that Shopify redirected through it, which means none of it can be
// trusted until it is checked. The order of the checks matters as much
// as the checks: the signature is verified before the state or the code
// is looked at, so a forged callback never reaches the part that hands
// out a token.
// ─────────────────────────────────────────────────────────────

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

/** Read-only. The assistant reads a store; it never writes to Shopify. */
export const SHOPIFY_SCOPES = [
  "read_orders",
  "read_products",
  "read_customers",
  "read_inventory",
  "read_locations",
] as const;

/**
 * Orders older than Shopify's default window, which needs Shopify's
 * approval on the app before it can be asked for at all — requesting it
 * unapproved fails the whole authorization, not just that one scope. Set
 * the flag once the grant comes through.
 */
export const EXTENDED_ORDER_HISTORY_SCOPE = "read_all_orders";

export function scopesFor(env = process.env): string[] {
  return env.SHOPIFY_READ_ALL_ORDERS === "true"
    ? [...SHOPIFY_SCOPES, EXTENDED_ORDER_HISTORY_SCOPE]
    : [...SHOPIFY_SCOPES];
}

// Kept in step with the version set on the app in Shopify.
export const SHOPIFY_API_VERSION = "2026-07";

// Anchored, and it must start with a letter or digit. A loose test like
// /myshopify.com/ matches "evil.com?x=.myshopify.com" and sends the
// merchant's authorization somewhere else entirely.
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export class ShopifyError extends Error {
  // Written out rather than declared as a parameter property: Node can
  // run this file directly for the checks, and its type stripping does
  // not implement that shorthand.
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Canonicalises a shop domain the merchant typed, or refuses it. */
export function normalizeShopDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (domain.length > 255 || !SHOP_DOMAIN.test(domain)) {
    throw new ShopifyError(
      "invalid_shop_domain",
      "Enter a valid store address ending in .myshopify.com."
    );
  }
  return domain;
}

export const newOAuthState = (): string => randomUUID();

/**
 * Verifies the signature Shopify puts on its redirect back to us.
 *
 * Called before anything else touches the query: a callback that fails
 * here never gets as far as being looked up or exchanged.
 */
export function verifyCallbackHmac(
  query: Readonly<Record<string, string | undefined>>,
  secret: string,
  now: Date = new Date()
): void {
  const fail = () => {
    throw new ShopifyError("invalid_callback", "This link didn't come from Shopify.");
  };

  const { hmac, timestamp } = query;
  if (!hmac || !timestamp || !/^[a-f0-9]{64}$/i.test(hmac)) fail();

  // A signature stays valid forever unless something bounds it, so an
  // old callback captured from a browser history or a log could be
  // replayed. Shopify stamps the time; five minutes is plenty.
  const stamped = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(stamped) || Math.abs(now.getTime() - stamped) > 5 * 60 * 1000) fail();

  const message = Object.entries(query)
    .filter((e): e is [string, string] => e[0] !== "hmac" && e[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const expected = createHmac("sha256", secret).update(message).digest();
  const received = Buffer.from(hmac as string, "hex");
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, so the lengths are compared first.
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) fail();
}

/** Where to send the merchant so Shopify can ask them to approve us. */
export function authorizeUrl(opts: {
  shop: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(`https://${normalizeShopDomain(opts.shop)}/admin/oauth/authorize`);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("scope", scopesFor().join(","));
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("state", opts.state);
  return u.toString();
}

/** Trades the one-time code for a lasting access token. */
export async function exchangeCodeForToken(opts: {
  shop: string;
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<{ access_token: string; scope: string }> {
  const res = await fetch(`https://${normalizeShopDomain(opts.shop)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
    }),
  });
  if (!res.ok) {
    throw new ShopifyError(
      "token_exchange_failed",
      `Shopify refused the token exchange (${res.status}).`
    );
  }
  return (await res.json()) as { access_token: string; scope: string };
}

/**
 * The store's own calendar and currency.
 *
 * Fetched once at connect time and stored, because every later question
 * about "yesterday" is a question about this timezone, not the server's.
 */
export async function fetchShopContext(
  shop: string,
  accessToken: string
): Promise<{ timezone: string; currency: string; country: string | null; name: string }> {
  const res = await fetch(
    `https://${normalizeShopDomain(shop)}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
    { headers: { "X-Shopify-Access-Token": accessToken } }
  );
  if (!res.ok) {
    throw new ShopifyError("shop_context_failed", `Could not read the store (${res.status}).`);
  }
  const { shop: s } = (await res.json()) as {
    shop: { iana_timezone?: string; currency?: string; country_code?: string; name?: string };
  };
  return {
    timezone: s.iana_timezone || "UTC",
    currency: s.currency || "INR",
    country: s.country_code ?? null,
    name: s.name ?? shop,
  };
}
