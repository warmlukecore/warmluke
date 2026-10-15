// ─────────────────────────────────────────────────────────────
// Meta's Graph API, as every Meta connector calls it: Meta Ads (0214),
// a store's Facebook Page and Instagram (0215) and its WhatsApp (0216).
//
// The token rides in a header, never in an address. Meta's own error
// codes say whether to wait (rate limits), to ask the owner again (a
// token Meta no longer takes, a grant missing), or that something else
// went wrong (tried again later).
// ─────────────────────────────────────────────────────────────

import { graphApiVersion } from "@/lib/meta-conversions";
import { ConnectorBusy, ConnectorRefused, type Fetch } from "./kit";

const GRAPH = "https://graph.facebook.com";
/** Meta's "slow down", by app, user, page or ad account. */
const BUSY = new Set([4, 17, 32, 613, 80000, 80001, 80003, 80004, 80014]);
/** Meta's "this token may not see that": a grant missing, not a fault of ours. */
const NOT_ALLOWED = new Set([10, 200, 270, 294]);

/**
 * One call. `missing` is what to tell the owner when the token may not
 * see what was asked for: which asset to give the system user.
 */
export async function graph(
  path: string,
  token: string,
  f: Fetch,
  params: Record<string, string> = {},
  missing = "give the system user what this needs",
  method: "GET" | "POST" = "GET"
): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}/${graphApiVersion()}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await f(url.toString(), { method, headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (res.ok && !body.error) return body;
  const code = body.error?.code;
  const said = body.error?.message?.trim();
  if (res.status === 429 || (code !== undefined && BUSY.has(code))) throw new ConnectorBusy("Meta asked us to wait.");
  if (code === 190) throw new ConnectorRefused("Meta no longer accepts this token. Make a new one and connect again.");
  if ((code !== undefined && NOT_ALLOWED.has(code)) || (code === 100 && body.error?.error_subcode === 33)) {
    throw new ConnectorRefused(
      `This token cannot read that. In Meta Business settings, ${missing}, then make the token again.`
    );
  }
  throw new Error(`Meta answered ${res.status}${said ? `: ${said}` : ""}.`);
}

/** A number Meta sent as a string, or null. */
export const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
