import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL / NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY — check .env.local (restart the dev server after editing it)"
  );
}

/** Browser client (anon role — RLS is permissive in this prototype). */
export const supabase = createClient(url, anonKey);
