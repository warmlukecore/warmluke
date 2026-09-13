import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { ShopifyError, authorizeUrl, newOAuthState, normalizeShopDomain } from "@/lib/shopify";

export const runtime = "nodejs";

/**
 * POST /api/shopify/install — start connecting a store.
 *
 * Writes a pending row first and sends the merchant to Shopify second.
 * The row is what proves, when Shopify redirects back, that the
 * authorization was one we asked for and for whose project — the
 * callback trusts nothing it is handed except by finding it here.
 */
export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { projectId, shop } = (await req.json().catch(() => ({}))) as {
    projectId?: string;
    shop?: string;
  };
  if (!projectId || !shop) {
    return NextResponse.json({ error: "projectId and shop are required." }, { status: 400 });
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!clientId || !process.env.SHOPIFY_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "Shopify is not configured on this deployment yet." },
      { status: 503 }
    );
  }

  let domain: string;
  try {
    domain = normalizeShopDomain(shop);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof ShopifyError ? e.message : "Invalid store address." },
      { status: 400 }
    );
  }

  const state = newOAuthState();
  // RLS decides whether this project is the caller's; there is no owner
  // check here, and adding one would only be a second opinion on the
  // same question.
  const { error } = await auth.client.from("stores").upsert(
    {
      project_id: projectId,
      provider: "shopify",
      shop_domain: domain,
      status: "pending",
      oauth_state: state,
      oauth_state_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
    { onConflict: "provider,shop_domain" }
  );
  if (error) {
    // The unique index also means a shop already connected to another
    // project cannot be quietly taken over from here.
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  return NextResponse.json({
    url: authorizeUrl({
      shop: domain,
      clientId,
      redirectUri: `${new URL(req.url).origin}/api/shopify/callback`,
      state,
    }),
  });
}
