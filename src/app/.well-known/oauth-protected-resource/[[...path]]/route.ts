import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /.well-known/oauth-protected-resource — where to go to sign in.
 *
 * An MCP client that gets a 401 from /api/mcp reads this to learn which
 * authorization server guards it, registers itself there, and sends the
 * merchant to consent. Without it the client can only report that the
 * tool is broken, because it has no way to discover who to ask.
 *
 * Served under any trailing path as well as bare: clients differ on
 * whether they insert the resource's path into the well-known URL, and
 * a 404 here stops the whole flow before it starts.
 */
export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const supabase = process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
  if (!supabase) {
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }

  return NextResponse.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [`${supabase}/auth/v1`],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "email", "offline_access"],
      resource_documentation: `${origin}/privacy`,
    },
    // Public and stable, so a client is not fetching it on every
    // reconnect.
    { headers: { "Cache-Control": "public, max-age=3600" } }
  );
}
