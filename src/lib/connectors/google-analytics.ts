// ─────────────────────────────────────────────────────────────
// Google Analytics 4: the store's visits, and the purchases and revenue
// GA4 counts, by day and by where the visits came from (0215;
// docs/integrations/connectors.md, phase 7).
//
// Reached with a service account of the merchant's own Google Cloud
// project, added as a Viewer of the GA4 property: its key signs here,
// read-only (analytics.readonly). No approval of ours is needed.
//
// What a sync reads: the Data API's runReport, one row per day, source,
// medium and campaign, 10,000 rows a page. GA4 settles a day over the
// next two, so each run starts again three days before where the last
// one finished.
// ─────────────────────────────────────────────────────────────

import { fromServiceKey, googleError, serviceKey, type ServiceKey } from "./google";
import { addDays, ConnectorRefused, dayIn, type Fetch, type Job, type SyncIO, type WebTrafficRow } from "./kit";

const DATA = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const FIRST_DAYS = 90;
const REVISED_DAYS = 3;
const PAGE = 10_000;

export type Secret = ServiceKey & { property: string; timezone?: string | null; currency?: string | null };

/** "properties/123456789", "123456789" → "123456789". */
export const propertyId = (raw: string): string | null => {
  const digits = raw.trim().replace(/^properties\//, "");
  return /^\d{4,20}$/.test(digits) ? digits : null;
};

type ReportRow = { dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> };
type Report = { rows?: ReportRow[]; rowCount?: number };

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** One report row as web_traffic keeps it: GA4's "20261012" is 2026-10-12. */
export function trafficRow(r: ReportRow, currency: string | null): WebTrafficRow | null {
  const [date, source, medium, campaign] = (r.dimensionValues ?? []).map((d) => d.value ?? "");
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(date ?? "");
  if (!m) return null;
  const [sessions, users, purchases, revenue] = (r.metricValues ?? []).map((v) => num(v.value));
  return {
    day: `${m[1]}-${m[2]}-${m[3]}`,
    source: source ?? "",
    medium: medium ?? "",
    campaign: campaign ?? "",
    sessions: sessions ?? 0,
    users: users ?? 0,
    purchases: purchases ?? 0,
    revenue: revenue ?? 0,
    currency,
  };
}

/** Proves the key can read the property and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const property = propertyId(fields.property_id ?? "");
  const key = serviceKey(fields.service_account ?? "");
  if (!property || !key) {
    throw new ConnectorRefused(
      "Google Analytics needs the property ID (digits, in Admin → Property details) and the service account's key file, pasted whole."
    );
  }
  const access = await fromServiceKey(key, SCOPE, f);
  const res = await f(`${ADMIN}/properties/${property}`, { headers: { Authorization: `Bearer ${access}` } });
  if (!res.ok) {
    await googleError(
      res,
      `This service account cannot read that property: in Google Analytics, Admin → Property access management, add ${key.client_email} as a Viewer.`
    );
  }
  const p = (await res.json()) as { displayName?: string; timeZone?: string; currencyCode?: string };
  const secret: Secret = { ...key, property, timezone: p.timeZone ?? null, currency: p.currencyCode ?? null };
  return {
    accountRef: property,
    accountLabel: p.displayName?.trim() ? `${p.displayName.trim()} (${property})` : property,
    secret: JSON.stringify(secret),
  };
}

/** One run: from where it got to through today, a page at a time. */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const s = JSON.parse(job.secret) as Secret;
  const access = await fromServiceKey(s, SCOPE, f);
  const until = dayIn(new Date(), s.timezone);
  const through = job.cursors.traffic?.synced_through?.slice(0, 10);
  let since = through ? addDays(through, -REVISED_DAYS) : addDays(until, -FIRST_DAYS);
  if (since > until) since = until;

  for (let offset = 0; ; offset += PAGE) {
    if (Date.now() > io.deadline) return { nextMinutes: 5 };
    const res = await f(`${DATA}/properties/${s.property}:runReport`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: since, endDate: until }],
        dimensions: [
          { name: "date" },
          { name: "sessionSource" },
          { name: "sessionMedium" },
          { name: "sessionCampaignName" },
        ],
        metrics: [
          { name: "sessions" },
          { name: "totalUsers" },
          { name: "ecommercePurchases" },
          { name: "purchaseRevenue" },
        ],
        limit: String(PAGE),
        offset: String(offset),
      }),
    });
    if (!res.ok) await googleError(res, "Google Analytics no longer lets this service account read the property.");
    const report = (await res.json()) as Report;
    const rows = (report.rows ?? [])
      .map((r) => trafficRow(r, s.currency ?? null))
      .filter((r): r is WebTrafficRow => r !== null);
    if (rows.length) await io.put("web_traffic", rows);
    if (offset + PAGE >= (report.rowCount ?? 0) || (report.rows ?? []).length === 0) break;
  }
  await io.putCursor("traffic", null, `${until}T00:00:00.000Z`);
  return { nextMinutes: 180 };
}
