import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyWebhookHmac } from "@/lib/shopify";
import { LIFECYCLE_TOPICS } from "@/lib/shopify-webhooks";

export const runtime = "nodejs";

/**
 * POST /api/shopify/webhooks/[token] — everything Shopify tells us
 * about.
 *
 * One endpoint per store and not per topic: the topic is a header, and
 * a route per topic would be a dozen places to forget to verify a
 * signature. The store, though, cannot be a header. Shopify signs the
 * body with one secret shared by the whole app, so its HMAC says a
 * delivery came from Shopify and never which shop sent it — and this
 * route once read the shop out of a header and then SIGNED it, which
 * turned it into an oracle: replay one real signed body here with
 * somebody else's shop name and it handed back a valid signature for
 * the claim. The address carries the store now, and nothing the
 * request says about itself is believed.
 *
 * Order matters the same way it does in the callback: the body is read
 * as raw text and its signature checked before anything in it is parsed
 * or believed. An unsigned request is refused before it can name a shop
 * — otherwise anyone who guessed this URL could erase a store.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
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
  // The body is still parsed for nothing but validity — every field
  // the handlers need is read in the database, from a body whose
  // signature has already been checked.
  try {
    JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  const anon = createClient(
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY!
  );

  // One call. Which store this belongs to is the address it arrived
  // at, and the database resolves that itself — it is not passed a
  // shop to trust. The body signature is checked there a second time
  // because this route is not the only way to reach that function:
  // PostgREST is, and the anon key is public.
  //
  // A topic about the app itself — app/uninstalled — has a function of
  // its own, which proves the delivery the same two ways.
  const lifecycle = LIFECYCLE_TOPICS[topic.toUpperCase().replace("/", "_")];
  const { error } = lifecycle
    ? await anon.rpc(lifecycle, {
        p_token: token,
        p_raw: raw,
        p_hmac: req.headers.get("x-shopify-hmac-sha256"),
      })
    : await anon.rpc("abo_shopify_webhook", {
        p_token: token,
        p_topic: topic,
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
