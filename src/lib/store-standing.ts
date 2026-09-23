// ─────────────────────────────────────────────────────────────
// How a connected store stands, said once.
//
// The dashboard card and the store switcher both say whether a store
// is working, importing, or needs the merchant; two copies of that
// judgement would drift, and the one that drifts is the one telling a
// merchant their store is fine when it cannot be read. No imports, so
// the checks run it as the pages do.
// ─────────────────────────────────────────────────────────────

export type StoreFacts = {
  status: string;
  token_expires_at?: string | null;
  refresh_token_expires_at?: string | null;
  /** Some resource of its import is not done yet. */
  importing?: boolean;
};

export type Standing = {
  /** ok: working. busy: working on it. warn: needs the merchant. */
  tone: "ok" | "busy" | "warn";
  label: string;
  /** Whether connecting it again is the way out. */
  reconnect: boolean;
};

/**
 * Whether Shopify access has run out for good.
 *
 * The hour-long access token expiring is not a problem — it is renewed
 * on the next call, and it has lapsed on every store nobody has touched
 * since lunch. Only the refresh token running out means nothing can
 * renew anything. A store from before Shopify made tokens expire has
 * neither date and works indefinitely, so only one with an expiry is
 * judged at all.
 */
export function accessRanOut(s: StoreFacts, now: number = Date.now()): boolean {
  return (
    !!s.token_expires_at &&
    (!s.refresh_token_expires_at || Date.parse(s.refresh_token_expires_at) < now)
  );
}

export function storeStanding(s: StoreFacts, now: number = Date.now()): Standing {
  if (s.status === "pending") return { tone: "warn", label: "Shopify never came back", reconnect: true };
  // Shopify said the app was removed from the store (0111).
  if (s.status === "uninstalled") return { tone: "warn", label: "Removed from Shopify", reconnect: true };
  if (s.status !== "connected") return { tone: "warn", label: "Not connected", reconnect: true };
  if (accessRanOut(s, now)) return { tone: "warn", label: "Shopify access ran out", reconnect: true };
  if (s.importing) return { tone: "busy", label: "Importing…", reconnect: false };
  return { tone: "ok", label: "Connected", reconnect: false };
}
