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
import crypto from "node:crypto";

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

// ── The check user, and a project that exists only for one run ──────
//
// Every check that wrote anything signed in as the real owner and wrote
// on their real project. The hourly request ceiling is per USER, so a
// run's leftovers spent the merchant's own budget — for an hour after
// a crashed check, their actual Claude was told "too many requests".
// Killing an echoed browser token meant revoking every session the
// merchant had. And a crashed run left rows in their real app.
//
// So: one account that exists for checks, and a project per run that
// is deleted at the end. Deleting a project cascades everything under
// it, which makes cleanup one line and makes leaving debris behind
// impossible rather than merely careful.
//
// Checks that only READ the connected store keep signing in as the
// real owner, because the store is theirs and reading it changes
// nothing. Everything that writes goes here.

export const CHECK_EMAIL = "check@warmluke.test";

/** Signs `client` in as the check user, creating the account once. */
export async function signInAsCheckUser(client, env) {
  const key = env.ADAPTIVE_OS_SERVICE_ROLE_KEY;
  if (!key) return { session: null, why: "no service-role key to make the check user with" };
  const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, key);
  // Idempotent: a second run finds the user and moves on. Made with a
  // random password nobody keeps — the session is minted, never typed.
  const { error } = await admin.auth.admin.createUser({
    email: CHECK_EMAIL,
    password: `${crypto.randomUUID()}Aa1!`,
    email_confirm: true,
  });
  if (error && !/already|exists|registered/i.test(error.message)) {
    return { session: null, why: `could not make the check user: ${error.message}` };
  }
  const signed = await signInAsOwner(client, env, CHECK_EMAIL);
  if (!signed.session) return signed;
  // The settings row is made lazily by the app, on first use. A check
  // that snapshots the account before using it found no row and died
  // before its own cleanup ran — leaving a project behind for the next
  // check to trip over. Made here, once, so the account is whole
  // before any check looks at it.
  await admin
    .from("account_settings")
    .upsert({ user_id: signed.user.id }, { onConflict: "user_id", ignoreDuplicates: true });
  // Every MCP call this account has ever made is a check's. The
  // hourly ceiling on them is per user, so three full runs inside an
  // hour — a laptop and two pushes — spent it, and the fourth run's
  // read_section came back "too many requests" in CI with nothing in
  // the diff to explain it. A run starts with the budget it would have
  // on a fresh account.
  await admin.from("mcp_calls").delete().eq("user_id", signed.user.id);
  return signed;
}

/**
 * A project for this run only. `remove()` deletes it, and with it every
 * section, row, request, thread and rule under it.
 */
export async function throwawayProject(admin, ownerId, label) {
  // A run that crashed before remove() leaves its project behind.
  // Under the check user that harms nobody — but it should not pile
  // up either, so anything of ours older than an hour goes first. An
  // hour, not zero: two checks may run at once and must not delete
  // each other's.
  await admin
    .from("projects")
    .delete()
    .eq("owner_id", ownerId)
    .like("name", "check %")
    .lt("created_at", new Date(Date.now() - 36e5).toISOString());
  const { data, error } = await admin
    .from("projects")
    .insert({ owner_id: ownerId, name: `check ${label}` })
    .select("id, auto_build")
    .single();
  if (error || !data) throw new Error(`could not make a project for the check: ${error?.message}`);
  return {
    id: data.id,
    auto_build: data.auto_build,
    async remove() {
      await admin.from("projects").delete().eq("id", data.id);
    },
  };
}
