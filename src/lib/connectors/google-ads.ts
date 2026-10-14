// ─────────────────────────────────────────────────────────────
// Google Ads: what each campaign spent and what Google counts as its
// conversions, by day, into the same ad_spend list as Meta's (0214,
// 0215; docs/integrations/connectors.md, phase 5).
//
// Reached with the merchant's own API access: a developer token from
// their Google Ads manager account, an OAuth client and a refresh token
// made with it, and the account (customer) id. Our own app needs no
// approval from Google for this.
//
// What a sync reads: GAQL over campaign, one row per campaign and day
// (segments.date), through googleAds:search a month at a time, in pages
// of 10,000. Google revises recent days, so each run starts again three
// days before where the last one finished. Cost comes in micros.
//
// "Conversions" are whatever the account counts as one, which is most
// often a purchase but need not be: the list says so.
// ─────────────────────────────────────────────────────────────

import { fromRefresh, googleError } from "./google";
import { addDays, ConnectorRefused, dayIn, type AdSpendRow, type Fetch, type Job, type SyncIO } from "./kit";

const ADS = "https://googleads.googleapis.com/v25";
const FIRST_DAYS = 90;
const REVISED_DAYS = 3;
const WINDOW_DAYS = 30;

export type Secret = {
  developer_token: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  customer_id: string;
  login_customer_id?: string | null;
  timezone?: string | null;
};

/** "123-456-7890" or "1234567890" → "1234567890"; anything else is not an account. */
export const customerId = (raw: string): string | null => {
  const digits = raw.replace(/[\s-]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
};

type AdsRow = {
  campaign?: { id?: string; name?: string };
  segments?: { date?: string };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: number | string;
    conversionsValue?: number | string;
  };
  customer?: { currencyCode?: string; descriptiveName?: string; timeZone?: string };
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** One GAQL row as ad_spend keeps it, or null without a campaign or day. */
export function spendRow(r: AdsRow): AdSpendRow | null {
  const id = r.campaign?.id;
  const day = r.segments?.date;
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) return null;
  return {
    campaign_id: String(id),
    campaign_name: r.campaign?.name?.trim() || null,
    day: day as string,
    spend: Math.round(((num(r.metrics?.costMicros) ?? 0) / 1_000_000) * 100) / 100,
    currency: r.customer?.currencyCode ?? null,
    impressions: num(r.metrics?.impressions),
    clicks: num(r.metrics?.clicks),
    purchases: num(r.metrics?.conversions) ?? 0,
    purchase_value: num(r.metrics?.conversionsValue) ?? 0,
  };
}

/** One page of a GAQL search on the account. */
async function search(
  s: Secret,
  access: string,
  query: string,
  f: Fetch,
  pageToken?: string
): Promise<{ results?: AdsRow[]; nextPageToken?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    "developer-token": s.developer_token,
    "Content-Type": "application/json",
  };
  if (s.login_customer_id) headers["login-customer-id"] = s.login_customer_id;
  const res = await f(`${ADS}/customers/${s.customer_id}/googleAds:search`, {
    method: "POST",
    headers,
    body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
  });
  if (!res.ok) {
    await googleError(
      res,
      "Google Ads will not let this login read that account: check the developer token's access level and that the account id is one this login manages."
    );
  }
  return (await res.json()) as { results?: AdsRow[]; nextPageToken?: string };
}

/** Proves the login can read the account and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const customer = customerId(fields.customer_id ?? "");
  const manager = fields.login_customer_id?.trim() ? customerId(fields.login_customer_id) : null;
  const s: Secret = {
    developer_token: (fields.developer_token ?? "").trim(),
    client_id: (fields.client_id ?? "").trim(),
    client_secret: (fields.client_secret ?? "").trim(),
    refresh_token: (fields.refresh_token ?? "").trim(),
    customer_id: customer ?? "",
    login_customer_id: manager,
  };
  if (!customer || !s.developer_token || !s.client_id || !s.client_secret || !s.refresh_token) {
    throw new ConnectorRefused(
      "Google Ads needs the developer token, the OAuth client's id and secret, a refresh token, and the account id (ten digits)."
    );
  }
  if (fields.login_customer_id?.trim() && !manager) {
    throw new ConnectorRefused("The manager account id is ten digits, as Google Ads shows it.");
  }
  const access = await fromRefresh(s, f);
  const page = await search(
    s,
    access,
    "SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1",
    f
  );
  const c = page.results?.[0]?.customer;
  const kept: Secret = { ...s, timezone: c?.timeZone ?? null };
  const pretty = `${customer.slice(0, 3)}-${customer.slice(3, 6)}-${customer.slice(6)}`;
  return {
    accountRef: customer,
    accountLabel: c?.descriptiveName?.trim() ? `${c.descriptiveName.trim()} (${pretty})` : pretty,
    secret: JSON.stringify(kept),
  };
}

/** One run: every month-long window from where it got to through today, page by page. */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const s = JSON.parse(job.secret) as Secret;
  const access = await fromRefresh(s, f);
  const until = dayIn(new Date(), s.timezone);
  const through = job.cursors.campaigns?.synced_through?.slice(0, 10);
  let since = through ? addDays(through, -REVISED_DAYS) : addDays(until, -FIRST_DAYS);
  if (since > until) since = until;

  for (let from = since; from <= until; from = addDays(from, WINDOW_DAYS)) {
    const last = addDays(from, WINDOW_DAYS - 1);
    const to = last < until ? last : until;
    const query = `SELECT campaign.id, campaign.name, segments.date, customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'`;
    let pageToken: string | undefined;
    do {
      if (Date.now() > io.deadline) return { nextMinutes: 5 };
      const page = await search(s, access, query, f, pageToken);
      const rows = (page.results ?? []).map(spendRow).filter((r): r is AdSpendRow => r !== null);
      if (rows.length) await io.put("ad_spend", rows);
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
  }
  await io.putCursor("campaigns", null, `${until}T00:00:00.000Z`);
  return { nextMinutes: 60 };
}
