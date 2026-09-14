import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ShopifyError, normalizeShopDomain, verifyWebhookHmac } from "@/lib/shopify";

export const runtime = "nodejs";

/**
 * POST /api/shopify/webhooks — everything Shopify tells us about.
 *
 * One endpoint for every topic, because the topic is a header, and a
 * route per topic would be a dozen places to forget to verify a
 * signature.
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
    id?: number | string;
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

  const anon = createClient(
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY!
  );

  // One call, and the signature travels with it. The database checks
  // it again before writing anything, because this route is not the
  // only way to reach those functions — PostgREST is, and the anon key
  // is public. A check that lives only here protects only the people
  // who choose to come through here.
  const { error } = await anon.rpc("abo_shopify_webhook", {
    p_topic: topic,
    p_shop: shop,
    p_raw: raw,
    p_hmac: req.headers.get("x-shopify-hmac-sha256"),
  });

  if (error) {
    // A 500 makes Shopify retry, which is right for a write that
    // failed and wrong for one it will never accept.
    const refused = /did not come from Shopify|Unsigned/.test(error.message);
    return NextResponse.json(
      { error: refused ? "invalid_webhook" : "handler_failed" },
      { status: refused ? 401 : 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
