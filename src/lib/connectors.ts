// ─────────────────────────────────────────────────────────────
// Connectors: what a store can connect beside Shopify, declared once
// (docs/integrations/connectors.md, 11 Oct).
//
// Each entry says how its provider is reached, what it brings into the
// store's lists, how often it is pulled, and whether it is ready to
// connect. Settings → Connections draws the list from here; the worker
// and the connect route find each provider's adapter by its id. Nothing
// outside an adapter knows a provider's field names.
//
// Plain data on purpose: the settings screen imports it, so nothing here
// reaches the server's own modules.
// ─────────────────────────────────────────────────────────────

export type ConnectorId = "shiprocket" | "goswift" | "meta_ads" | "google_ads";

/** A field of a login form, as the provider names what it wants. */
export type LoginField = { key: string; label: string; type: "email" | "password" | "text" };

export type Connector = {
  id: ConnectorId;
  label: string;
  kind: "courier" | "ads";
  /** One line: what connecting it gives the store. */
  gives: string;
  /** How it is reached: a login the merchant makes for integrations, or the provider's own sign-in. */
  auth: { kind: "login"; fields: LoginField[]; how: string; where: string } | { kind: "oauth" };
  /** The store lists it writes (STORE_TABLES keys). */
  brings: string[];
  /** Minutes between pulls once it is up to date. */
  every: number;
  /**
   * Whether a store can connect it yet. False says what it waits for:
   * an approval on the provider's side, or API access to ask for.
   */
  ready: true | { waits: string };
};

export const CONNECTORS: Connector[] = [
  {
    id: "shiprocket",
    label: "Shiprocket",
    kind: "courier",
    gives: "Every shipment's courier, AWB and status, matched to its Shopify order.",
    auth: {
      kind: "login",
      // Shiprocket's API is reached with an API user: a separate login made
      // for integrations, not the merchant's own (its docs, 11 Oct).
      fields: [
        { key: "email", label: "API user email", type: "email" },
        { key: "password", label: "API user password", type: "password" },
      ],
      how: "Use an API user, not your own login: in Shiprocket, Settings → API → Add New API User, with an email you do not log in with.",
      where: "https://app.shiprocket.in/api-user",
    },
    brings: ["courier_shipments"],
    every: 30,
    ready: true,
  },
  {
    id: "goswift",
    label: "GoSwift",
    kind: "courier",
    gives: "Shipments and COD remittance from GoSwift.",
    auth: { kind: "oauth" },
    brings: ["courier_shipments"],
    every: 30,
    ready: { waits: "API access from GoSwift" },
  },
  {
    id: "meta_ads",
    label: "Meta Ads",
    kind: "ads",
    gives: "What each campaign spent and brought in, by day.",
    auth: { kind: "oauth" },
    brings: [],
    every: 60,
    ready: { waits: "Meta's app review" },
  },
  {
    id: "google_ads",
    label: "Google Ads",
    kind: "ads",
    gives: "What each campaign spent and brought in, by day.",
    auth: { kind: "oauth" },
    brings: [],
    every: 60,
    ready: { waits: "Google's API approval" },
  },
];

export const connectorById = (id: string): Connector | undefined => CONNECTORS.find((c) => c.id === id);
