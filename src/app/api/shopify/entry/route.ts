import { NextResponse, type NextRequest } from "next/server";
import { CONNECT_PROJECT_COOKIE, entryTarget } from "@/lib/shopify-entry";
import { normalizeShopDomain } from "@/lib/shopify";
import { appsForShop } from "@/lib/shopify-apps";

export const runtime = "nodejs";

/**
 * GET /api/shopify/entry — the app's address, as Shopify uses it.
 *
 * Shopify sends a merchant here after they install the app from its
 * listing, and whenever they open it from their Shopify admin, with the
 * store named in a signed query. This checks the signature and passes
 * the store on to the connect page, which asks them to sign in, checks
 * the project is theirs, and starts the ordinary connection — Shopify's
 * own approval included. Nothing is written here.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const failed = (reason: string) => NextResponse.redirect(`${url.origin}/dashboard?shopify=failed&reason=${reason}`);
  // Whose secret proves this: one of the apps claiming the store (a
  // merchant's own or an administrator's, 0156), or the main app's. The
  // shop is only read to find out which to try; entryTarget checks each
  // signature before it believes any of it, and the first that holds wins.
  let apps;
  try {
    apps = await appsForShop(normalizeShopDomain(url.searchParams.get("shop") ?? ""));
  } catch {
    return failed("invalid_callback");
  }
  if (apps.length === 0) return failed("not_configured");
  const query = Object.fromEntries(url.searchParams.entries());
  const project = req.cookies.get(CONNECT_PROJECT_COOKIE)?.value ?? null;
  let target = entryTarget({ query, secret: apps[0].clientSecret, origin: url.origin, project });
  for (const app of apps.slice(1)) {
    if (target.ok) break;
    target = entryTarget({ query, secret: app.clientSecret, origin: url.origin, project });
  }
  const { to } = target;
  const res = NextResponse.redirect(to);
  // Used once. A later visit from the Shopify admin is not the same
  // connection, and must not be steered into the project this one was.
  res.cookies.delete(CONNECT_PROJECT_COOKIE);
  return res;
}
