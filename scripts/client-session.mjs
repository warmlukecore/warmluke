// A session the way a connected assistant has one.
//
// Every check that exercised the MCP endpoint signed in as the owner.
// The owner's token has no client_id claim, and the database's whole
// client branch — who may stamp a request, whether a build needs one,
// the ceiling that used to live in abo_approve_request — is skipped
// without it. So a five-a-day cap sat unseen while a check named "the
// sixth build still goes in" passed: its sixth build was never made by
// a client.
//
// This walks the real OAuth flow, headless. Register a client, ask the
// authorization server for a code, approve the consent through the
// same SDK call the consent page makes, exchange the code. The token
// that comes back is what claude.ai holds. No browser: the page is
// only a button over approveAuthorization.

import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { signInAsOwner, signInAsCheckUser } from "./owner-session.mjs";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/**
 * Returns `{ token, clientId, userId, revoke }`, or `{ token: null, why }`.
 *
 * `app` is where the resource lives (its protected-resource document
 * names the authorization server). `revoke()` ends the sessions and
 * deletes the registered client, and takes the management-API `sql`
 * function the checks already build.
 */
export async function signInAsClient(env, app, email = undefined) {
  const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
  // The check user by default: a client that builds things must build
  // them on a project that exists for the run, not the merchant's.
  const owner = email ? await signInAsOwner(anon, env, email) : await signInAsCheckUser(anon, env);
  if (!owner.session) return { token: null, why: owner.why };

  const resource = await fetch(`${app}/.well-known/oauth-protected-resource`).then((r) => r.json());
  const as = resource.authorization_servers?.[0];
  if (!as) return { token: null, why: "the resource document names no authorization server" };
  const meta = await fetch(`${as.replace(/\/$/, "")}/.well-known/oauth-authorization-server`).then((r) => r.json());

  // 1. A client, registered the way claude.ai registers itself.
  const redirectUri = `${app}/oauth/check-callback`;
  const reg = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `check-${Date.now().toString(36)}`,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const clientId = reg.body?.client_id;
  if (!clientId)
    return { token: null, why: `registration refused: ${reg.status} ${JSON.stringify(reg.body).slice(0, 200)}` };

  // 2. Ask for a code. The server answers with a redirect to the app's
  //    consent page carrying an authorization_id.
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const authz = await fetch(url, { redirect: "manual" });
  const consent = authz.headers.get("location") ?? "";
  const authorizationId = new URL(consent, app).searchParams.get("authorization_id");
  if (!authorizationId) {
    return { token: null, why: `authorize did not lead to a consent page: ${authz.status} ${consent.slice(0, 160)}` };
  }

  // 3. Approve, as the signed-in owner — the consent page's button.
  //    Details first, exactly as the page does: approving an
  //    authorization the session has not yet looked at is "not found".
  const { data: details, error: detailsErr } = await anon.auth.oauth.getAuthorizationDetails(authorizationId);
  if (detailsErr) {
    return { token: null, why: `consent details refused: ${detailsErr.message} (from ${consent.slice(0, 120)})` };
  }
  // A consent already on file skips the page and answers with the
  // redirect straight away.
  let back = details && "redirect_url" in details ? details.redirect_url : null;
  if (!back) {
    const { data: ok, error: approveErr } = await anon.auth.oauth.approveAuthorization(authorizationId);
    back = ok?.redirect_url;
    if (!back) return { token: null, why: `consent was not approved: ${approveErr?.message}` };
  }
  const code = new URL(back).searchParams.get("code");
  if (!code) return { token: null, why: `no code in the redirect: ${back.slice(0, 160)}` };

  // 4. Exchange it.
  const tok = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const token = tok.body?.access_token;
  if (!token)
    return { token: null, why: `token exchange refused: ${tok.status} ${JSON.stringify(tok.body).slice(0, 200)}` };

  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

  return {
    token,
    clientId,
    userId: owner.user.id,
    /** What the token says about itself, so a check can assert on it. */
    claims,
    async revoke(sql) {
      // The merchant's own disconnect, then the registration itself so
      // a run leaves no client behind in their list.
      try {
        await anon.rpc("abo_oauth_revoke", { p_client: clientId });
      } catch {
        // Best effort; the row delete below is what must not be skipped.
      }
      if (sql) await sql(`delete from auth.oauth_clients where id = '${clientId}'::uuid;`);
    },
  };
}
