// ─────────────────────────────────────────────────────────────
// Meta Ads: what each campaign spent and what Meta says it brought in,
// by day (docs/integrations/connectors.md, phase 4, 14 Oct).
//
// Reached with a token from the store's own Meta business: a system
// user's, given the ad account in Business settings. A business's own
// app reading its own ad account needs only the access every app has
// (Meta's Marketing API authorization docs, 14 Oct), so this waits on
// no review of Warmluke's. When Warmluke's app passes review, connecting
// becomes "Continue with Facebook"; what is pulled and kept stays as is.
//
// What a sync reads: the account's insights at campaign level, one row
// per campaign and day (time_increment=1), a month at a time. Meta
// revises the last few days, so each run starts again three days before
// where the last one finished.
//
// Purchases are Meta's own count (omni_purchase: web, app and offline
// together), kept apart from the store's orders.
// ─────────────────────────────────────────────────────────────

import { graph, num } from "./meta-graph";
import { addDays, dayIn, type AdSpendRow, type Fetch, type Job, type SyncIO, ConnectorRefused } from "./kit";

/** The first run reads this far back; Meta keeps 37 months. */
const FIRST_DAYS = 90;
/** Meta revises recent days; each run reads these again. */
const REVISED_DAYS = 3;
/** Days per request: a short window keeps a big account's answer small. */
const WINDOW_DAYS = 30;
const PAGE = 500;
/** The purchase actions, in order: they overlap, so the first one present is the count. */
const PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
/** What a token missing the ad account must be given. */
const GIVE_ACCOUNT = "give the system user the ad account (view performance)";

export type Secret = { token: string; account: string; timezone?: string | null };

type Action = { action_type?: string; value?: string | number };
export type Insight = {
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  spend?: string | number;
  impressions?: string | number;
  clicks?: string | number;
  account_currency?: string;
  actions?: Action[];
  action_values?: Action[];
};

/** "act_123", "123" or "act 123" → "act_123"; anything else is not an ad account. */
export function adAccountId(raw: string): string | null {
  const digits = raw.trim().replace(/^act[_\s-]*/i, "");
  return /^\d{5,25}$/.test(digits) ? `act_${digits}` : null;
}

/** Meta's count of one kind of purchase, or 0 when it saw none. */
function purchasesIn(list: Action[] | undefined): number {
  for (const type of PURCHASE) {
    const hit = list?.find((a) => a.action_type === type);
    if (hit) return num(hit.value) ?? 0;
  }
  return 0;
}

/** One insights row as ad_spend keeps it, or null for a row without a campaign or day. */
export function spendRow(r: Insight): AdSpendRow | null {
  if (!r.campaign_id || !/^\d{4}-\d{2}-\d{2}$/.test(r.date_start ?? "")) return null;
  return {
    campaign_id: String(r.campaign_id),
    campaign_name: r.campaign_name?.trim() || null,
    day: r.date_start as string,
    spend: num(r.spend) ?? 0,
    currency: r.account_currency?.trim() || null,
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    purchases: purchasesIn(r.actions),
    purchase_value: purchasesIn(r.action_values),
  };
}

/** Proves a token can read the ad account and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const token = (fields.token ?? "").trim();
  const account = adAccountId(fields.ad_account ?? "");
  if (!token || !account) {
    throw new ConnectorRefused(
      "Meta needs an access token and the ad account's ID (act_ and its number, in Ads Manager)."
    );
  }
  const found = (await graph(account, token, f, { fields: "name,currency,timezone_name" }, GIVE_ACCOUNT)) as {
    name?: string;
    timezone_name?: string;
  };
  const secret: Secret = { token, account, timezone: found.timezone_name ?? null };
  return {
    accountRef: account,
    accountLabel: found.name?.trim() ? `${found.name.trim()} (${account})` : account,
    secret: JSON.stringify(secret),
  };
}

/**
 * One run of a store's sync: every window from where it got to through
 * today, page by page, before the deadline. Returns minutes to the next.
 *
 * ponytail: a run cut short by the deadline starts its windows again next
 * time (rows are written over, so nothing doubles); keep a window cursor
 * if an account's first 90 days ever take longer than one run.
 */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const secret = JSON.parse(job.secret) as Secret;
  const until = dayIn(new Date(), secret.timezone);
  const through = job.cursors.insights?.synced_through?.slice(0, 10);
  let since = through ? addDays(through, -REVISED_DAYS) : addDays(until, -FIRST_DAYS);
  if (since > until) since = until;

  for (let from = since; from <= until; from = addDays(from, WINDOW_DAYS)) {
    const last = addDays(from, WINDOW_DAYS - 1);
    const to = last < until ? last : until;
    let after: string | null = null;
    do {
      if (Date.now() > io.deadline) return { nextMinutes: 5 };
      const params: Record<string, string> = {
        level: "campaign",
        time_increment: "1",
        time_range: JSON.stringify({ since: from, until: to }),
        fields: "campaign_id,campaign_name,date_start,spend,impressions,clicks,actions,action_values,account_currency",
        limit: String(PAGE),
      };
      if (after) params.after = after;
      const page = (await graph(`${secret.account}/insights`, secret.token, f, params, GIVE_ACCOUNT)) as {
        data?: Insight[];
        paging?: { cursors?: { after?: string }; next?: string };
      };
      const rows = (page.data ?? []).map(spendRow).filter((r): r is AdSpendRow => r !== null);
      if (rows.length) await io.put("ad_spend", rows);
      after = page.paging?.next ? (page.paging.cursors?.after ?? null) : null;
    } while (after);
  }
  await io.putCursor("insights", null, `${until}T00:00:00.000Z`);
  return { nextMinutes: 60 };
}
