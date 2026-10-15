// ─────────────────────────────────────────────────────────────
// WhatsApp Business: each message template's sends, deliveries, reads
// and button clicks, by day — COD confirmations, order updates, offers
// (0216; docs/integrations/connectors.md, phase 8).
//
// Reached as the store's other Meta accounts are: a system user's token
// from its own business, given the WhatsApp Business account. Connecting
// turns on template insights for that account, which is how WhatsApp
// shares these counts (and all it shares: messages themselves are not
// readable after the fact).
//
// What a sync reads: the account's templates, then their daily analytics
// ten templates a call, from three days before where the last run ended;
// WhatsApp keeps 90 days.
// ─────────────────────────────────────────────────────────────

import { graph, num } from "./meta-graph";
import { addDays, ConnectorRefused, type Fetch, type Job, type MessageStatRow, type SyncIO } from "./kit";

const FIRST_DAYS = 89;
const REVISED_DAYS = 3;
const GIVE_WABA = "give the system user your WhatsApp Business account (with whatsapp_business_management)";

export type Secret = { token: string; waba: string };

type Template = { id?: string; name?: string; category?: string; language?: string; status?: string };
type Point = {
  template_id?: string;
  start?: number;
  sent?: number;
  delivered?: number;
  read?: number;
  clicked?: Array<{ count?: number }>;
};

/**
 * The day a point is for. With use_waba_timezone, a point starts at the
 * account's own midnight; twelve hours on is the same calendar day in
 * UTC for any zone between UTC−12 and UTC+12, India's included.
 */
export const dayOf = (start: number) => new Date((start + 12 * 3600) * 1000).toISOString().slice(0, 10);

/** One template's day as message_stats keeps it. */
export function statRow(p: Point, t: Template | undefined): MessageStatRow | null {
  if (!p.template_id || typeof p.start !== "number") return null;
  return {
    template_ref: p.template_id,
    template_name: t?.name ?? null,
    category: t?.category?.toLowerCase() ?? null,
    language: t?.language ?? null,
    day: dayOf(p.start),
    sent: num(p.sent),
    delivered: num(p.delivered),
    read: num(p.read),
    clicked: (p.clicked ?? []).reduce((n, c) => n + (num(c.count) ?? 0), 0),
  };
}

/** Proves the token can read the account, and turns its template insights on. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const token = (fields.token ?? "").trim();
  const waba = (fields.waba_id ?? "").trim();
  if (!token || !/^\d{5,25}$/.test(waba)) {
    throw new ConnectorRefused(
      "WhatsApp needs a system user's access token and the WhatsApp Business account ID (digits, in WhatsApp Manager → Account tools)."
    );
  }
  const found = (await graph(waba, token, f, { fields: "name" }, GIVE_WABA)) as { name?: string };
  await graph(waba, token, f, { is_enabled_for_insights: "true" }, GIVE_WABA, "POST");
  return { accountRef: waba, accountLabel: found.name?.trim() || waba, secret: JSON.stringify({ token, waba }) };
}

/** One run: every template's days from where the last run ended. */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const s = JSON.parse(job.secret) as Secret;
  const templates: Template[] = [];
  let after: string | undefined;
  do {
    if (Date.now() > io.deadline) return { nextMinutes: 5 };
    const page = (await graph(
      `${s.waba}/message_templates`,
      s.token,
      f,
      { fields: "id,name,category,language,status", limit: "100", ...(after ? { after } : {}) },
      GIVE_WABA
    )) as { data?: Template[]; paging?: { cursors?: { after?: string }; next?: string } };
    templates.push(...(page.data ?? []).filter((t) => t.id));
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
  } while (after);

  const today = new Date().toISOString().slice(0, 10);
  const through = job.cursors.templates?.synced_through?.slice(0, 10);
  const since = through ? addDays(through, -REVISED_DAYS) : addDays(today, -FIRST_DAYS);
  const start = String(Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000));
  const end = String(Math.floor(Date.now() / 1000));
  const byId = new Map(templates.map((t) => [t.id, t]));
  for (let i = 0; i < templates.length; i += 10) {
    if (Date.now() > io.deadline) return { nextMinutes: 5 };
    const ids = templates.slice(i, i + 10).map((t) => t.id);
    const page = (await graph(
      `${s.waba}/template_analytics`,
      s.token,
      f,
      {
        start,
        end,
        granularity: "DAILY",
        metric_types: JSON.stringify(["SENT", "DELIVERED", "READ", "CLICKED"]),
        template_ids: JSON.stringify(ids),
        use_waba_timezone: "true",
      },
      GIVE_WABA
    )) as { data?: Array<{ data_points?: Point[] }> };
    const rows = (page.data ?? [])
      .flatMap((d) => d.data_points ?? [])
      .map((p) => statRow(p, byId.get(p.template_id)))
      .filter((r): r is MessageStatRow => r !== null);
    if (rows.length) await io.put("message_stats", rows);
  }
  await io.putCursor("templates", null, `${today}T00:00:00.000Z`);
  return { nextMinutes: 180 };
}
