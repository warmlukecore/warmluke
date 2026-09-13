import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  ShopifyError,
  exchangeCodeForToken,
  fetchShopContext,
  normalizeShopDomain,
  verifyCallbackHmac,
} from "@/lib/shopify";

export const runtime = "nodejs";

/**
 * GET /api/shopify/callback — Shopify sends the merchant back here.
 *
 * Everything in this URL arrived through a browser, so the order of
 * checks is the security: the signature is verified before the state is
 * read, and the state is spent before the token is stored. A callback
 * that fails any of those never reaches the exchange.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = Object.fromEntries(url.searchParams.entries());
  const back = (why: string) =>
    NextResponse.redirect(`${url.origin}/dashboard?shopify=failed&reason=${why}`);

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return back("not_configured");

  try {
    // First, before anything here is treated as meaningful.
    verifyCallbackHmac(q, clientSecret);
    const shop = normalizeShopDomain(q.shop ?? "");
    if (!q.code || !q.state) return back("incomplete");

    const { access_token } = await exchangeCodeForToken({
      shop,
      clientId,
      clientSecret,
      code: q.code,
    });

    // The store's own calendar and money, read once and kept. Every
    // later "yesterday" is a question about this timezone.
    const ctx = await fetchShopContext(shop, access_token);

    // No session on a redirect, so the nonce stands in for one. The
    // function spends it, which is also what stops a replay.
    const anon = createClient(
      process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY!
    );
    const { data: projectId, error } = await anon.rpc("abo_shopify_connect", {
      p_state: q.state,
      p_token: access_token,
      p_timezone: ctx.timezone,
      p_currency: ctx.currency,
      p_country: ctx.country,
    });
    if (error) return back("save_failed");
    if (!projectId) return back("expired");

    return NextResponse.redirect(`${url.origin}/app/${projectId}?shopify=connected`);
  } catch (e) {
    return back(e instanceof ShopifyError ? e.code : "unknown");
  }
}
