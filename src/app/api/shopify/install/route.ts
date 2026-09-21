import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { ShopifyError, authorizeUrl, newOAuthState, normalizeShopDomain } from "@/lib/shopify";
import { scopesFor } from "@/lib/shopify-resources";

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

  // Two separate questions, asked separately, because one upsert cannot
  // tell them apart. A shop already claimed by a different owner is
  // invisible to this caller, so the upsert fails on the policy rather
  // than the unique index — and reporting that as "this project isn't
  // yours" would be wrong and confusing, since the project IS theirs.
  const { data: mine } = await auth.client
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (!mine) {
    return NextResponse.json({ error: "That project isn't yours." }, { status: 403 });
  }

  const state = newOAuthState();
  const row = {
    project_id: projectId,
    provider: "shopify",
    shop_domain: domain,
    status: "pending",
    oauth_state: state,
    oauth_state_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };

  // Reconnecting a store this project already holds is normal: a fresh
  // nonce replaces the old one.
  const { data: existing } = await auth.client
    .from("stores")
    .select("id")
    .eq("project_id", projectId)
    .eq("shop_domain", domain)
    .maybeSingle();

  const { error } = existing
    ? await auth.client.from("stores").update(row).eq("id", existing.id)
    : await auth.client.from("stores").insert(row);

  if (error) {
    // The project is theirs and the row is not, so the shop is taken —
    // but by whom changes what they should do about it. If they can see
    // the store at all it is their own, in another project, and they can
    // go and disconnect it; if they cannot, it is somebody else's and
    // nothing they do here will help.
    const { data: elsewhere } = await auth.client
      .from("stores")
      .select("project_id, projects(name)")
      .eq("shop_domain", domain)
      .maybeSingle();
    const other = (elsewhere?.projects as { name?: string } | null)?.name;
    return NextResponse.json(
      {
        error: other
          ? `That store is already connected to your project "${other}".`
          : "That store is already connected to another account.",
      },
      { status: 409 }
    );
  }

  return NextResponse.json({
    url: authorizeUrl({
      shop: domain,
      clientId,
      redirectUri: `${new URL(req.url).origin}/api/shopify/callback`,
      state,
      scopes: scopesFor(),
    }),
  });
}
