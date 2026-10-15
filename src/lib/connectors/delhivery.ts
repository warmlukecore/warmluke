// ─────────────────────────────────────────────────────────────
// Delhivery, direct: where each of the store's Delhivery parcels is,
// matched to its Shopify order, in the same shipments list as the
// aggregators' (0216; docs/integrations/connectors.md, phase 8).
//
// Reached with the account's API token (Delhivery One → Settings → API
// setup), sent as "Token <token>". Delhivery has no list of a client's
// shipments, so a sync asks after the AWBs on the store's own Shopify
// fulfilments with Delhivery as the carrier (abo_connector_carrier_awbs),
// fifty a call, least lately asked first.
//
// ponytail: NDR reasons are read from the status's instructions on an
// undelivered attempt; confirm against a live account's answers.
// ─────────────────────────────────────────────────────────────

import { ConnectorBusy, ConnectorRefused, type Fetch, type Job, type ShipmentRow, type SyncIO } from "./kit";

const TRACK = "https://track.delhivery.com/api/v1/packages/json/";
const BATCH = 50;

export type Secret = { token: string };

type Shipment = {
  AWB?: string;
  ReferenceNo?: string;
  Status?: { Status?: string; StatusType?: string; StatusDateTime?: string; Instructions?: string };
  PickUpDate?: string;
  PickedupDate?: string;
  DeliveryDate?: string;
  CODAmount?: number | string;
};

/** Delhivery writes its times in India's time without saying so. */
export function delhiveryTime(s: unknown): string | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const t = s.trim();
  const zoned = /([+-]\d{2}:?\d{2}|Z)$/.test(t) ? t : `${t}+05:30`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** One tracked parcel as courier_shipments keeps it. */
export function shipmentRow(s: Shipment, orderNumber: string | null): ShipmentRow | null {
  if (!s.AWB) return null;
  const type = (s.Status?.StatusType ?? "").toUpperCase();
  const status = s.Status?.Status?.trim() || null;
  const statusAt = delhiveryTime(s.Status?.StatusDateTime);
  const cod = Number(s.CODAmount);
  // An attempt that did not land: what Delhivery says about it is the NDR reason.
  const undelivered = type === "UD" && /pending|not delivered|undelivered/i.test(status ?? "");
  return {
    shipment_ref: s.AWB,
    awb: s.AWB,
    order_ref: s.ReferenceNo?.trim() || orderNumber,
    courier: "Delhivery",
    status,
    status_at: statusAt,
    rto: type === "RT" || /\brto\b|returned/i.test(status ?? ""),
    ndr_reason: undelivered ? s.Status?.Instructions?.trim() || null : null,
    shipped_at: delhiveryTime(s.PickUpDate ?? s.PickedupDate),
    delivered_at: type === "DL" ? (statusAt ?? delhiveryTime(s.DeliveryDate)) : null,
    payment_mode: Number.isFinite(cod) && cod > 0 ? "cod" : "prepaid",
    cod_amount: Number.isFinite(cod) && cod > 0 ? cod : null,
    track_url: `https://www.delhivery.com/track-v2/package/${encodeURIComponent(s.AWB)}`,
  };
}

async function track(token: string, awbs: string[], f: Fetch): Promise<Shipment[]> {
  const res = await f(`${TRACK}?waybill=${encodeURIComponent(awbs.join(","))}`, {
    headers: { Authorization: `Token ${token}`, Accept: "application/json" },
  });
  const body = (await res.json().catch(() => ({}))) as {
    ShipmentData?: Array<{ Shipment?: Shipment }>;
    Error?: string;
    error?: string;
  };
  const said = (body.Error ?? body.error ?? "").trim();
  if (res.status === 429) throw new ConnectorBusy("Delhivery asked us to wait.");
  if (res.status === 401 || res.status === 403 || /token|unauthori[sz]ed/i.test(said)) {
    throw new ConnectorRefused(
      "Delhivery refused this API token: copy it again from Delhivery One → Settings → API setup."
    );
  }
  if (!res.ok) throw new Error(`Delhivery answered ${res.status}${said ? `: ${said}` : ""}.`);
  return (body.ShipmentData ?? []).map((d) => d.Shipment ?? {}).filter((s) => s.AWB);
}

/** Proves the token: an AWB that is nobody's is answered as not found, a token Delhivery refuses is refused. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const token = (fields.token ?? "").trim();
  if (token.length < 20) {
    throw new ConnectorRefused("Delhivery needs the API token from Delhivery One → Settings → API setup.");
  }
  await track(token, ["0000000000000"], f);
  return {
    accountRef: `delhivery-${token.slice(-6)}`,
    accountLabel: `Delhivery (…${token.slice(-4)})`,
    secret: JSON.stringify({ token }),
  };
}

/** One run: the store's Delhivery AWBs, fifty at a time, until none is left to ask after. */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const { token } = JSON.parse(job.secret) as Secret;
  const asked = new Set<string>();
  for (;;) {
    if (Date.now() > io.deadline) return { nextMinutes: 5 };
    const due = (await io.carrierAwbs("delhivery", BATCH)).filter((d) => !asked.has(d.awb));
    // Ones Delhivery did not know come round again: once each a run is enough.
    if (due.length === 0) return { nextMinutes: 60 };
    for (const d of due) asked.add(d.awb);
    const orders = new Map(due.map((d) => [d.awb, d.order_number]));
    const rows = (
      await track(
        token,
        due.map((d) => d.awb),
        f
      )
    )
      .map((s) => shipmentRow(s, orders.get(s.AWB as string) ?? null))
      .filter((r): r is ShipmentRow => r !== null);
    if (rows.length) await io.putShipments(rows);
  }
}
