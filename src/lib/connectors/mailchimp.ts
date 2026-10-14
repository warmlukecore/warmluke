// ─────────────────────────────────────────────────────────────
// Mailchimp: each email campaign the store sent, with its opens, clicks,
// unsubscribes, and the orders and revenue Mailchimp's e-commerce
// tracking credits it with (0215; docs/integrations/connectors.md,
// phase 7).
//
// Reached with an API key (Account → Extras → API keys); its end names
// the data centre ("…-us21") every call goes to.
//
// What a sync reads: the reports list, sent since a month before the
// last run finished (a campaign keeps gathering opens for weeks), 100 a
// page. The first run reads the last six months.
// ─────────────────────────────────────────────────────────────

import { ConnectorBusy, ConnectorRefused, type EmailCampaignRow, type Fetch, type Job, type SyncIO } from "./kit";

const FIRST_DAYS = 180;
const SETTLING_DAYS = 30;
const PAGE = 100;

export type Secret = { api_key: string; dc: string };

/** "…-us21" → "us21": the data centre a key belongs to, or null for something else. */
export const dataCentre = (key: string): string | null =>
  /^[0-9a-f]{32}-([a-z]{2}\d{1,3})$/i.exec(key.trim())?.[1] ?? null;

type Report = {
  id?: string;
  campaign_title?: string;
  subject_line?: string;
  send_time?: string;
  emails_sent?: number;
  unsubscribed?: number;
  bounces?: { hard_bounces?: number; soft_bounces?: number };
  opens?: { unique_opens?: number };
  clicks?: { unique_subscriber_clicks?: number };
  ecommerce?: { total_orders?: number; total_revenue?: number; currency_code?: string };
};

/** One report as email_campaigns keeps it. */
export function campaignRow(r: Report): EmailCampaignRow | null {
  if (!r.id) return null;
  const bounced = (r.bounces?.hard_bounces ?? 0) + (r.bounces?.soft_bounces ?? 0);
  const sent = r.emails_sent ?? null;
  return {
    campaign_ref: r.id,
    name: r.campaign_title?.trim() || null,
    subject: r.subject_line?.trim() || null,
    sent_at: r.send_time || null,
    sent,
    delivered: sent === null ? null : Math.max(0, sent - bounced),
    opens: r.opens?.unique_opens ?? null,
    clicks: r.clicks?.unique_subscriber_clicks ?? null,
    unsubscribes: r.unsubscribed ?? null,
    bounces: bounced,
    orders: r.ecommerce?.total_orders ?? null,
    revenue: r.ecommerce?.total_revenue ?? null,
    currency: r.ecommerce?.currency_code ?? null,
  };
}

async function call(s: Secret, path: string, f: Fetch): Promise<Record<string, unknown>> {
  const res = await f(`https://${s.dc}.api.mailchimp.com/3.0${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`warmluke:${s.api_key}`).toString("base64")}` },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { detail?: string };
  if (res.ok) return body;
  if (res.status === 429) throw new ConnectorBusy("Mailchimp asked us to wait.");
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorRefused(body.detail?.toString().trim() || "Mailchimp refused this API key.");
  }
  throw new Error(`Mailchimp answered ${res.status}.`);
}

/** Proves the key and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const api_key = (fields.api_key ?? "").trim();
  const dc = dataCentre(api_key);
  if (!dc) {
    throw new ConnectorRefused("A Mailchimp API key is 32 letters and digits, a dash and its data centre (…-us21).");
  }
  const s: Secret = { api_key, dc };
  const me = (await call(s, "/", f)) as { account_id?: string; account_name?: string; email?: string };
  return {
    accountRef: me.account_id ?? dc,
    accountLabel: me.account_name?.trim() || me.email || "Mailchimp",
    secret: JSON.stringify(s),
  };
}

/** One run: every campaign sent since a month before the last run, a page at a time. */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const s = JSON.parse(job.secret) as Secret;
  const through = job.cursors.reports?.synced_through;
  const since = new Date(
    through ? Date.parse(through) - SETTLING_DAYS * 86_400_000 : Date.now() - FIRST_DAYS * 86_400_000
  ).toISOString();
  const startedAt = new Date().toISOString();
  for (let offset = 0; ; offset += PAGE) {
    if (Date.now() > io.deadline) return { nextMinutes: 5 };
    const page = (await call(
      s,
      `/reports?count=${PAGE}&offset=${offset}&since_send_time=${encodeURIComponent(since)}`,
      f
    )) as { reports?: Report[]; total_items?: number };
    const rows = (page.reports ?? []).map(campaignRow).filter((r): r is EmailCampaignRow => r !== null);
    if (rows.length) await io.put("email_campaigns", rows);
    if (offset + PAGE >= (page.total_items ?? 0) || (page.reports ?? []).length === 0) break;
  }
  await io.putCursor("reports", null, startedAt);
  return { nextMinutes: 360 };
}
