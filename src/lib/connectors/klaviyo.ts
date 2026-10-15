// ─────────────────────────────────────────────────────────────
// Klaviyo: each email campaign the store sent, with its deliveries,
// opens, clicks, unsubscribes, and the orders and revenue Klaviyo
// credits it with (0216; docs/integrations/connectors.md, phase 8).
//
// Reached with a private API key (Settings → API keys, read-only is
// enough). Revenue is counted on the account's "Placed Order" metric,
// the one Klaviyo's Shopify integration records, found at connecting.
//
// What a sync reads: the email campaigns changed since a month before
// the last run (opens keep arriving), then one campaign values report
// over the same span — Klaviyo allows reports only a couple of times a
// minute, so it is one report a run, every few hours.
// ─────────────────────────────────────────────────────────────

import { ConnectorBusy, ConnectorRefused, type EmailCampaignRow, type Fetch, type Job, type SyncIO } from "./kit";

const KLAVIYO = "https://a.klaviyo.com/api";
const REVISION = "2026-07-15";
const FIRST_DAYS = 180;
const SETTLING_DAYS = 30;
const STATS = [
  "recipients",
  "delivered",
  "opens_unique",
  "clicks_unique",
  "unsubscribes",
  "bounced",
  "conversions",
  "conversion_value",
];

export type Secret = { api_key: string; metric: string | null; currency?: string | null };

type Resource = {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
};
type Page = { data?: Resource[] | Resource; included?: Resource[]; links?: { next?: string | null } };
type Result = { groupings?: Record<string, string>; statistics?: Record<string, number> };

async function call(key: string, url: string, f: Fetch, body?: unknown): Promise<Page> {
  const res = await f(url.startsWith("http") ? url : `${KLAVIYO}${url}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      revision: REVISION,
      accept: "application/vnd.api+json",
      ...(body ? { "content-type": "application/vnd.api+json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = (await res.json().catch(() => ({}))) as Page & { errors?: Array<{ detail?: string }> };
  if (res.ok) return out;
  if (res.status === 429) throw new ConnectorBusy("Klaviyo asked us to wait.");
  const said = out.errors?.[0]?.detail?.trim();
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorRefused(said || "Klaviyo refused this API key: make a private key in Settings → API keys.");
  }
  throw new Error(`Klaviyo answered ${res.status}${said ? `: ${said}` : ""}.`);
}

const list = (p: Page): Resource[] => (Array.isArray(p.data) ? p.data : p.data ? [p.data] : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The subject of a campaign's message, in either shape Klaviyo has written it. */
function subjectOf(message: Resource | undefined): string | null {
  const a = (message?.attributes ?? {}) as {
    definition?: { content?: { subject?: string } };
    content?: { subject?: string };
  };
  return (a.definition?.content?.subject ?? a.content?.subject ?? "").trim() || null;
}

/** Campaigns and a report's statistics, as email_campaigns keeps them: one row per campaign sent. */
export function campaignRows(
  campaigns: Resource[],
  included: Resource[],
  results: Result[],
  currency: string | null,
  counted: boolean
): EmailCampaignRow[] {
  // A report answers per message; a campaign is the sum of its messages.
  const stats = new Map<string, Record<string, number>>();
  for (const r of results) {
    const id = r.groupings?.campaign_id;
    if (!id) continue;
    const sum = stats.get(id) ?? {};
    for (const [k, v] of Object.entries(r.statistics ?? {})) sum[k] = (sum[k] ?? 0) + (num(v) ?? 0);
    stats.set(id, sum);
  }
  const messages = new Map(included.filter((r) => r.type === "campaign-message").map((m) => [m.id, m]));
  return campaigns
    .filter((c) => c.id && typeof c.attributes?.send_time === "string")
    .map((c) => {
      const s = stats.get(c.id as string) ?? {};
      const rel = (c.relationships?.["campaign-messages"] as { data?: Array<{ id?: string }> } | undefined)?.data ?? [];
      return {
        campaign_ref: c.id as string,
        name: String(c.attributes?.name ?? "").trim() || null,
        subject: subjectOf(messages.get(rel[0]?.id)),
        sent_at: c.attributes?.send_time as string,
        sent: s.recipients ?? null,
        delivered: s.delivered ?? null,
        opens: s.opens_unique ?? null,
        clicks: s.clicks_unique ?? null,
        unsubscribes: s.unsubscribes ?? null,
        bounces: s.bounced ?? null,
        // Without a "Placed Order" metric, Klaviyo's counts are of something else.
        orders: counted ? (s.conversions ?? null) : null,
        revenue: counted ? (s.conversion_value ?? null) : null,
        currency,
      };
    });
}

/** Proves the key and finds the metric revenue is counted on. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const api_key = (fields.api_key ?? "").trim();
  if (!api_key.startsWith("pk_")) {
    throw new ConnectorRefused("A Klaviyo private API key starts pk_: make one in Settings → API keys.");
  }
  const account = list(await call(api_key, "/accounts/", f))[0];
  const info = (account?.attributes ?? {}) as {
    contact_information?: { organization_name?: string };
    preferred_currency?: string;
  };
  let metric: string | null = null;
  for (let url: string | null | undefined = "/metrics/"; url && !metric;) {
    const page = await call(api_key, url, f);
    metric = list(page).find((m) => m.attributes?.name === "Placed Order")?.id ?? null;
    url = page.links?.next;
  }
  const name = info.contact_information?.organization_name?.trim();
  return {
    accountRef: account?.id ?? "klaviyo",
    accountLabel: name || "Klaviyo",
    secret: JSON.stringify({ api_key, metric, currency: info.preferred_currency ?? null } satisfies Secret),
  };
}

/** One run: the campaigns changed in the span, and one report over it. */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const s = JSON.parse(job.secret) as Secret;
  const through = job.cursors.campaigns?.synced_through;
  const end = new Date();
  const start = new Date(
    through ? Date.parse(through) - SETTLING_DAYS * 86_400_000 : end.getTime() - FIRST_DAYS * 86_400_000
  );
  const campaigns: Resource[] = [];
  const included: Resource[] = [];
  const filter = `and(equals(messages.channel,'email'),greater-or-equal(updated_at,${start.toISOString()}))`;
  let url: string | null | undefined = `/campaigns/?filter=${encodeURIComponent(filter)}&include=campaign-messages`;
  while (url) {
    if (Date.now() > io.deadline) return { nextMinutes: 5 };
    const page: Page = await call(s.api_key, url, f);
    campaigns.push(...list(page));
    included.push(...(page.included ?? []));
    url = page.links?.next;
  }
  if (campaigns.length === 0) {
    await io.putCursor("campaigns", null, end.toISOString());
    return { nextMinutes: 360 };
  }
  // ponytail: a report needs some conversion metric; with no "Placed Order" the
  // first metric stands in and its counts are left out of the rows.
  const metric = s.metric ?? list(await call(s.api_key, "/metrics/", f))[0]?.id;
  const report = await call(s.api_key, "/campaign-values-reports/", f, {
    data: {
      type: "campaign-values-report",
      attributes: {
        statistics: STATS,
        timeframe: { start: start.toISOString(), end: end.toISOString() },
        conversion_metric_id: metric,
      },
    },
  });
  const results = ((report.data as Resource | undefined)?.attributes?.results ?? []) as Result[];
  const rows = campaignRows(campaigns, included, results, s.currency ?? null, !!s.metric);
  if (rows.length) await io.put("email_campaigns", rows);
  await io.putCursor("campaigns", null, end.toISOString());
  return { nextMinutes: 360 };
}
