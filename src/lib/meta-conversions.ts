// Server-only: imported by the booking action, never by the browser.
import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type MetaLead = {
  eventId: string;
  eventTime: number;
  email: string;
  sourceUrl: string;
  fbp?: string;
  fbc?: string;
  ip?: string;
  userAgent?: string;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cookie = (value: string | undefined) =>
  value && /^fb\.\d+\.\d+\.[A-Za-z0-9_-]+$/.test(value) && value.length <= 512 ? value : undefined;

/** Same submission, same ID; separate visitor sessions cannot collide. */
export function leadEventId(session: string, idem: string): string {
  return `wl_lead_${hash(JSON.stringify([session, idem]))}`;
}

export function leadPayload(lead: MetaLead) {
  return {
    event_name: "Lead",
    event_time: lead.eventTime,
    event_id: lead.eventId,
    action_source: "website",
    event_source_url: lead.sourceUrl,
    user_data: {
      em: [hash(lead.email.trim().toLowerCase())],
      fbp: cookie(lead.fbp),
      fbc: cookie(lead.fbc),
      client_ip_address: lead.ip && isIP(lead.ip) ? lead.ip : undefined,
      client_user_agent: lead.userAgent?.slice(0, 1024) || undefined,
    },
  };
}

/** Bounded retries, same ID/time. A Meta failure never fails a saved booking. */
export async function sendMetaLead(lead: MetaLead): Promise<void> {
  const pixel = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixel || !token) return;
  const version = process.env.META_GRAPH_API_VERSION || "v26.0";
  if (!/^\d+$/.test(pixel) || !/^v\d+\.0$/.test(version)) {
    console.warn("Meta Lead: invalid dataset ID or Graph API version");
    return;
  }
  const body = JSON.stringify({
    data: [leadPayload(lead)],
    ...(process.env.META_CAPI_TEST_EVENT_CODE ? { test_event_code: process.env.META_CAPI_TEST_EVENT_CODE } : {}),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`https://graph.facebook.com/${version}/${pixel}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(5000),
      });
      const result = (await response.json()) as {
        events_received?: number;
        error?: { code?: number; is_transient?: boolean };
      };
      if (response.ok && result.events_received === 1) return;
      const retry = response.status === 429 || response.status >= 500 || result.error?.is_transient;
      if (retry && attempt === 0) continue;
      // No response body, email, token, cookie, or URL in logs.
      console.warn("Meta Lead rejected", { status: response.status, code: result.error?.code });
      return;
    } catch {
      if (attempt === 1) console.warn("Meta Lead delivery failed after two attempts");
    }
  }
}
