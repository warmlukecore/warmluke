// ─────────────────────────────────────────────────────────────
// Google's sign-in, as the Google connectors use it (0215): an access
// token for an hour, from what the merchant gave.
//
//   Google Ads        their OAuth client and its refresh token (Google
//                     Ads has no service accounts for most accounts)
//   Google Analytics  a service account's key, added as a viewer of the
//                     property: a JWT signed here, traded for a token
//
// Both answer at Google's token endpoint. A grant Google no longer takes
// (revoked, expired, a deleted key) is the owner's to renew; anything
// else is tried again later.
// ─────────────────────────────────────────────────────────────

import { createSign } from "node:crypto";
import { ConnectorBusy, ConnectorRefused, type Fetch } from "./kit";

export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

async function token(form: Record<string, string>, f: Fetch, refused: string): Promise<string> {
  const res = await f(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (res.ok && body.access_token) return body.access_token;
  if (res.status === 429) throw new ConnectorBusy("Google asked us to wait.");
  if (res.status === 400 || res.status === 401) {
    throw new ConnectorRefused(`${refused}${body.error_description ? ` (Google: ${body.error_description})` : ""}`);
  }
  throw new Error(`Google's sign-in answered ${res.status}.`);
}

/** An hour's token from an OAuth client and its refresh token. */
export function fromRefresh(
  c: { client_id: string; client_secret: string; refresh_token: string },
  f: Fetch
): Promise<string> {
  return token(
    {
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: c.refresh_token,
      grant_type: "refresh_token",
    },
    f,
    "Google no longer accepts this refresh token. Make a new one and connect again."
  );
}

export type ServiceKey = { client_email: string; private_key: string };

/** A service account key as the merchant pasted it (the JSON Google gave them), or null. */
export function serviceKey(raw: string): ServiceKey | null {
  try {
    const k = JSON.parse(raw) as Partial<ServiceKey>;
    if (typeof k.client_email !== "string" || typeof k.private_key !== "string") return null;
    if (!k.private_key.includes("PRIVATE KEY")) return null;
    return { client_email: k.client_email, private_key: k.private_key };
  } catch {
    return null;
  }
}

const b64url = (s: string) => Buffer.from(s).toString("base64url");

/** An hour's token for a service account, by a JWT it signs (RFC 7523). */
export function fromServiceKey(key: ServiceKey, scope: string, f: Fetch, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope, aud: GOOGLE_TOKEN, iat, exp: iat + 3600 }));
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(key.private_key, "base64url");
  } catch {
    throw new ConnectorRefused("That service account key could not sign: paste the whole JSON file Google gave you.");
  }
  return token(
    { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${signature}` },
    f,
    "Google no longer accepts this service account key. Make a new key and connect again."
  );
}

/** A Google API's refusal, said as the connector framework hears it. */
export async function googleError(res: Response, what: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
  const said = body.error?.message?.trim();
  if (res.status === 429 || body.error?.status === "RESOURCE_EXHAUSTED")
    throw new ConnectorBusy("Google asked us to wait.");
  if (res.status === 401 || res.status === 403 || body.error?.status === "PERMISSION_DENIED") {
    throw new ConnectorRefused(`${what}${said ? ` (Google: ${said})` : ""}`);
  }
  throw new Error(`Google answered ${res.status}${said ? `: ${said}` : ""}.`);
}
