import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  ShopifyError,
  exchangeCodeForToken,
  fetchShopContext,
  grantedScopes,
  normalizeShopDomain,
  verifyCallbackHmac,
  webhookAddress,
} from "@/lib/shopify";
import { subscribeWebhooks } from "@/lib/shopify-webhooks";
import { AppSwitchedOff, appsForShop, cameThrough, claimOk, firstThatSigned } from "@/lib/shopify-apps";

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
  const back = (why: string) => NextResponse.redirect(`${url.origin}/dashboard?shopify=failed&reason=${why}`);

  try {
    // The shop is read only to know which secrets could prove the request:
    // the apps claiming it (a merchant's own or an administrator's, 0156)
    // and the main app. Shopify signs with the app it answers for, so the
    // one that signed is the app this is; nothing else in the query is
    // believed until a signature checks out, first, before anything else.
    const shop = normalizeShopDomain(q.shop ?? "");
    const candidates = await appsForShop(shop);
    if (candidates.length === 0) return back("not_configured");
    const app = await firstThatSigned((secret) => verifyCallbackHmac(q, secret), undefined, candidates);
    if (!app) return back("invalid_callback");
    const { clientId, clientSecret } = app;
    if (!q.code || !q.state) return back("incomplete");
    // Signed is not the same as allowed: an app may claim any shop, so a
    // store is connected only through its owner's own app, one an
    // administrator assigned, or the main app — asked before any token.
    if (!(await claimOk(shop, app, q.state))) return back("not_your_app");

    // Expiring now, so the refresh token and both lifetimes are kept
    // alongside it. Without them the token dies in an hour and the store
    // can only be fixed by reconnecting.
    const grant = await exchangeCodeForToken({
      shop,
      clientId,
      clientSecret,
      code: q.code,
    });
    const access_token = grant.access_token;

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
      // Which store came back. Without it the nonce alone decided
      // which row got this token, and a row may name any shop its
      // author typed.
      p_shop: shop,
      p_token: access_token,
      p_timezone: ctx.timezone,
      p_currency: ctx.currency,
      p_country: ctx.country,
      p_refresh_token: grant.refresh_token ?? null,
      p_expires_in: grant.expires_in ?? null,
      p_refresh_expires_in: grant.refresh_token_expires_in ?? null,
      // What Shopify actually gave, which is not always what the
      // install asked for. Read from the grant and kept, so that
      // "did that reconnect take?" is a fact in the row rather than
      // something only a refused API call can reveal.
      p_scopes: grantedScopes(grant.scope),
    });
    if (error) return back("save_failed");
    if (!projectId) return back("expired");
    // This is the app the shop came through: its deliveries and renewals use it.
    await cameThrough(shop, app);

    // Ask Shopify to tell us when anything changes. Done here because
    // this is the one moment a token exists and nobody has to
    // remember anything — a topic somebody forgets to click is a
    // merchant whose stock quietly stops updating.
    //
    // Never fatal: the store is connected and the importer works
    // without any of this. A failure here means slower updates, not a
    // broken connection, and failing the callback over it would undo
    // a connection that succeeded.
    // Each store is given its own address, so a delivery's shop is
    // the URL it arrives at rather than a header anyone can rewrite.
    const result = await subscribeWebhooks(
      shop,
      access_token,
      `${url.origin}/api/shopify/webhooks/${webhookAddress(shop, clientSecret)}`
    );
    // Written down, not only logged. A merchant told "connected" about
    // a store that will never send us anything has been told the wrong
    // thing, and the log is somewhere they cannot see.
    const trouble = result.failed.length > 0 ? result.failed.join(" | ").slice(0, 2000) : null;
    if (trouble) console.error("shopify webhooks not subscribed:", trouble);
    await anon.from("stores").update({ webhook_error: trouble }).eq("project_id", projectId).eq("shop_domain", shop);

    return NextResponse.redirect(`${url.origin}/app/${projectId}?shopify=connected`);
  } catch (e) {
    if (e instanceof AppSwitchedOff) return back("app_switched_off");
    return back(e instanceof ShopifyError ? e.code : "unknown");
  }
}
