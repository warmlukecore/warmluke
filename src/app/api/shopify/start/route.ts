import { NextResponse } from "next/server";
import { CONNECT_PROJECT_COOKIE, isProjectId } from "@/lib/shopify-entry";
import { installLink } from "@/lib/shop-address";

export const runtime = "nodejs";

/** Long enough to sign in to Shopify and approve; short enough not to linger. */
const REMEMBER_SECONDS = 15 * 60;

/**
 * GET /api/shopify/start?project=<id> — one tap to connect, no address typed.
 *
 * Sends the merchant to the app's Shopify listing, where Shopify already
 * knows which store they are signed in to, and remembers which project
 * they tapped from so the connect page can pick it when Shopify sends
 * them back. The cookie is a hint and nothing more: that page checks the
 * project is theirs, and a project id someone else planted here is
 * simply not offered to them.
 *
 * Where there is no listing — the app not yet public — there is nothing
 * to send them to, and the connect box is the way in.
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const to = installLink(process.env.NEXT_PUBLIC_SHOPIFY_INSTALL_URL);
  if (!to) return NextResponse.redirect(`${url.origin}/dashboard`);

  const res = NextResponse.redirect(to);
  const project = url.searchParams.get("project");
  if (isProjectId(project)) {
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
