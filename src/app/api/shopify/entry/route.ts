import { NextResponse, type NextRequest } from "next/server";
import { CONNECT_PROJECT_COOKIE, entryTarget } from "@/lib/shopify-entry";
import { normalizeShopDomain } from "@/lib/shopify";
import { AppSwitchedOff, appForShop } from "@/lib/shopify-apps";

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
  // Whose secret proves this: the store's own app's (0150) or the main
  // app's. The shop is only read to find out; entryTarget checks the
  // signature before it believes any of it.
  let secret: string | undefined;
  try {
    secret = (await appForShop(normalizeShopDomain(url.searchParams.get("shop") ?? "")))?.clientSecret;
  } catch (e) {
    return failed(e instanceof AppSwitchedOff ? "app_switched_off" : "invalid_callback");
  }
  if (!secret) return failed("not_configured");
  const { to } = entryTarget({
    query: Object.fromEntries(url.searchParams.entries()),
    secret,
    origin: url.origin,
    project: req.cookies.get(CONNECT_PROJECT_COOKIE)?.value ?? null,
  });
  const res = NextResponse.redirect(to);
  // Used once. A later visit from the Shopify admin is not the same
  // connection, and must not be steered into the project this one was.
  res.cookies.delete(CONNECT_PROJECT_COOKIE);
  return res;
}
