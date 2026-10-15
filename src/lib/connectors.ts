// ─────────────────────────────────────────────────────────────
// Connectors: what a store can connect beside Shopify, declared once
// (docs/integrations/connectors.md, 11 Oct; 0214, 0215).
//
// Each entry says how its provider is reached, what it brings into the
// store's lists, how often it is pulled, its mark, and whether it is
// ready to connect. Settings → Connections draws the list from here,
// grouped by KINDS; the worker and the connect route find each
// provider's adapter by its id. Nothing outside an adapter knows a
// provider's field names.
//
// Every one is reached with the merchant's own credential (an API user,
// a key, a token their own business makes), so none waits on a review
// of Warmluke's own app.
//
// Plain data on purpose: the settings screen imports it, so nothing here
// reaches the server's own modules.
// ─────────────────────────────────────────────────────────────

export type ConnectorId =
  | "shiprocket"
  | "goswift"
  | "meta_ads"
  | "google_ads"
  | "google_analytics"
  | "mailchimp"
  | "brevo"
  | "zendesk"
  | "hubspot"
  | "meta_social"
  | "klaviyo"
  | "whatsapp"
  | "razorpay"
  | "delhivery";

export type ConnectorKind =
  | "courier"
  | "ads"
  | "analytics"
  | "email"
  | "messaging"
  | "payments"
  | "support"
  | "crm"
  | "social";

/** Each kind's group in Settings → Connections, in the order they show. */
export const KINDS: Array<{ kind: ConnectorKind; title: string; description: string }> = [
  {
    kind: "courier",
    title: "Couriers",
    description: "Where each parcel is, matched to its Shopify order, for Luke, your sections and your own AI.",
  },
  { kind: "ads", title: "Ads", description: "What your campaigns spent, beside the orders they brought." },
  { kind: "analytics", title: "Analytics", description: "Your store's visits, and where they came from." },
  { kind: "email", title: "Email", description: "What each email campaign was opened, clicked and sold." },
  { kind: "messaging", title: "Messaging", description: "What your WhatsApp messages reached, and who read them." },
  {
    kind: "payments",
    title: "Payments",
    description: "What customers paid online, on their orders, and what reached your bank.",
  },
  { kind: "support", title: "Support", description: "Your customers' tickets, on the customer who raised them." },
  { kind: "crm", title: "CRM", description: "Your contacts, and which of them are already customers." },
  { kind: "social", title: "Social", description: "Your own posts, and how people took to them." },
];

/** A field of a login form, as the provider names what it wants. */
export type LoginField = {
  key: string;
  label: string;
  /** "textarea" for something pasted whole, like a key file. */
  type: "email" | "password" | "text" | "textarea";
  optional?: boolean;
};

export type Connector = {
  id: ConnectorId;
  label: string;
  kind: ConnectorKind;
  /** The provider's own mark, unaltered (public/logos), shown on the logo tile. */
  logo: { src: string };
  /** One line: what connecting it gives the store. */
  gives: string;
  /** How it is reached: a login the merchant makes for integrations, or the provider's own sign-in. */
  auth: { kind: "login"; fields: LoginField[]; how: string; where: string } | { kind: "oauth" };
  /** The store lists it writes (STORE_TABLES keys). */
  brings: string[];
  /** What a row of it is, said in Settings: "synced 5 min ago · 412 shipments". */
  brought: { one: string; many: string; arriving: string };
  /** Minutes between pulls once it is up to date. */
  every: number;
  /**
   * Whether a store can connect it yet. False says what it waits for:
   * an approval on the provider's side, or API access to ask for.
   */
  ready: true | { waits: string };
};

const SPEND = { one: "campaign day", many: "campaign days", arriving: "bringing its spend in" };
const SENDS = { one: "campaign", many: "campaigns", arriving: "bringing its campaigns in" };

export const CONNECTORS: Connector[] = [
  {
    id: "shiprocket",
    label: "Shiprocket",
    kind: "courier",
    logo: { src: "/logos/shiprocket.png" },
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
    brought: { one: "shipment", many: "shipments", arriving: "bringing its shipments in" },
    every: 30,
    ready: true,
  },
  {
    id: "goswift",
    label: "GoSwift",
    kind: "courier",
    logo: { src: "/logos/goswift.png" },
    gives: "Every shipment's courier, AWB and status as it moves, matched to its Shopify order.",
    auth: {
      kind: "login",
      // GoSwift gives API access on request: a client ID and a login for it
      // (its API docs, v3.8.8, 11 Oct). Shipments then come to us as they move.
      fields: [
        { key: "client_id", label: "Client ID", type: "text" },
        { key: "username", label: "API username", type: "text" },
        { key: "password", label: "API password", type: "password" },
      ],
      how: "GoSwift gives these on request: write to tech-integrations@goswift.in for API access to your account. Shipments show here from the day you connect, and older ones as they next move.",
      where: "https://app.goswift.in",
    },
    brings: ["courier_shipments"],
    brought: { one: "shipment", many: "shipments", arriving: "bringing its shipments in" },
    every: 30,
    ready: true,
  },
  {
    id: "delhivery",
    label: "Delhivery",
    kind: "courier",
    logo: { src: "/logos/delhivery.png" },
    gives: "Every Delhivery parcel's status, NDR and RTO, on its Shopify order.",
    auth: {
      kind: "login",
      // Delhivery has no list of a client's shipments: the AWBs on the store's
      // own Shopify fulfilments are tracked (lib/connectors/delhivery).
      fields: [{ key: "token", label: "API token", type: "password" }],
      how: "In Delhivery One, Settings → API setup: copy your API token. A parcel shows here once Shopify has its AWB on a fulfilment with Delhivery as the carrier.",
      where: "https://one.delhivery.com",
    },
    brings: ["courier_shipments"],
    brought: { one: "shipment", many: "shipments", arriving: "bringing its shipments in" },
    every: 60,
    ready: true,
  },
  {
    id: "meta_ads",
    label: "Meta Ads",
    kind: "ads",
    logo: { src: "/logos/meta.svg" },
    gives: "What each campaign spent and what Meta says it brought in, by day.",
    auth: {
      kind: "login",
      // A system user's token from the store's own business: its own app
      // reads its own ad account without Warmluke's app review (lib/connectors/meta-ads).
      fields: [
        { key: "token", label: "System user access token", type: "password" },
        { key: "ad_account", label: "Ad account ID", type: "text" },
      ],
      how: "Use a token from your business, not your own login. In Meta Business settings → Users → System users: add one, give it your ad account (View performance), then Generate token with ads_read and no expiry (your business needs an app for this; make one at developers.facebook.com if it has none). The ad account ID is in Ads Manager, act_ and a number.",
      where: "https://business.facebook.com/settings/system-users",
    },
    brings: ["ad_spend"],
    brought: SPEND,
    every: 60,
    ready: true,
  },
  {
    id: "google_ads",
    label: "Google Ads",
    kind: "ads",
    logo: { src: "/logos/googleads.svg" },
    gives: "What each campaign spent and the conversions Google counts, by day.",
    auth: {
      kind: "login",
      // The merchant's own API access: a developer token from their manager
      // account, an OAuth client and its refresh token (lib/connectors/google-ads).
      fields: [
        { key: "customer_id", label: "Ad account ID", type: "text" },
        { key: "developer_token", label: "Developer token", type: "password" },
        { key: "client_id", label: "OAuth client ID", type: "text" },
        { key: "client_secret", label: "OAuth client secret", type: "password" },
        { key: "refresh_token", label: "Refresh token", type: "password" },
        {
          key: "login_customer_id",
          label: "Manager account ID (if you sign in through one)",
          type: "text",
          optional: true,
        },
      ],
      how: "This uses your own Google Ads API access, usually set up by whoever runs your ads. The developer token is in your manager account under Tools → API Center; the OAuth client is made in Google Cloud, and the refresh token with it. The ad account ID is the ten digits at the top of Google Ads.",
      where: "https://ads.google.com/aw/apicenter",
    },
    brings: ["ad_spend"],
    brought: SPEND,
    every: 60,
    ready: true,
  },
  {
    id: "google_analytics",
    label: "Google Analytics",
    kind: "analytics",
    logo: { src: "/logos/googleanalytics.svg" },
    gives: "Visits, purchases and revenue by day, and where the visits came from.",
    auth: {
      kind: "login",
      // A service account of the merchant's own, added as a Viewer of the
      // property: read-only, nothing for Google to review (lib/connectors/google-analytics).
      fields: [
        { key: "property_id", label: "Property ID", type: "text" },
        { key: "service_account", label: "Service account key (the JSON file, pasted whole)", type: "textarea" },
      ],
      how: "In Google Cloud, make a service account and a JSON key for it, and turn on the Google Analytics Data API. Then in Google Analytics, Admin → Property access management, add the service account's email as a Viewer. The property ID is in Admin → Property details.",
      where: "https://analytics.google.com/analytics/web/",
    },
    brings: ["web_traffic"],
    brought: { one: "day of visits", many: "rows of visits", arriving: "bringing its visits in" },
    every: 180,
    ready: true,
  },
  {
    id: "mailchimp",
    label: "Mailchimp",
    kind: "email",
    logo: { src: "/logos/mailchimp.svg" },
    gives: "Each campaign's opens, clicks, unsubscribes, and the orders and revenue Mailchimp credits it.",
    auth: {
      kind: "login",
      fields: [{ key: "api_key", label: "API key", type: "password" }],
      how: "In Mailchimp, Profile → Extras → API keys → Create A Key. It ends with your data centre, like -us21.",
      where: "https://admin.mailchimp.com/account/api/",
    },
    brings: ["email_campaigns"],
    brought: SENDS,
    every: 360,
    ready: true,
  },
  {
    id: "brevo",
    label: "Brevo",
    kind: "email",
    logo: { src: "/logos/brevo.svg" },
    gives: "Each campaign's deliveries, opens, clicks and unsubscribes.",
    auth: {
      kind: "login",
      fields: [{ key: "api_key", label: "API key", type: "password" }],
      how: "In Brevo, SMTP & API → API keys → Generate a new API key. It starts with xkeysib-.",
      where: "https://app.brevo.com/settings/keys/api",
    },
    brings: ["email_campaigns"],
    brought: SENDS,
    every: 360,
    ready: true,
  },
  {
    id: "klaviyo",
    label: "Klaviyo",
    kind: "email",
    logo: { src: "/logos/klaviyo.png" },
    gives: "Each campaign's opens, clicks, unsubscribes, and the orders and revenue Klaviyo credits it.",
    auth: {
      kind: "login",
      fields: [{ key: "api_key", label: "Private API key", type: "password" }],
      how: "In Klaviyo, Settings → API keys → Create Private API Key, read-only. It starts with pk_.",
      where: "https://www.klaviyo.com/settings/account/api-keys",
    },
    brings: ["email_campaigns"],
    brought: SENDS,
    every: 360,
    ready: true,
  },
  {
    id: "whatsapp",
    label: "WhatsApp Business",
    kind: "messaging",
    logo: { src: "/logos/whatsapp.svg" },
    gives: "Each message template's sends, deliveries, reads and clicks, by day.",
    auth: {
      kind: "login",
      // A system user's token, as Meta Ads (lib/connectors/whatsapp).
      fields: [
        { key: "token", label: "System user access token", type: "password" },
        { key: "waba_id", label: "WhatsApp Business account ID", type: "text" },
      ],
      how: "In Meta Business settings → Users → System users: give a system user your WhatsApp account, then Generate token with whatsapp_business_management and no expiry. The account ID is in WhatsApp Manager → Account tools. Connecting turns on template insights, which is how WhatsApp shares these counts.",
      where: "https://business.facebook.com/wa/manage/home/",
    },
    brings: ["message_stats"],
    brought: { one: "template day", many: "template days", arriving: "bringing its message counts in" },
    every: 180,
    ready: true,
  },
  {
    id: "razorpay",
    label: "Razorpay",
    kind: "payments",
    logo: { src: "/logos/razorpay.svg" },
    gives: "Each online payment on its Shopify order, its fee and refunds, and what reached your bank.",
    auth: {
      kind: "login",
      fields: [
        { key: "key_id", label: "Key id", type: "text" },
        { key: "key_secret", label: "Key secret", type: "password" },
      ],
      how: "In Razorpay, Account & Settings → API keys → Generate key. Use the live key (rzp_live_…): a test key brings test payments.",
      where: "https://dashboard.razorpay.com/app/keys",
    },
    brings: ["gateway_payments", "gateway_settlements"],
    brought: { one: "payment", many: "payments", arriving: "bringing its payments in" },
    every: 60,
    ready: true,
  },
  {
    id: "zendesk",
    label: "Zendesk",
    kind: "support",
    logo: { src: "/logos/zendesk.svg" },
    gives: "Every ticket's subject and status, on the Shopify customer who raised it.",
    auth: {
      kind: "login",
      fields: [
        { key: "subdomain", label: "Zendesk address (yours.zendesk.com)", type: "text" },
        { key: "email", label: "Agent email", type: "email" },
        { key: "api_token", label: "API token", type: "password" },
      ],
      how: "In Zendesk, Admin Center → Apps and integrations → Zendesk API: turn on token access and add an API token. Use the email of the agent it is for.",
      where: "https://www.zendesk.com/login/",
    },
    brings: ["support_tickets"],
    brought: { one: "ticket", many: "tickets", arriving: "bringing its tickets in" },
    every: 30,
    ready: true,
  },
  {
    id: "hubspot",
    label: "HubSpot",
    kind: "crm",
    logo: { src: "/logos/hubspot.svg" },
    gives: "Your contacts with their lifecycle stage, and which are already Shopify customers.",
    auth: {
      kind: "login",
      fields: [{ key: "token", label: "Private app access token", type: "password" }],
      how: "In HubSpot, Settings → Integrations → Private apps → Create a private app, give it the crm.objects.contacts.read scope, and copy its access token.",
      where: "https://app.hubspot.com/private-apps/",
    },
    brings: ["crm_contacts"],
    brought: { one: "contact", many: "contacts", arriving: "bringing its contacts in" },
    every: 60,
    ready: true,
  },
  {
    id: "meta_social",
    label: "Facebook & Instagram",
    kind: "social",
    logo: { src: "/logos/instagram.svg" },
    gives: "Your Page's and Instagram's posts, with their likes, comments and shares.",
    auth: {
      kind: "login",
      // A system user's token, traded for the Page's own (lib/connectors/meta-social).
      fields: [
        { key: "token", label: "System user access token", type: "password" },
        { key: "page_id", label: "Facebook Page ID", type: "text" },
      ],
      how: "In Meta Business settings → Users → System users: give a system user your Page (and its Instagram account), then Generate token with pages_read_engagement, pages_show_list and instagram_basic, and no expiry. The Page ID is on the Page, under About → Page transparency.",
      where: "https://business.facebook.com/settings/system-users",
    },
    brings: ["social_posts"],
    brought: { one: "post", many: "posts", arriving: "bringing its posts in" },
    every: 180,
    ready: true,
  },
];

export const connectorById = (id: string): Connector | undefined => CONNECTORS.find((c) => c.id === id);
