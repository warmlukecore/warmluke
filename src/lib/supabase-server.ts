import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY ?? "";

/**
 * Creates a Supabase client that talks to PostgREST AS THE CALLING USER:
 * the anon apikey authenticates the client, while the accessToken
 * callback injects the user's JWT into Authorization — so RLS runs
 * with auth.uid() = that user. Isolation is enforced by the database.
 * Returns null for invalid/expired tokens.
 */
export async function getUserClient(
  req: Request
): Promise<{ client: SupabaseClient; userId: string } | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : null;
  if (!token || !url || !anonKey) return null;

  // Verify the token directly (client.auth.getUser would override
  // the Authorization header with its own session state).
  const verifyRes = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!verifyRes.ok) return null;
  const user = (await verifyRes.json()) as { id?: string; sub?: string };
  const userId = user.id ?? user.sub;
  if (!userId) return null;

  const client = createClient(url, anonKey, {
    accessToken: async () => token,
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return { client, userId };
}
