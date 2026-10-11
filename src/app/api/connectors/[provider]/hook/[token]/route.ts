import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADAPTERS } from "@/lib/connectors/adapters";

export const runtime = "nodejs";

/**
 * POST /api/connectors/[provider]/hook/[token] — a provider telling us a
 * shipment was made or moved (0205, docs/integrations/connectors.md).
 *
 * The address is the proof. Its token was made for one connection when
 * that connection's sync registered this address with the provider, and
 * only its hash is kept. The database resolves the token itself, for a
 * connection of this provider that is still connected, and writes that
 * connection's rows alone: the anon key is public, so nothing a request
 * says about itself is believed here that the database does not check.
 *
 * Callers: the provider, never a person (GoSwift's webhooks).
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string; token: string }> }) {
  const { provider, token } = await ctx.params;
  const adapter = ADAPTERS[provider as keyof typeof ADAPTERS];
  if (!adapter || !("fromHook" in adapter) || token.length < 32 || token.length > 128) {
    return NextResponse.json({ error: "no_such_hook" }, { status: 404 });
  }
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  const anon = createClient(
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
  // A topic we do not keep maps to no rows; the token is still checked.
  const { error } = await anon.rpc("abo_connector_hook", {
    p_provider: provider,
    p_token: token,
    p_rows: adapter.fromHook(body),
  });
  if (error) {
    // 401 for an address we do not know (or no longer: disconnected);
    // a 500 asks the provider to try again, right for a write that failed.
    const refused = error.code === "42501";
    if (!refused) console.error(`connector hook ${provider}:`, error.message);
    return NextResponse.json({ error: refused ? "no_such_hook" : "handler_failed" }, { status: refused ? 401 : 500 });
  }
  return NextResponse.json({ ok: true });
}
