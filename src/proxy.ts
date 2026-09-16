import { NextResponse, type NextRequest } from "next/server";
import { VARIANT_COOKIE, resolveHero } from "@/lib/landing";

// ─────────────────────────────────────────────────────────────
// Which hero this visitor gets, decided before the page renders.
//
// Deciding it in the browser would mean the visitor sees one headline
// and then watches it turn into another — and it would make the
// numbers lie, because the hero that was measured is not the one that
// was read.
//
// The decision is made ONCE, here, and handed to the page on a request
// header. It used to be handed over by cookie alone, which was wrong
// in a way that only showed up on a visitor's very first request: the
// cookie is set on the response, so the page rendering that same
// response could not see it, rolled again, and rendered a different
// hero from the one being remembered. Three times in four, with four
// variants weighted evenly.
//
// Only "/" is touched. Everything else — the app, the API, the OAuth
// callback — is none of this file's business.
//
// Named proxy.ts because middleware.ts is deprecated in Next 16; see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md,
// which also names headers as the way to pass a decision to the app.
// ─────────────────────────────────────────────────────────────

/** Long enough that a visitor who comes back tomorrow sees the same page. */
const REMEMBER_FOR = 60 * 60 * 24 * 30;

export const VARIANT_HEADER = "x-wl-variant";

export function proxy(req: NextRequest) {
  const { hero, source } = resolveHero({
    wlVariant: req.nextUrl.searchParams.get("wl_variant"),
    utmCampaign: req.nextUrl.searchParams.get("utm_campaign"),
    assigned: req.cookies.get(VARIANT_COOKIE)?.value,
  });

  // Forwarded to the render, so the page never rolls its own.
  const headers = new Headers(req.headers);
  headers.set(VARIANT_HEADER, hero.id);
  const res = NextResponse.next({ request: { headers } });

  // Rewritten only when it would actually change. An ad that names a
  // variant replaces what the visitor was holding — they asked for it
  // by clicking that ad — but an ordinary reload writes nothing.
  if (source !== "assigned") {
    res.cookies.set(VARIANT_COOKIE, hero.id, {
      path: "/",
      maxAge: REMEMBER_FOR,
      sameSite: "lax",
      // Read by the server only. Nothing in the browser needs it; the
      // page is told which hero it is rendering.
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    });
  }

  return res;
}

export const config = { matcher: "/" };
