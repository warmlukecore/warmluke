import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ShopifyError, normalizeShopDomain, verifyWebhookHmac } from "@/lib/shopify";

export const runtime = "nodejs";

/**
 * POST /api/shopify/webhooks — the three compliance topics.
 *
 * One endpoint for all three because the topic is a header, and three
 * routes differing by one switch would be three places to forget to
 * verify a signature.
 *
 * Order matters the same way it does in the callback: the body is read
 * as raw text and its signature checked before anything in it is parsed
 * or believed. An unsigned request is refused before it can name a shop
 * — otherwise anyone who guessed this URL could erase a store.
 */
export async function POST(req: Request) {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  // Text, not .json(): Shopify signs the bytes it sent, and parsing then
  // re-serialising produces different bytes and a failing signature.
  const raw = await req.text();

  try {
    verifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256"), secret);
  } catch {
    // 401 rather than 400: this is "you are not Shopify", and Shopify
    // treats a 401 as final instead of retrying it for two days.
    return NextResponse.json({ error: "invalid_webhook" }, { status: 401 });
  }

  const topic = req.headers.get("x-shopify-topic") ?? "";
  // Only the fields this route reads are named; the rest of an order
  // payload is passed through to the database untouched, because
  // picking it apart here would be a second place to keep in step with
  // Shopify's shape.
  let body: {
    shop_domain?: string;
    customer?: { id?: number | string };
    [k: string]: unknown;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  let shop: string;
  try {
    // The header is the authoritative one; the body field is a fallback
    // for topics that omit it.
    shop = normalizeShopDomain(req.headers.get("x-shopify-shop-domain") ?? body.shop_domain ?? "");
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof ShopifyError ? e.code : "unknown" },
      { status: 400 }
    );
  }

  const customer = body.customer?.id != null ? String(body.customer.id) : null;

  const anon = createClient(
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY!
  );

  const call = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await anon.rpc(fn, args);
    // A 500 makes Shopify retry. Silently returning 200 on a failed
    // erasure would leave the data here and nobody looking for it.
    if (error) throw new Error(error.message);
  };

  try {
    switch (topic) {
      case "customers/data_request":
        await call("abo_shopify_data_request", {
          p_shop: shop,
          p_customer: customer,
          p_payload: body,
        });
        break;
      case "customers/redact":
        await call("abo_shopify_customer_redact", { p_shop: shop, p_customer: customer });
        break;
      case "shop/redact":
        await call("abo_shopify_shop_redact", { p_shop: shop });
        break;
      // Both topics carry the whole order, so both are the same write.
      // An update that arrived before the create — Shopify does not
      // promise order — still lands the order, because the write is an
      // upsert rather than an edit of something assumed to exist.
      case "orders/create":
      case "orders/updated":
      case "orders/cancelled":
      case "orders/paid":
      case "orders/fulfilled":
        await call("abo_shopify_upsert_order", { p_shop: shop, p_order: body });
        break;
      default:
        // Signed, so it really is Shopify — just a topic we never asked
        // for. Accept it; retrying it forever would help nobody.
        return NextResponse.json({ ok: true, ignored: topic });
    }
  } catch {
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
