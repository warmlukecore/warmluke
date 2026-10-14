// ─────────────────────────────────────────────────────────────
// Brevo (formerly Sendinblue): each email campaign the store sent, with
// its deliveries, opens, clicks and unsubscribes (0215;
// docs/integrations/connectors.md, phase 7).
//
// Reached with an API key (SMTP & API → API keys), sent as the api-key
// header. Brevo keeps no revenue per campaign, so those stay empty.
//
// What a sync reads: sent campaigns with their global statistics, from
// a month before the last run finished (they keep gathering opens), 50
// a page. The first run reads the last six months.
// ─────────────────────────────────────────────────────────────

import { ConnectorBusy, ConnectorRefused, type EmailCampaignRow, type Fetch, type Job, type SyncIO } from "./kit";

const BREVO = "https://api.brevo.com/v3";
const FIRST_DAYS = 180;
const SETTLING_DAYS = 30;
const PAGE = 50;

export type Secret = { api_key: string };

type Campaign = {
  id?: number;
  name?: string;
  subject?: string;
  sentDate?: string;
  statistics?: {
    globalStats?: {
      sent?: number;
      delivered?: number;
      uniqueViews?: number;
      uniqueClicks?: number;
      unsubscriptions?: number;
      hardBounces?: number;
      softBounces?: number;
    };
  };
};

/** One campaign as email_campaigns keeps it. */
export function campaignRow(c: Campaign): EmailCampaignRow | null {
  if (c.id === undefined || c.id === null) return null;
  const g = c.statistics?.globalStats ?? {};
  return {
    campaign_ref: String(c.id),
    name: c.name?.trim() || null,
    subject: c.subject?.trim() || null,
    sent_at: c.sentDate || null,
    sent: g.sent ?? null,
    delivered: g.delivered ?? null,
    opens: g.uniqueViews ?? null,
    clicks: g.uniqueClicks ?? null,
    unsubscribes: g.unsubscriptions ?? null,
    bounces: (g.hardBounces ?? 0) + (g.softBounces ?? 0),
    orders: null,
    revenue: null,
    currency: null,
  };
}

async function call(key: string, path: string, f: Fetch): Promise<Record<string, unknown>> {
  const res = await f(`${BREVO}${path}`, { headers: { "api-key": key, Accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { message?: string };
  if (res.ok) return body;
  if (res.status === 429) throw new ConnectorBusy("Brevo asked us to wait.");
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorRefused(body.message?.toString().trim() || "Brevo refused this API key.");
  }
  throw new Error(`Brevo answered ${res.status}.`);
}

/** Proves the key and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const api_key = (fields.api_key ?? "").trim();
  if (!api_key.startsWith("xkeysib-")) {
    throw new ConnectorRefused("A Brevo API key starts xkeysib-: make one in SMTP & API → API keys.");
  }
  const me = (await call(api_key, "/account", f)) as { email?: string; companyName?: string };
  return {
    accountRef: me.email ?? "brevo",
    accountLabel: me.companyName?.trim() || me.email || "Brevo",
    secret: JSON.stringify({ api_key } satisfies Secret),
  };
}

/** One run: campaigns sent since a month before the last run, a page at a time. */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const { api_key } = JSON.parse(job.secret) as Secret;
  const through = job.cursors.campaigns?.synced_through;
  const startedAt = new Date().toISOString();
  const since = new Date(
    through ? Date.parse(through) - SETTLING_DAYS * 86_400_000 : Date.now() - FIRST_DAYS * 86_400_000
  ).toISOString();
  for (let offset = 0; ; offset += PAGE) {
    if (Date.now() > io.deadline) return { nextMinutes: 5 };
    const q = new URLSearchParams({
      type: "classic",
      status: "sent",
      statistics: "globalStats",
      limit: String(PAGE),
      offset: String(offset),
      startDate: since,
      endDate: startedAt,
      sort: "desc",
      excludeHtmlContent: "true",
    });
    const page = (await call(api_key, `/emailCampaigns?${q}`, f)) as { campaigns?: Campaign[]; count?: number };
    const rows = (page.campaigns ?? []).map(campaignRow).filter((r): r is EmailCampaignRow => r !== null);
    if (rows.length) await io.put("email_campaigns", rows);
    if (offset + PAGE >= (page.count ?? 0) || (page.campaigns ?? []).length === 0) break;
  }
  await io.putCursor("campaigns", null, startedAt);
  return { nextMinutes: 360 };
}
