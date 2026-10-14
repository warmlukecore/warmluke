// ─────────────────────────────────────────────────────────────
// Zendesk: the store's support tickets, each on the customer who raised
// it when their email or phone matches a Shopify customer (0215;
// docs/integrations/connectors.md, phase 7).
//
// Reached with an agent's email and an API token (Admin Center → Apps
// and integrations → Zendesk API), on the account's subdomain.
//
// What a sync reads: the incremental ticket export by cursor, with the
// requesters sideloaded, from where the last run stopped; the first run
// starts 90 days back. Each page's cursor is kept as it lands, so a run
// stopped by Zendesk's limit (ten exports a minute) carries on there.
// ─────────────────────────────────────────────────────────────

import { ConnectorBusy, ConnectorRefused, type Fetch, type Job, type SupportTicketRow, type SyncIO } from "./kit";

const FIRST_DAYS = 90;

export type Secret = { subdomain: string; email: string; api_token: string };

/** "acme", "acme.zendesk.com" or "https://acme.zendesk.com/agent" → "acme". */
export function subdomainOf(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0];
  const sub = host.endsWith(".zendesk.com") ? host.slice(0, -".zendesk.com".length) : host;
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(sub) ? sub : null;
}

type User = { id?: number; name?: string; email?: string; phone?: string | null };
type Ticket = {
  id?: number;
  subject?: string;
  status?: string;
  priority?: string | null;
  via?: { channel?: string };
  requester_id?: number;
  created_at?: string;
  updated_at?: string;
  tags?: string[];
};

/** One ticket as support_tickets keeps it, its requester read from the page's users. */
export function ticketRow(t: Ticket, people: Map<number, User>, subdomain: string): SupportTicketRow | null {
  if (t.id === undefined || t.id === null) return null;
  const who = t.requester_id !== undefined ? people.get(t.requester_id) : undefined;
  return {
    ticket_ref: String(t.id),
    subject: t.subject?.trim() || null,
    status: t.status ?? null,
    priority: t.priority ?? null,
    channel: t.via?.channel ?? null,
    requester_name: who?.name?.trim() || null,
    requester_email: who?.email?.trim() || null,
    requester_phone: who?.phone?.trim() || null,
    opened_at: t.created_at ?? null,
    changed_at: t.updated_at ?? null,
    tags: t.tags ?? [],
    url: `https://${subdomain}.zendesk.com/agent/tickets/${t.id}`,
  };
}

async function call(s: Secret, path: string, f: Fetch): Promise<Record<string, unknown>> {
  const res = await f(`https://${s.subdomain}.zendesk.com${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${s.email}/token:${s.api_token}`).toString("base64")}`,
      Accept: "application/json",
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return body;
  if (res.status === 429) throw new ConnectorBusy("Zendesk asked us to wait.");
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorRefused(
      "Zendesk refused this email and API token: check both, and that API token access is on."
    );
  }
  if (res.status === 404) throw new ConnectorRefused(`There is no Zendesk account at ${s.subdomain}.zendesk.com.`);
  throw new Error(`Zendesk answered ${res.status}.`);
}

/** Proves the login and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const subdomain = subdomainOf(fields.subdomain ?? "");
  const s: Secret = {
    subdomain: subdomain ?? "",
    email: (fields.email ?? "").trim().toLowerCase(),
    api_token: (fields.api_token ?? "").trim(),
  };
  if (!subdomain || !s.email || !s.api_token) {
    throw new ConnectorRefused("Zendesk needs your subdomain (yours.zendesk.com), an agent's email and an API token.");
  }
  const me = (await call(s, "/api/v2/users/me.json", f)) as { user?: { id?: number | null; role?: string } };
  // A login Zendesk does not recognise answers as an anonymous user, not an error.
  if (!me.user?.id || me.user.role === "end-user") {
    throw new ConnectorRefused("Zendesk did not recognise this email and API token as an agent.");
  }
  return {
    accountRef: `${subdomain}.zendesk.com`,
    accountLabel: `${subdomain}.zendesk.com`,
    secret: JSON.stringify(s),
  };
}

/** One run: the export from where it stopped, page by page, until Zendesk says it is caught up. */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const s = JSON.parse(job.secret) as Secret;
  let cursor = job.cursors.tickets?.cursor ?? null;
  for (;;) {
    if (Date.now() > io.deadline) return { nextMinutes: 5 };
    const start = Math.floor((Date.now() - FIRST_DAYS * 86_400_000) / 1000);
    const path = cursor
      ? `/api/v2/incremental/tickets/cursor.json?cursor=${encodeURIComponent(cursor)}&include=users`
      : `/api/v2/incremental/tickets/cursor.json?start_time=${start}&include=users`;
    const page = (await call(s, path, f)) as {
      tickets?: Ticket[];
      users?: User[];
      after_cursor?: string | null;
      end_of_stream?: boolean;
    };
    const people = new Map((page.users ?? []).filter((u) => u.id !== undefined).map((u) => [u.id as number, u]));
    const rows = (page.tickets ?? [])
      .map((t) => ticketRow(t, people, s.subdomain))
      .filter((r): r is SupportTicketRow => r !== null);
    if (rows.length) await io.put("support_tickets", rows);
    cursor = page.after_cursor ?? cursor;
    if (page.end_of_stream) {
      await io.putCursor("tickets", cursor, new Date().toISOString());
      return { nextMinutes: 30 };
    }
    await io.putCursor("tickets", cursor);
  }
}
