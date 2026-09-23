// ─────────────────────────────────────────────────────────────
// Where a merchant goes when Shopify sends them to us.
//
// Installing from the App Store, or opening the app from their Shopify
// admin, lands a merchant on the app's address with the store named in
// a signed query: shop, hmac, timestamp, host. That is the one moment
// Shopify tells us which store without anybody typing it.
//
// Nothing here is authority. The signature says Shopify sent them; it
// does not say which Warmluke account they are, and the connect page
// that follows asks them to sign in and checks the project is theirs.
// Connecting still goes through Shopify's own approval, which only the
// store's staff can give. The signature is checked anyway, before the
// shop is read, so a hand-made link cannot put a merchant on a page
// that claims Shopify sent them.
//
// Server-only: it verifies with node:crypto.
// ─────────────────────────────────────────────────────────────

import { ShopifyError, normalizeShopDomain, verifyCallbackHmac } from "@/lib/shopify";

/** The cookie that remembers which project a one-tap connect began in. */
export const CONNECT_PROJECT_COOKIE = "wl_connect_project";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value can be a project id at all; checked before it is carried anywhere. */
export const isProjectId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/**
 * What a one-tap connect may carry through Shopify: the project it was
 * tapped from, or "new" — "connect another store" — for a project made
 * only once Shopify has named the store, so turning back at Shopify
 * leaves no empty project behind.
 */
export const NEW_PROJECT = "new";
export const isConnectHint = (v: unknown): v is string => v === NEW_PROJECT || isProjectId(v);

/**
 * Where to send a request that arrived at the app's address from Shopify.
 *
 * `project` is the cookie the one-tap button left, if any: a hint about
 * which project they were connecting, never proof that it is theirs.
 */
export function entryTarget(opts: {
  query: Readonly<Record<string, string | undefined>>;
  secret: string;
  origin: string;
  project?: string | null;
  now?: Date;
}): { to: string; ok: boolean } {
  const failed = (reason: string) => ({
    to: `${opts.origin}/dashboard?shopify=failed&reason=${reason}`,
    ok: false,
  });
  let shop: string;
  try {
    verifyCallbackHmac(opts.query, opts.secret, opts.now);
    shop = normalizeShopDomain(opts.query.shop ?? "");
  } catch (e) {
    return failed(e instanceof ShopifyError ? e.code : "invalid_callback");
  }
  const next = new URL("/connect", opts.origin);
  next.searchParams.set("shop", shop);
  if (isConnectHint(opts.project)) next.searchParams.set("project", opts.project.toLowerCase());
  return { to: next.toString(), ok: true };
}
