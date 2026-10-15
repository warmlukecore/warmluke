// What every adapter in lib/connectors shares (0204, 0205, 0214, 0215):
// how it says a provider refused or asked us to wait, the rows it hands
// back for each list, what the worker gives it to write with, and the
// days it counts in. Nothing here knows a provider.

/** The provider turned the credential down: the owner must connect again. */
export class ConnectorRefused extends Error {}
/** The provider asked us to slow down: come back later, nothing is wrong. */
export class ConnectorBusy extends Error {}

/** A shipment as courier_shipments keeps it (abo_connector_put_shipments). */
export type ShipmentRow = {
  shipment_ref: string;
  awb: string | null;
  order_ref: string | null;
  courier?: string | null;
  status?: string | null;
  status_at?: string | null;
  ndr_reason?: string | null;
  ndr_attempts?: number | null;
  rto?: boolean;
  shipped_at?: string | null;
  delivered_at?: string | null;
  payment_mode?: string | null;
  cod_amount?: number | null;
  track_url?: string | null;
};

/** A campaign's day as ad_spend keeps it (abo_connector_put_ad_spend, 0214). */
export type AdSpendRow = {
  campaign_id: string;
  campaign_name: string | null;
  /** The ad account's own day, YYYY-MM-DD. */
  day: string;
  spend: number;
  currency: string | null;
  impressions: number | null;
  clicks: number | null;
  /** The platform's own count and value of purchases, never the store's orders. */
  purchases: number | null;
  purchase_value: number | null;
};

/** A day and where its visits came from, as web_traffic keeps it (0215). */
export type WebTrafficRow = {
  day: string;
  source: string;
  medium: string;
  campaign: string;
  sessions: number | null;
  users: number | null;
  /** The analytics tool's own count and value, never the store's orders. */
  purchases: number | null;
  revenue: number | null;
  currency: string | null;
};

/** One email send, as email_campaigns keeps it (0215). Opens and clicks are unique people. */
export type EmailCampaignRow = {
  campaign_ref: string;
  name: string | null;
  subject: string | null;
  sent_at: string | null;
  sent: number | null;
  delivered: number | null;
  opens: number | null;
  clicks: number | null;
  unsubscribes: number | null;
  bounces: number | null;
  orders: number | null;
  revenue: number | null;
  currency: string | null;
};

/** A support ticket, as support_tickets keeps it (0215); the database finds its customer. */
export type SupportTicketRow = {
  ticket_ref: string;
  subject: string | null;
  status: string | null;
  priority: string | null;
  channel: string | null;
  requester_name: string | null;
  requester_email: string | null;
  requester_phone: string | null;
  opened_at: string | null;
  changed_at: string | null;
  tags: string[];
  url: string | null;
};

/** A CRM contact, as crm_contacts keeps it (0215); the database finds its customer. */
export type CrmContactRow = {
  contact_ref: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  lifecycle_stage: string | null;
  lead_status: string | null;
  added_at: string | null;
  changed_at: string | null;
  url: string | null;
};

/** A post on the store's own Facebook Page or Instagram, as social_posts keeps it (0215). */
export type SocialPostRow = {
  post_ref: string;
  network: "facebook" | "instagram";
  posted_at: string | null;
  text: string | null;
  kind: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  url: string | null;
};

/** One WhatsApp template's day, as message_stats keeps it (0216). */
export type MessageStatRow = {
  template_ref: string;
  template_name: string | null;
  category: string | null;
  language: string | null;
  day: string;
  sent: number | null;
  delivered: number | null;
  read: number | null;
  clicked: number | null;
};

/** One online payment, as gateway_payments keeps it (0216): money in the store's currency, not paise. */
export type GatewayPaymentRow = {
  payment_ref: string;
  /** The Shopify order it paid for, as the gateway names it; the database finds the order. */
  order_ref: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  method: string | null;
  fee: number | null;
  tax: number | null;
  refunded: number | null;
  email: string | null;
  phone: string | null;
  paid_at: string | null;
};

/** What a gateway paid into the bank, as gateway_settlements keeps it (0216). */
export type GatewaySettlementRow = {
  settlement_ref: string;
  amount: number | null;
  fees: number | null;
  tax: number | null;
  utr: string | null;
  status: string | null;
  settled_at: string | null;
};

/** Each list a connection brings, and its row: written by abo_connector_put_<list>. */
export type ListRows = {
  ad_spend: AdSpendRow;
  web_traffic: WebTrafficRow;
  email_campaigns: EmailCampaignRow;
  support_tickets: SupportTicketRow;
  crm_contacts: CrmContactRow;
  social_posts: SocialPostRow;
  message_stats: MessageStatRow;
  gateway_payments: GatewayPaymentRow;
  gateway_settlements: GatewaySettlementRow;
};

export type Job = {
  secret: string;
  cursors: Record<string, { cursor: string | null; synced_through: string | null }>;
};

export type SyncIO = {
  putShipments(rows: ShipmentRow[]): Promise<void>;
  /** Rows for one of the lists the connection brings, written over what it had. */
  put<L extends keyof ListRows>(list: L, rows: ListRows[L][]): Promise<void>;
  putCursor(resource: string, cursor: string | null, through?: string | null): Promise<void>;
  putSecret(secret: string): Promise<void>;
  /** Stop starting pages after this (ms since epoch); the next run carries on. */
  deadline: number;
  /** Where this provider posts to us, ending in "/": the hook's token follows it. */
  hookBase: string;
  /** The token a provider's deliveries carry in their address, kept hashed (0205). */
  putHook(token: string): Promise<void>;
  /** This connection's shipments not yet settled that have not moved for hours, oldest first. */
  openShipments(settled: string[], limit: number): Promise<string[]>;
  /**
   * The store's own AWBs with this carrier, recent and not yet delivered,
   * least lately asked after first, each with its Shopify order (0216):
   * for a carrier with no list of its client's shipments.
   */
  carrierAwbs(carrier: string, limit: number): Promise<Array<{ awb: string; order_number: string | null }>>;
};

export type Fetch = typeof fetch;

/** A day as YYYY-MM-DD in a timezone (an account's own); UTC when it is unknown. */
export function dayIn(at: Date, timezone?: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** A YYYY-MM-DD day moved by n days. */
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
