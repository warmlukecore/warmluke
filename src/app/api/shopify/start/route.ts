import { NextResponse } from "next/server";
import { CONNECT_PROJECT_COOKIE, isConnectHint } from "@/lib/shopify-entry";
import { installLink, installLinkFor } from "@/lib/shop-address";

export const runtime = "nodejs";

/** Long enough to sign in to Shopify and approve; short enough not to linger. */
const REMEMBER_SECONDS = 15 * 60;

/**
 * GET /api/shopify/start?project=<id> — one tap to connect, no address typed.
 *
 * Sends the merchant to Shopify, which already knows which store they
 * are signed in to, and remembers which project
 * they tapped from so the connect page can pick it when Shopify sends
 * them back. The cookie is a hint and nothing more: that page checks the
 * project is theirs, and a project id someone else planted here is
 * simply not offered to them.
 *
 * Where to send them: the listing, if one is configured
 * (NEXT_PUBLIC_SHOPIFY_INSTALL_URL); otherwise Shopify's own install
 * link for this app's client id, which does the same for every store
 * Shopify lets the app be installed on. With neither — no Shopify app
 * here at all — the connect box is the way in.
 *
 * ?check=1 only says whether one tap is possible here, so the connect
 * box knows whether to offer it; it sets nothing and sends nowhere.
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const to = installLink(process.env.NEXT_PUBLIC_SHOPIFY_INSTALL_URL) ?? installLinkFor(process.env.SHOPIFY_CLIENT_ID);
  if (url.searchParams.has("check")) return NextResponse.json({ oneTap: !!to });
  if (!to) return NextResponse.redirect(`${url.origin}/dashboard`);

  const res = NextResponse.redirect(to);
  const project = url.searchParams.get("project");
  if (isConnectHint(project)) {
    res.cookies.set(CONNECT_PROJECT_COOKIE, project.toLowerCase(), {
      path: "/",
      maxAge: REMEMBER_SECONDS,
      httpOnly: true,
      // Lax, not Strict: the cookie has to come back on Shopify's
      // top-level redirect to the app's address, which Strict withholds.
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }
  return res;
}
