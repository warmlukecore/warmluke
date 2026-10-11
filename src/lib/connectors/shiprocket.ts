// ─────────────────────────────────────────────────────────────
// Shiprocket: a store's shipments, from its courier aggregator
// (docs/integrations/connectors.md, phase 2, 11 Oct).
//
// Reached with an API user (Settings → API in Shiprocket): its login
// gives a token good for 240 hours, sent as a bearer on every call. The
// login is kept in the vault with the token, so the token is renewed
// before it lapses without asking the merchant again.
//
// What a sync reads: the orders list, newest first, a page at a time;
// each order carries its shipments (id, AWB, courier) and the store's
// own order id (channel_order_id), which is how a shipment finds its
// Shopify order. Only fields Shiprocket documents are mapped.
//
// ponytail: NDR, RTO dates, freight and COD remittance are not in its
// published collection; map them once a live account's responses are
// seen, rather than from a guess at their names.
// ─────────────────────────────────────────────────────────────

export const SHIPROCKET_API = "https://apiv2.shiprocket.in/v1/external";
/** Renewed a day before Shiprocket's 240 hours run out. */
const TOKEN_HOURS = 216;
const PAGE = 100;
/** A sync that has walked back past what it already has, by this much, stops. */
const OVERLAP_DAYS = 14;

/** The provider turned the credential down: the owner must connect again. */
export class ConnectorRefused extends Error {}
/** The provider asked us to slow down: come back later, nothing is wrong. */
export class ConnectorBusy extends Error {}

export type Secret = { email: string; password: string; token?: string; token_at?: string };

export type ShipmentRow = {
  shipment_ref: string;
  awb: string | null;
  order_ref: string | null;
  courier: string | null;
  status: string | null;
  payment_mode: string | null;
  cod_amount: number | null;
  track_url: string | null;
};

export type Job = {
  secret: string;
  cursors: Record<string, { cursor: string | null; synced_through: string | null }>;
};

export type SyncIO = {
  putShipments(rows: ShipmentRow[]): Promise<void>;
  putCursor(resource: string, cursor: string | null, through?: string | null): Promise<void>;
  putSecret(secret: string): Promise<void>;
  /** Stop starting pages after this (ms since epoch); the next run carries on. */
  deadline: number;
};

type Fetch = typeof fetch;

/** Proves an API user's login and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const email = (fields.email ?? "").trim().toLowerCase();
  const password = fields.password ?? "";
  if (!email || !password) throw new ConnectorRefused("Shiprocket needs the API user's email and password.");
  const token = await signIn(email, password, f);
  const secret: Secret = { email, password, token, token_at: new Date().toISOString() };
  return { accountRef: email, accountLabel: email, secret: JSON.stringify(secret) };
}

async function signIn(email: string, password: string, f: Fetch): Promise<string> {
  const res = await f(`${SHIPROCKET_API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
  if (res.status === 429) throw new ConnectorBusy("Shiprocket asked us to wait.");
  if (!res.ok || !body.token) {
    // 400/401/403 are a wrong or disabled login; anything else is theirs.
    if (res.status >= 400 && res.status < 500) {
      throw new ConnectorRefused(body.message?.trim() || "Shiprocket refused this login.");
    }
    throw new Error(`Shiprocket answered ${res.status}.`);
  }
  return body.token;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Dates as Shiprocket writes them ("31 Jul 2019, 03:03 PM", "28th Aug 2018 07:11 PM", "2019-08-01 05:20:55"), in India's time. */
export function shiprocketDate(s: unknown): string | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6] ?? "00"}+05:30`).toISOString();
  const m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(
    s.trim()
  );
  if (!m) return null;
  const month =
    "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(m[2].slice(0, 1).toUpperCase() + m[2].slice(1, 3).toLowerCase()) / 3;
  if (month < 0 || !Number.isInteger(month)) return null;
  let hour = Number(m[4]) % 12;
  if (m[6].toUpperCase() === "PM") hour += 12;
  return new Date(`${m[3]}-${pad(month + 1)}-${pad(Number(m[1]))}T${pad(hour)}:${m[5]}:00+05:30`).toISOString();
}

type SrOrder = {
  channel_order_id?: string | null;
  status?: string | null;
  payment_method?: string | null;
  total?: string | number | null;
  created_at?: string | null;
  shipments?: Array<{ id?: number | string | null; awb?: string | null; courier?: string | null }> | null;
};

/** One order's shipments, as rows. */
export function shipmentsOf(order: SrOrder): ShipmentRow[] {
  const cod = (order.payment_method ?? "").toLowerCase() === "cod";
  return (order.shipments ?? [])
    .filter((s) => s?.id !== null && s?.id !== undefined && String(s.id) !== "")
    .map((s) => {
      const awb = s.awb?.trim() || null;
      return {
        shipment_ref: String(s.id),
        awb,
        order_ref: order.channel_order_id?.toString().trim() || null,
        courier: s.courier?.trim() || null,
        status: order.status?.trim() || null,
        payment_mode: order.payment_method?.trim().toLowerCase() || null,
        cod_amount: cod && order.total !== null && order.total !== undefined ? Number(order.total) : null,
        track_url: awb ? `https://app.shiprocket.in/tracking/awb/${encodeURIComponent(awb)}` : null,
      };
    });
}

/**
 * One run of a store's sync: as many pages as fit before the deadline.
 * Returns how many minutes until the next run.
 */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  let secret = JSON.parse(job.secret) as Secret;
  const fresh = secret.token && secret.token_at && Date.now() - Date.parse(secret.token_at) < TOKEN_HOURS * 3600_000;
  if (!fresh) {
    secret = { ...secret, token: await signIn(secret.email, secret.password, f), token_at: new Date().toISOString() };
    await io.putSecret(JSON.stringify(secret));
  }

  const kept = job.cursors.orders;
  const since = kept?.synced_through ? Date.parse(kept.synced_through) - OVERLAP_DAYS * 86_400_000 : null;
  let page = Number(kept?.cursor) || 1;
  const startedAt = new Date().toISOString();
  let renewed = false;

  for (;;) {
    if (Date.now() > io.deadline) {
      await io.putCursor("orders", String(page));
      return { nextMinutes: 5 };
    }
    const res = await f(`${SHIPROCKET_API}/orders?page=${page}&per_page=${PAGE}`, {
      headers: { Authorization: `Bearer ${secret.token}` },
    });
    if (res.status === 401 && !renewed) {
      // A token Shiprocket no longer takes: one fresh login, then on.
      renewed = true;
      secret = { ...secret, token: await signIn(secret.email, secret.password, f), token_at: new Date().toISOString() };
      await io.putSecret(JSON.stringify(secret));
      continue;
    }
    if (res.status === 429) throw new ConnectorBusy("Shiprocket asked us to wait.");
    if (res.status === 401 || res.status === 403)
      throw new ConnectorRefused("Shiprocket no longer accepts this login.");
    if (!res.ok) throw new Error(`Shiprocket answered ${res.status}.`);
    const body = (await res.json()) as {
      data?: SrOrder[];
      meta?: { pagination?: { total_pages?: number; current_page?: number } };
    };
    const orders = body.data ?? [];
    const rows = orders.flatMap(shipmentsOf);
    if (rows.length) await io.putShipments(rows);
    const pages = body.meta?.pagination?.total_pages ?? page;
    const oldest = orders
      .map((o) => shiprocketDate(o.created_at))
      .filter(Boolean)
      .toSorted()[0];
    const caughtUp = since !== null && oldest !== undefined && Date.parse(oldest as string) < since;
    if (page >= pages || orders.length === 0 || caughtUp) {
      await io.putCursor("orders", null, startedAt);
      return { nextMinutes: 30 };
    }
    page += 1;
  }
}
