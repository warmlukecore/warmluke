import { NextResponse, type NextRequest } from "next/server";
import { CONNECT_PROJECT_COOKIE, entryTarget } from "@/lib/shopify-entry";

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
export function GET(req: NextRequest) {
  const url = new URL(req.url);
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) {
    return NextResponse.redirect(`${url.origin}/dashboard?shopify=failed&reason=not_configured`);
  }
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
