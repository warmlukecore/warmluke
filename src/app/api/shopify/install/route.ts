import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { ShopifyError, authorizeUrl, newOAuthState, normalizeShopDomain } from "@/lib/shopify";
import { scopesFor } from "@/lib/shopify-resources";
import { readShopAddress } from "@/lib/shop-address";

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

  // Read the way a merchant writes it — the bare name, a copied URL,
  // the admin's address — and read here, whatever the box already
  // showed them: the page is not trusted to have done it. What comes
  // out is still put through the strict check the callback uses, so
  // being forgiving about spelling cannot widen what is accepted.
  // Before the deployment's own settings, like the check above it:
  // what is wrong with the address is wrong wherever it is sent.
  const read = readShopAddress(shop);
  if ("error" in read) {
    return NextResponse.json({ error: read.error, hint: read.hint }, { status: 400 });
  }
  let domain: string;
  try {
    domain = normalizeShopDomain(read.domain);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof ShopifyError ? e.message : "Invalid store address." },
      { status: 400 }
    );
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!clientId || !process.env.SHOPIFY_CLIENT_SECRET) {
    return NextResponse.json({ error: "Shopify is not configured on this deployment yet." }, { status: 503 });
  }

  // Two separate questions, asked separately, because one upsert cannot
  // tell them apart. A shop already claimed by a different owner is
  // invisible to this caller, so the upsert fails on the policy rather
  // than the unique index — and reporting that as "this project isn't
  // yours" would be wrong and confusing, since the project IS theirs.
  const { data: mine } = await auth.client.from("projects").select("id").eq("id", projectId).maybeSingle();
  if (!mine) {
    return NextResponse.json({ error: "That project isn't yours." }, { status: 403 });
  }

  const state = newOAuthState();
  const nonce = {
    oauth_state: state,
    oauth_state_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };

  // Reconnecting a store this project already holds is normal: a fresh
  // nonce replaces the old one.
  const { data: existing } = await auth.client
    .from("stores")
    .select("id, status")
    .eq("project_id", projectId)
    .eq("shop_domain", domain)
    .maybeSingle();

  // One store to a project. Everything that reads a project's store
  // asks for the one, and a second row — a different shop connected
  // beside the first — makes every one of those reads fail at once.
  if (!existing) {
    const { data: others } = await auth.client
      .from("stores")
      .select("id, shop_domain, status, connected_at")
      .eq("project_id", projectId)
      .neq("shop_domain", domain);
    // A shop that is, or ever was, connected here holds this project's
    // store data: it stays, and the merchant decides what to do with it.
    const held = (others ?? []).find((o) => o.status !== "pending" || o.connected_at);
    if (held) {
      return NextResponse.json(
        {
          error: `This project is already connected to ${held.shop_domain}. Disconnect it first, or connect ${domain} to another project.`,
        },
        { status: 409 }
      );
    }
    // What is left are attempts that never came back from Shopify — a
    // mistyped address, a closed tab. They hold nothing, and left in
    // place beside the real store they are that second row.
    const stale = (others ?? []).map((o) => o.id);
    if (stale.length) await auth.client.from("stores").delete().in("id", stale);
  }

  // A working store stays working while they are away.
  //
  // This used to set status to "pending" before sending them to
  // Shopify, so a merchant who opened the consent screen and closed
  // the tab came back to an app that had gone blind: every read
  // answers "that store isn't connected yet" until they finish a
  // reconnect they may not know they started. The old token is still
  // good until the callback replaces it, and abo_shopify_connect
  // finds the row by its nonce rather than by its status, so there is
  // nothing to gain by breaking it in the meantime.
  //
  // Pending is still right for a store that was never connected: it
  // has no token to keep.
  const reconnecting = existing?.status === "connected";
  const { error } = existing
    ? await auth.client
        .from("stores")
        .update(reconnecting ? nonce : { ...nonce, status: "pending" })
        .eq("id", existing.id)
    : await auth.client.from("stores").insert({
        project_id: projectId,
        provider: "shopify",
        shop_domain: domain,
        status: "pending",
        ...nonce,
      });

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
