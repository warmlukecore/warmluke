// ─────────────────────────────────────────────────────────────
// Razorpay: each online payment, on the Shopify order it paid for when
// Razorpay names it, and each settlement into the bank (0216;
// docs/integrations/connectors.md, phase 8). The prepaid side of what a
// courier's COD remittance is for cash.
//
// Reached with an API key pair (Account & Settings → API keys): the key
// id and its secret, as Razorpay's basic login. Amounts come in paise
// and are kept in rupees.
//
// What a sync reads: payments and settlements made since three days
// before the last run ended (a payment is captured, refunded or disputed
// after it is made), 100 a page; the first run reads 90 days.
// ─────────────────────────────────────────────────────────────

import {
  ConnectorBusy,
  ConnectorRefused,
  type Fetch,
  type GatewayPaymentRow,
  type GatewaySettlementRow,
  type Job,
  type SyncIO,
} from "./kit";

const RAZORPAY = "https://api.razorpay.com/v1";
const FIRST_DAYS = 90;
const REVISED_DAYS = 3;
const PAGE = 100;

export type Secret = { key_id: string; key_secret: string };

type Payment = {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  method?: string;
  fee?: number | null;
  tax?: number | null;
  amount_refunded?: number;
  email?: string;
  contact?: string;
  description?: string | null;
  notes?: Record<string, unknown> | unknown[];
  created_at?: number;
};
type Settlement = {
  id?: string;
  amount?: number;
  fees?: number;
  tax?: number;
  utr?: string;
  status?: string;
  created_at?: number;
};

const rupees = (paise: unknown): number | null =>
  typeof paise === "number" && Number.isFinite(paise) ? Math.round(paise) / 100 : null;
const at = (unix: unknown): string | null =>
  typeof unix === "number" && unix > 0 ? new Date(unix * 1000).toISOString() : null;

/**
 * The Shopify order a payment names, where a checkout put it: in its
 * notes under a Shopify order key, or "#1042" in its description. A
 * Razorpay order id (order_…) is Razorpay's own, never the shop's.
 */
export function orderRefOf(p: Payment): string | null {
  const notes = p.notes && !Array.isArray(p.notes) ? p.notes : {};
  for (const key of ["shopify_order_name", "shopify_order_number", "shopify_order_id", "order_number", "order_id"]) {
    const v = notes[key];
    if ((typeof v === "string" || typeof v === "number") && String(v).trim() && !String(v).startsWith("order_")) {
      return String(v).trim();
    }
  }
  return /#\d{3,}/.exec(p.description ?? "")?.[0] ?? null;
}

export function paymentRow(p: Payment): GatewayPaymentRow | null {
  if (!p.id) return null;
  return {
    payment_ref: p.id,
    order_ref: orderRefOf(p),
    amount: rupees(p.amount),
    currency: p.currency ?? null,
    status: p.status ?? null,
    method: p.method ?? null,
    fee: rupees(p.fee),
    tax: rupees(p.tax),
    refunded: rupees(p.amount_refunded),
    email: p.email?.trim() || null,
    phone: p.contact?.trim() || null,
    paid_at: at(p.created_at),
  };
}

export function settlementRow(s: Settlement): GatewaySettlementRow | null {
  if (!s.id) return null;
  return {
    settlement_ref: s.id,
    amount: rupees(s.amount),
    fees: rupees(s.fees),
    tax: rupees(s.tax),
    utr: s.utr?.trim() || null,
    status: s.status ?? null,
    settled_at: at(s.created_at),
  };
}

async function call(s: Secret, path: string, f: Fetch): Promise<{ items?: unknown[] }> {
  const res = await f(`${RAZORPAY}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${s.key_id}:${s.key_secret}`).toString("base64")}` },
  });
  const body = (await res.json().catch(() => ({}))) as { items?: unknown[]; error?: { description?: string } };
  if (res.ok) return body;
  if (res.status === 429) throw new ConnectorBusy("Razorpay asked us to wait.");
  if (res.status === 401) {
    throw new ConnectorRefused(body.error?.description?.trim() || "Razorpay refused this key id and secret.");
  }
  throw new Error(`Razorpay answered ${res.status}${body.error?.description ? `: ${body.error.description}` : ""}.`);
}

/** Proves the key pair and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const s: Secret = { key_id: (fields.key_id ?? "").trim(), key_secret: (fields.key_secret ?? "").trim() };
  if (!/^rzp_(live|test)_\w+$/.test(s.key_id) || !s.key_secret) {
    throw new ConnectorRefused(
      "Razorpay needs the key id (rzp_live_…) and its secret, from Account & Settings → API keys."
    );
  }
  await call(s, "/payments?count=1", f);
  const test = s.key_id.startsWith("rzp_test_");
  return {
    accountRef: s.key_id,
    accountLabel: `Razorpay ${test ? "test mode " : ""}(${s.key_id.slice(0, 9)}…${s.key_id.slice(-4)})`,
    secret: JSON.stringify(s),
  };
}

/** One run: payments, then settlements, since the last run (less the days still moving). */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const s = JSON.parse(job.secret) as Secret;
  const now = Math.floor(Date.now() / 1000);
  const through = job.cursors.payments?.synced_through;
  const from = through ? Math.floor(Date.parse(through) / 1000) - REVISED_DAYS * 86_400 : now - FIRST_DAYS * 86_400;
  for (const path of ["/payments", "/settlements"] as const) {
    for (let skip = 0; ; skip += PAGE) {
      if (Date.now() > io.deadline) return { nextMinutes: 5 };
      const page = await call(s, `${path}?from=${from}&to=${now}&count=${PAGE}&skip=${skip}`, f);
      const items = page.items ?? [];
      if (path === "/payments") {
        const rows = (items as Payment[]).map(paymentRow).filter((r): r is GatewayPaymentRow => r !== null);
        if (rows.length) await io.put("gateway_payments", rows);
      } else {
        const rows = (items as Settlement[]).map(settlementRow).filter((r): r is GatewaySettlementRow => r !== null);
        if (rows.length) await io.put("gateway_settlements", rows);
      }
      if (items.length < PAGE) break;
    }
  }
  await io.putCursor("payments", null, new Date(now * 1000).toISOString());
  return { nextMinutes: 60 };
}
