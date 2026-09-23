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
// The one local import, and a leaf: shop-address imports nothing, so
// it cannot close a cycle back here. It holds the pattern because
// the browser needs it too, and a second copy of a security check is
// the copy that stops being updated.
import { SHOP_DOMAIN } from "@/lib/shop-address";

// Which scopes to ask for is a sum over the resources the store
// imports, so it is declared with them: scopesFor in lib/shopify-resources.
// Nothing else local is imported here — everything that reads Shopify
// imports this file.

// Kept in step with the version set on the app in Shopify.
export const SHOPIFY_API_VERSION = "2026-07";

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

/**
 * Verifies the signature on a webhook body.
 *
 * Different from the callback: Shopify signs the raw bytes and sends the
 * digest base64 in a header, so the body must be read exactly as it
 * arrived. Parsing it to JSON first and re-serialising changes the bytes,
 * and then every signature fails.
 */
export function verifyWebhookHmac(rawBody: string, header: string | null, secret: string): void {
  const fail = () => {
    throw new ShopifyError("invalid_webhook", "This webhook didn't come from Shopify.");
  };
  if (!header) fail();

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const received = Buffer.from(header as string, "base64");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) fail();
}

/** Where to send the merchant so Shopify can ask them to approve us. */
export function authorizeUrl(opts: {
  shop: string;
  clientId: string;
  redirectUri: string;
  state: string;
  /** From scopesFor(): every read the resources need, and nothing else. */
  scopes: readonly string[];
}): string {
  const u = new URL(`https://${normalizeShopDomain(opts.shop)}/admin/oauth/authorize`);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("scope", opts.scopes.join(","));
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("state", opts.state);
  return u.toString();
}

/**
 * What Shopify hands back for a token, expiring or not.
 *
 * Shopify no longer accepts non-expiring tokens on the Admin API, so in
 * practice every field below arrives. They are optional only so that a
 * store connected before this change still parses.
 */
export type TokenGrant = {
  access_token: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

/**
 * The scopes a grant came with, as a list.
 *
 * Shopify reports them in one comma-separated string. Null, never an
 * empty array, when there is nothing to report: a store whose grant was
 * never recorded has an unknown list, and a caller that cannot tell
 * unknown from empty will decide the token is allowed nothing.
 */
export function grantedScopes(scope: string | null | undefined): string[] | null {
  const list = (scope ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

async function postOAuth(shop: string, body: Record<string, string>): Promise<TokenGrant> {
  const res = await fetch(`https://${normalizeShopDomain(shop)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new ShopifyError(
      "token_exchange_failed",
      `Shopify refused the token exchange (${res.status}).`
    );
  }
  return (await res.json()) as TokenGrant;
}

/**
 * Trades the one-time code for an access token.
 *
 * `expiring=1` is not optional in practice: without it Shopify issues a
 * non-expiring token, and the Admin API then answers 403 to every call
 * made with it. The token that comes back lasts an hour; the refresh
 * token that comes with it lasts ninety days.
 */
export async function exchangeCodeForToken(opts: {
  shop: string;
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<TokenGrant> {
  return postOAuth(opts.shop, {
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    expiring: "1",
  });
}

/** Renews an expiring token server-side — the merchant is not involved. */
export async function refreshAccessToken(opts: {
  shop: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TokenGrant> {
  return postOAuth(opts.shop, {
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
}

/**
 * Whether to renew before using the token.
 *
 * Renewed a minute early on purpose. A token that passes this check and
 * then expires mid-import fails halfway through, which is worse than one
 * pointless refresh. A store with no recorded expiry predates expiring
 * tokens: it cannot be refreshed and has to be reconnected, so it is not
 * reported as refreshable here.
 */
export function tokenNeedsRefresh(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
  skewMs = 60_000
): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return false;
  return at - now.getTime() <= skewMs;
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

/**
 * The path segment a store's webhooks must arrive at.
 *
 * Shopify signs the body with one secret shared by the whole app, so
 * its HMAC proves a delivery came from Shopify and can never prove
 * which shop it came from — the shop rides in a header anybody can
 * change. So the shop is taken from the address instead: each store
 * gets its own, and the database looks the store up from this segment
 * rather than believing anything the request says about itself.
 *
 * Derived, not stored, so there is no column to back-fill and no new
 * secret for a client to read. It matches abo_shopify_webhook_token in
 * migration 0057 exactly; if one changes, the other must.
 */
export function webhookAddress(shop: string, secret: string): string {
  return createHmac("sha256", secret).update(shop.toLowerCase(), "utf8").digest("hex");
}
