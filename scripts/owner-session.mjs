// Signing in as the owner without knowing the owner's password.
//
// Four checks needed a real session for aaa@gmail.com and got it the
// only way they knew: OWNER_PASSWORD in the environment. So they were
// skipped by anyone who did not have it — silently, with exit 0, which
// is the worst way for a check not to run. And a password that has to
// be pasted somewhere to run the tests is a password that ends up in a
// shell history, a CI variable, and eventually a chat log.
//
// The service-role key is already here and already grants everything
// this does and more, so minting a session with it adds no access —
// it only removes a secret nobody needed to be handling. That key is
// local-only by design and never reaches Vercel.
//
// OWNER_PASSWORD still works if it is set, so nothing that used to run
// stops running.

import { createClient } from "@supabase/supabase-js";

export const OWNER_EMAIL = "aaa@gmail.com";

/**
 * Returns a session for `email` on `client`, or null with the reason.
 *
 * `client` is an anon-key client, and it is left signed in — the
 * checks read `client` afterwards expecting RLS to apply as that user.
 */
export async function signInAsOwner(client, env, email = OWNER_EMAIL) {
  if (process.env.OWNER_PASSWORD) {
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password: process.env.OWNER_PASSWORD,
    });
    if (data?.session) return { session: data.session, user: data.session.user, how: "password" };
    return { session: null, why: `OWNER_PASSWORD was set but refused: ${error?.message}` };
  }

  const key = env.ADAPTIVE_OS_SERVICE_ROLE_KEY;
  if (!key) {
    return { session: null, why: "no OWNER_PASSWORD and no service-role key to mint one with" };
  }

  const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, key);
  // A one-shot link, generated and immediately spent. Nothing is
  // emailed: generateLink hands back the token rather than sending it.
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (!link?.properties?.hashed_token) {
    return { session: null, why: `could not mint a link for ${email}: ${linkErr?.message}` };
  }

  const { data, error } = await client.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  if (data?.session) return { session: data.session, user: data.session.user, how: "service-role link" };
  return { session: null, why: `the minted link would not verify: ${error?.message}` };
}
