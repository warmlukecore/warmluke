import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyWebhookHmac } from "@/lib/shopify";

export const runtime = "nodejs";

/**
 * POST /api/shopify/webhooks/compliance — the three Shopify keeps for
 * itself.
 *
 * Every other topic arrives at a per-store address, because the shop
 * cannot be read from a header anybody can rewrite. These three cannot
 * do that: Shopify refuses to let an app subscribe to
 * customers/data_request, customers/redact or shop/redact, and asks
 * instead for one URI in the app's settings that serves every shop at
 * once. There is no per-store URL to give it.
 *
 * So they use the one binding that really is available: these payloads
 * name the shop INSIDE the body, and the body is what Shopify's HMAC
 * covers. Naming somebody else's shop here would mean forging a signed
 * body, which means holding the app secret. That is the difference
 * between this and the header the tokenized route stopped believing.
 *
 * A static segment, so Next matches it before [token]; the tokenized
 * route refuses these topics anyway, and this one refuses every other.
 */
export async function POST(req: Request) {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const raw = await req.text();
  try {
    verifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256"), secret);
  } catch {
    return NextResponse.json({ error: "invalid_webhook" }, { status: 401 });
  }

  const topic = req.headers.get("x-shopify-topic") ?? "";
  try {
    JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  const anon = createClient(
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY!
  );

  // The shop is read from the signed body in the database, not passed
  // in from here. The signature is checked there a second time because
  // this route is not the only way to reach that function.
  const { error } = await anon.rpc("abo_shopify_compliance", {
    p_topic: topic,
    p_raw: raw,
    p_hmac: req.headers.get("x-shopify-hmac-sha256"),
  });

  if (error) {
    const refused = /did not come from Shopify|Unsigned/.test(error.message);
    return NextResponse.json(
      { error: refused ? "invalid_webhook" : "handler_failed" },
      { status: refused ? 401 : 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
