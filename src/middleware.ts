import { NextResponse, type NextRequest } from "next/server";
import { VARIANT_COOKIE, resolveHero } from "@/lib/landing";

// ─────────────────────────────────────────────────────────────
// Which hero this visitor gets, decided before the page renders.
//
// Doing it in the browser would mean the visitor sees one headline and
// then watches it turn into another — which the brief rules out, and
// which would also make the numbers lie, because the hero that was
// measured is not the one that was read.
//
// A server component cannot set a cookie, so the decision lives here:
// the cookie is written on the way out and the page reads it on the
// way in, and the same request that assigns a variant also renders it.
//
// Only "/" is touched. Everything else — the app, the API, the OAuth
// callback — is none of this file's business.
// ─────────────────────────────────────────────────────────────

/** Long enough that a visitor who comes back tomorrow sees the same page. */
const REMEMBER_FOR = 60 * 60 * 24 * 30;

export function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const { hero, source } = resolveHero({
    wlVariant: req.nextUrl.searchParams.get("wl_variant"),
    utmCampaign: req.nextUrl.searchParams.get("utm_campaign"),
    assigned: req.cookies.get(VARIANT_COOKIE)?.value,
  });

  // Rewritten only when it would actually change. An ad that names a
  // variant replaces what the visitor was holding — they asked for it
  // by clicking that ad — but an ordinary reload writes nothing.
  if (source !== "assigned") {
    res.cookies.set(VARIANT_COOKIE, hero.id, {
      path: "/",
      maxAge: REMEMBER_FOR,
      sameSite: "lax",
      // Read by the server only. Nothing in the browser needs it, and
      // the page is told which hero it is rendering anyway.
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    });
  }

  return res;
}

export const config = { matcher: "/" };
