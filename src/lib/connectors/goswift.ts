// ─────────────────────────────────────────────────────────────
// GoSwift: a store's shipments, told to us as they move
// (docs/integrations/connectors.md, phase 3, 11 Oct).
//
// Reached with what GoSwift gives a merchant who asks for API access
// (tech-integrations@goswift.in): a client ID and an API login. The login
// buys a bearer token for about a day; it is kept in the vault with the
// token, and the token is renewed before it lapses.
//
// GoSwift has no list of shipments to walk (its API, v3.8.8, 11 Oct): it
// posts them to us instead. So a sync makes sure our address is
// registered for its shipment and tracking webhooks, then asks after the
// shipments we know that have gone quiet, by its open tracking call, in
// case a delivery was missed. A store's shipments start the day it
// connects; older ones join the next time they move.
//
// ponytail: GoSwift signs each delivery with the hook's secret, but its
// docs do not name the header; the address's token is the proof until a
// live delivery shows it, then check it in abo_connector_hook as well.
// ponytail: a reconnect registers a fresh address; the old one is refused
// and stays listed in GoSwift until removed there.
// ─────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import { ConnectorBusy, ConnectorRefused, type Fetch, type Job, type ShipmentRow, type SyncIO } from "./kit";

export const GOSWIFT_API = "https://app.goswift.in";
/** What our address hears about: a shipment made, made again, and every tracking step. */
const TOPICS = ["track_updated", "shipment_created", "shipment_recreated"];
/** Statuses a shipment does not move on from (swift_status). */
const SETTLED = ["Delivered", "Cancelled", "Seller Cancelled", "RTO Delivered", "Lost", "Damaged", "Pickup Cancelled"];
/** Quiet shipments asked after in one run. */
const CATCH_UP = 100;

export type Secret = {
  client_id: string;
  username: string;
  password: string;
  token?: string;
  /** When the token lapses (ISO). */
  token_until?: string;
  /** The webhook registered for this connection: its id at GoSwift, our address's token, its signing secret. */
  hook?: { id: string; token: string; secret: string };
};

const text = (v: unknown): string | null =>
  (typeof v === "string" || typeof v === "number") && String(v).trim() ? String(v).trim() : null;
/** GoSwift's times are milliseconds since the epoch. */
const when = (ms: unknown): string | null => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};
const count = (v: unknown): number | null => {
  const n = Number(v);
  return text(v) !== null && Number.isInteger(n) && n >= 0 ? n : null;
};
const said = (b: unknown): string | null => {
  const o = b as { message?: unknown; description?: unknown } | null;
  return text(o?.message) ?? text(o?.description);
};
const trackUrl = (id: string) => `${GOSWIFT_API}/track/${encodeURIComponent(id)}`;

/** Proves a login and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const client_id = (fields.client_id ?? "").trim();
  const username = (fields.username ?? "").trim();
  const password = fields.password ?? "";
  if (!client_id || !username || !password) {
    throw new ConnectorRefused("GoSwift needs the client ID, API username and password.");
  }
  const secret: Secret = { client_id, username, password, ...(await signIn(client_id, username, password, f)) };
  return { accountRef: client_id, accountLabel: username, secret: JSON.stringify(secret) };
}

async function signIn(
  client_id: string,
  username: string,
  password: string,
  f: Fetch
): Promise<{ token: string; token_until: string }> {
  const res = await f(`${GOSWIFT_API}/integrations/v2/auth/token/${encodeURIComponent(client_id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (res.status === 429) throw new ConnectorBusy("GoSwift asked us to wait.");
  if (!res.ok || !body.access_token) {
    // A wrong client ID or login is theirs to say; anything else is an outage.
    if (res.status >= 400 && res.status < 500) throw new ConnectorRefused(said(body) ?? "GoSwift refused this login.");
    throw new Error(`GoSwift answered ${res.status}.`);
  }
  const seconds = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
  return { token: body.access_token, token_until: new Date(Date.now() + seconds * 1000).toISOString() };
}

/** What a status says beside itself: delivered when, gone back, or why it was not delivered. */
function moved(status: string | null, at: string | null, reason: unknown) {
  return {
    delivered_at: status === "Delivered" ? at : null,
    rto: !!status?.startsWith("RTO"),
    ndr_reason: status === "Undelivered" ? text(reason) : null,
  };
}

/** One delivery to our address, as rows: a tracking step, or a shipment made or made again. */
export function fromHook(body: unknown): ShipmentRow[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = text(b.id);
  if (!id) return [];
  const status = text(b.status);
  const at = when(b.ctime);
  return [
    {
      shipment_ref: id,
      awb: text(b.wbn),
      order_ref: text(b.orderNumber),
      courier: text(b.vendor),
      status,
      status_at: at,
      ...moved(status, at, b.desc),
      ndr_attempts: count(b.attempts),
      shipped_at: when(b.pickupTime),
      track_url: trackUrl(id),
    },
  ];
}

/** One answer of the tracking call (track_obj), as a row. */
export function fromTrack(body: unknown): ShipmentRow | null {
  const b = (body ?? {}) as { _id?: unknown; order_number?: unknown; track?: Record<string, unknown> };
  const id = text(b._id);
  const t = b.track;
  if (!id || !t) return null;
  const status = text(t.status);
  const at = when(t.ctime);
  return {
    shipment_ref: id,
    awb: null,
    order_ref: text(b.order_number),
    status,
    status_at: at,
    ...moved(status, at, t.ndrStatus ?? t.desc),
    ndr_attempts: count(t.attempts),
    shipped_at: when(t.pickupTime),
    track_url: trackUrl(id),
  };
}

/**
 * One run of a store's sync: our address registered and listening, then
 * the quiet shipments asked after. Returns how many minutes until the next.
 */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  let secret = JSON.parse(job.secret) as Secret;
  const renew = async () => {
    secret = { ...secret, ...(await signIn(secret.client_id, secret.username, secret.password, f)) };
    await io.putSecret(JSON.stringify(secret));
  };
  // GoSwift hands back the same token until it lapses, so it is asked again only near the end.
  if (!secret.token || !secret.token_until || Date.parse(secret.token_until) - Date.now() < 10 * 60_000) {
    await renew();
  }

  let renewed = false;
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    for (;;) {
      const res = await f(`${GOSWIFT_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secret.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && !renewed) {
        // A token GoSwift no longer takes: one fresh login, then on.
        renewed = true;
        await renew();
        continue;
      }
      if (res.status === 429) throw new ConnectorBusy("GoSwift asked us to wait.");
      if (res.status === 401 || res.status === 403) throw new ConnectorRefused("GoSwift no longer accepts this login.");
      const out = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`GoSwift answered ${res.status}${said(out) ? `: ${said(out)}` : ""}.`);
      return out;
    }
  };

  // Our address, registered and listening for every topic.
  const hooks = ((await api("GET", "/api/v2/webhook")) ?? []) as Array<{
    id?: string;
    url?: string;
    active?: boolean;
    topics?: string[];
  }>;
  const ours = secret.hook ? hooks.find((h) => String(h.id) === secret.hook!.id) : undefined;
  const listening =
    ours &&
    ours.active !== false &&
    ours.url === io.hookBase + secret.hook!.token &&
    TOPICS.every((t) => ours.topics?.includes(t));
  if (!listening) {
    // 256 random bits in the address; a 30-character secret, GoSwift's most.
    const hook = { token: randomBytes(32).toString("hex"), secret: randomBytes(15).toString("hex") };
    // The address is accepted before GoSwift is told it, so no first delivery is refused.
    await io.putHook(hook.token);
    const body = { url: io.hookBase + hook.token, secret: hook.secret, topics: TOPICS, active: true };
    const made = (await (ours
      ? api("PUT", `/api/v2/webhook/${encodeURIComponent(String(ours.id))}`, body)
      : api("POST", "/api/v2/webhook", body))) as { id?: unknown } | null;
    const id = text(made?.id) ?? text(ours?.id);
    if (!id) throw new Error("GoSwift did not say which webhook it made.");
    secret = { ...secret, hook: { id, ...hook } };
    await io.putSecret(JSON.stringify(secret));
  }

  // The quiet ones, in case a delivery was missed. Tracking is open: no token.
  const quiet = await io.openShipments(SETTLED, CATCH_UP);
  const rows: ShipmentRow[] = [];
  for (const id of quiet) {
    if (Date.now() > io.deadline) break;
    const res = await f(`${GOSWIFT_API}/api/v1/track/${encodeURIComponent(id)}`);
    if (res.status === 429) break;
    const row = res.ok ? fromTrack(await res.json().catch(() => null)) : null;
    // One it cannot tell us about is marked asked, so it waits its six hours like the rest.
    rows.push(row ?? { shipment_ref: id, awb: null, order_ref: null });
  }
  if (rows.length) await io.putShipments(rows);
  await io.putCursor("tracking", null, new Date().toISOString());
  return { nextMinutes: 30 };
}
