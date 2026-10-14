// ─────────────────────────────────────────────────────────────
// HubSpot: the store's CRM contacts, each on the Shopify customer it is
// when the email or phone matches (0215; docs/integrations/connectors.md,
// phase 7).
//
// Reached with a private app's access token (Settings → Integrations →
// Private apps, scope crm.objects.contacts.read).
//
// What a sync reads: contacts changed since the last run, oldest change
// first, through the CRM search (100 a page). HubSpot's search stops at
// 10,000 results for one query, so a longer walk starts a fresh query
// from the last change it saw. The first run reads every contact.
// ─────────────────────────────────────────────────────────────

import { ConnectorBusy, ConnectorRefused, type CrmContactRow, type Fetch, type Job, type SyncIO } from "./kit";

const HUBSPOT = "https://api.hubapi.com";
const PAGE = 100;
/** HubSpot's search answers at most this many results for one query. */
const SEARCH_CAP = 10_000;
const PROPS = [
  "email",
  "firstname",
  "lastname",
  "phone",
  "mobilephone",
  "lifecyclestage",
  "hs_lead_status",
  "createdate",
  "lastmodifieddate",
];

export type Secret = { token: string; portal?: number | null; ui_domain?: string | null };

type Contact = { id?: string; properties?: Record<string, string | null | undefined> };

/** One contact as crm_contacts keeps it. */
export function contactRow(c: Contact, portal?: number | null, uiDomain?: string | null): CrmContactRow | null {
  if (!c.id) return null;
  const p = c.properties ?? {};
  const name = [p.firstname, p.lastname]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(" ");
  return {
    contact_ref: c.id,
    name: name || null,
    email: p.email?.trim() || null,
    phone: p.phone?.trim() || p.mobilephone?.trim() || null,
    lifecycle_stage: p.lifecyclestage?.trim() || null,
    lead_status: p.hs_lead_status?.trim() || null,
    added_at: p.createdate || null,
    changed_at: p.lastmodifieddate || null,
    url: portal ? `https://${uiDomain || "app.hubspot.com"}/contacts/${portal}/record/0-1/${c.id}` : null,
  };
}

async function call(token: string, path: string, f: Fetch, body?: unknown): Promise<Record<string, unknown>> {
  const res = await f(`${HUBSPOT}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown> & { message?: string };
  if (res.ok) return out;
  if (res.status === 429) throw new ConnectorBusy("HubSpot asked us to wait.");
  if (res.status === 401) {
    throw new ConnectorRefused("HubSpot refused this access token: make a new one in Private apps.");
  }
  if (res.status === 403) {
    throw new ConnectorRefused("This private app cannot read contacts: give it the crm.objects.contacts.read scope.");
  }
  throw new Error(`HubSpot answered ${res.status}${out.message ? `: ${out.message}` : ""}.`);
}

/** Proves the token can read contacts and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const token = (fields.token ?? "").trim();
  if (!token) throw new ConnectorRefused("HubSpot needs a private app's access token.");
  await call(token, "/crm/v3/objects/contacts?limit=1", f);
  // The account's id and address name the contacts' links; a token without that grant still connects.
  const me = (await call(token, "/account-info/v3/details", f).catch(() => ({}))) as {
    portalId?: number;
    uiDomain?: string;
  };
  const secret: Secret = { token, portal: me.portalId ?? null, ui_domain: me.uiDomain ?? null };
  return {
    accountRef: me.portalId ? String(me.portalId) : "hubspot",
    accountLabel: me.portalId ? `HubSpot account ${me.portalId}` : "HubSpot",
    secret: JSON.stringify(secret),
  };
}

/** One run: contacts changed since the last change it saw, oldest first. */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const s = JSON.parse(job.secret) as Secret;
  let since = job.cursors.contacts?.synced_through ?? null;
  for (;;) {
    let after: string | undefined;
    let seen = 0;
    let latest = since;
    do {
      if (Date.now() > io.deadline) {
        if (latest) await io.putCursor("contacts", null, latest);
        return { nextMinutes: 5 };
      }
      const page = (await call(s.token, "/crm/v3/objects/contacts/search", f, {
        filterGroups: since
          ? [{ filters: [{ propertyName: "lastmodifieddate", operator: "GTE", value: String(Date.parse(since)) }] }]
          : [],
        sorts: [{ propertyName: "lastmodifieddate", direction: "ASCENDING" }],
        properties: PROPS,
        limit: PAGE,
        ...(after ? { after } : {}),
      })) as { results?: Contact[]; paging?: { next?: { after?: string } } };
      const results = page.results ?? [];
      const rows = results
        .map((c) => contactRow(c, s.portal, s.ui_domain))
        .filter((r): r is CrmContactRow => r !== null);
      if (rows.length) await io.put("crm_contacts", rows);
      latest = results.at(-1)?.properties?.lastmodifieddate ?? latest;
      seen += results.length;
      after = page.paging?.next?.after;
    } while (after && seen + PAGE <= SEARCH_CAP);
    if (!after) {
      await io.putCursor("contacts", null, latest ?? new Date().toISOString());
      return { nextMinutes: 60 };
    }
    // One query's ten thousand: the next starts at the last change seen,
    // or just past it when ten thousand share that moment (a bulk import).
    since = latest === since && latest ? new Date(Date.parse(latest) + 1).toISOString() : latest;
    if (since) await io.putCursor("contacts", null, since);
  }
}
