# Connectors: couriers and ad accounts beside the store

Status: design, agreed 11 Oct 2026. Phases 1 to 5, 7 and 8 are built; each waits on what is listed
under [Phases](#phases). Every connector is reached with the merchant's own credential, so
none waits on a review of Warmluke's own app.

## Scope

A Warmluke app is built on one Shopify store. Its owner's day also runs through a courier
aggregator (Shiprocket, GoSwift) and ad accounts (Meta, Google). This document is how those
connect, what they bring, and how that becomes something a section, Luke, the owner's own
AI and the Overview can read, the way Shopify's lists already are.

It is not a general integration platform. Each connector is a few hundred lines that know
one provider; everything around them (who may connect, where secrets live, how a sync runs,
how rows are read) is shared and written once.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Whose is a connection? | **The store's** (`store_id`), not the account's | Two stores of one owner use different couriers and ad accounts; a store's sections and Luke read that store's rows only, as they read its orders. |
| Who connects? | The **owner**, in Warmluke | A connection holds credentials that act for the business. A member, or the owner's own AI over MCP, can see that one exists and when it last synced, never connect or read its secret. |
| Tables | **By kind of data**, not by provider: `ad_spend`, `courier_shipments`, `cod_remittances` | "What did ads cost this week" is one question whether the money went to Meta or Google. A provider column says where a row came from. |
| Secrets | **The vault**, named `connector:<connection id>`, never read back to a browser | As Shopify app secrets are (0150). A browser that could read one could act as the business from anywhere. |
| Background sync | **A ticket per connection**, minted by the database and posted to a worker with pg_net | As the store import (0110): production holds no service-role key, and a leaked ticket opens one connection for minutes. |
| Description of connectors | **One registry**, `src/lib/connectors.ts` | As `shopify-resources.ts`: adding a provider is one entry plus its adapter; screens, checks and docs read the list. |
| Matching to orders | By the **Shopify order** a shipment names, resolved in the database | Couriers carry the store's order number or id; resolving once, on write, lets every list join shipments to orders without each reader guessing. |

## Shape

```
Settings → Connections (owner)          their AI / members
   │ connect (OAuth or login form)          │ read status only
   ▼                                        ▼
/api/connectors/[provider]/connect ──► abo_connector_save (vault, store_connections)
                                             │
pg_cron abo-connector-tick ── mints ticket ──┤
   │ pg_net POST                              ▼
/api/connectors/worker  ── x-connector-ticket ──► abo_connector_job (secret, cursor)
   │ adapter.pull(page)                       │
   ▼                                          ▼
provider API  ─────────── rows ──► ad_spend · courier_shipments · cod_remittances
                                             │ store_* views, STORE_TABLES
                                             ▼
                          sections · Luke · MCP · Overview · alerts
```

## Data model

All new tables carry `project_id` and `store_id`, have the member read policy
(`abo_can_use(project_id)`), and get the three restrictive OAuth-client policies every table
gets. Writes come only from functions or a ticket's policies.

- **`store_connections`**: one row per store, provider and remote account.
  - `provider` (`shiprocket`, `goswift`, `meta_ads`, `google_ads`).
  - `account_ref`: the remote account (an ad account id, the login email shown masked).
  - `account_label` and `status`. `status` is `connected`, `needs_attention` (a refused
    credential or a revoked grant, said in `last_error`), `paused` (0218) or `disconnected`.
  - `scopes`, `connected_by`, `connected_at`, `last_synced_at`, `next_sync_at`.
  - Unique on `(store_id, provider, account_ref)`.
  - No secret is a column.
- **`connector_cursors`**: where each resource of a connection got to (`resource`,
  `cursor`, `synced_through`), so a sync resumes rather than starts over.
- **`connector_leases`**: the per-connection claim and the hash of its live ticket, as
  `import_leases`.
- **`ad_spend`**: one row per connection, campaign and day.
  - Columns: `campaign_id`, `campaign_name`, `day` (in the ad account's timezone), `spend`,
    `currency`, `impressions`, `clicks`, and `purchases` and `purchase_value` as the ad
    platform counts them.
  - `purchases` and `purchase_value` are the platform's own claim, kept apart from the
    store's orders.
  - Unique on `(connection_id, campaign_id, day)`. A day is rewritten while the platform
    still revises it (the last few days).
- **`courier_shipments`**: one row per connection and AWB.
  - Columns: `courier`, `status` and `status_at`, `ndr_reason` and `ndr_attempts`, `rto`,
    `shipped_at`, `delivered_at`, `freight`, `cod_amount`, `payment_mode`.
  - `order_ref` is what the courier called the order. `order_id` is the Shopify order it
    resolves to, set by a trigger matching the order's number or Shopify id.
- **`cod_remittances`**: one row per connection, remittance and AWB, with `amount`,
  `remitted_on`, `utr` and the resolved `order_id`.

Each data table gets a `store_*` view and a `STORE_TABLES` entry, so sections are built over
it, Luke reads it, the owner's own AI reads it through MCP, and `abo_store_view` serves it,
with no reader of its own. Store metrics gain `ad_spend` and ROAS (revenue ÷ spend, by day or
campaign) once there is spend to divide by.

## Registry

`src/lib/connectors.ts` declares each provider once:

- `id`, `label`, `logo` (the provider's official mark, unaltered, in `public/logos`, on the
  `logo-tile` token), `kind` (`courier`, `ads`, `analytics`, `email`, `support`, `crm`,
  `social`; `KINDS` names each group in Settings).
- `auth`:
  - `{ kind: "oauth", authorize, token, scopes }` for Meta and Google;
  - `{ kind: "login", fields }` for Shiprocket and GoSwift, whose APIs are reached with an
    API user's login.
- `brings`: the tables it writes.
- `every`: how often it is pulled.
- `resources`: what one pull walks, each with its page size and how far back a first pull
  goes.
- `webhooks`: what it can push (Shiprocket tracking updates), if anything.
- `needs`: what has to exist before a store can connect (an approved Meta app; a Google
  Ads developer token). With that missing, the connector shows as "coming soon" rather
  than failing at the end of a login.

Each provider's code lives in `src/lib/connectors/<provider>.ts`:

- `login` or the OAuth exchange: proves the credential and returns `account_ref` and label;
- `refresh`: renews a token before it lapses;
- `pull(resource, cursor)`: one page of rows, mapped to the table's columns, and the next
  cursor.

Nothing outside the adapter knows a provider's field names.

## Connecting

- **OAuth (Meta, Google):**
  1. "Connect" asks `/api/connectors/[provider]/start` for an authorize URL, with a `state`
     bound to the store and the owner, kept hashed with an expiry like the Shopify install
     state.
  2. The callback exchanges the code on the server.
  3. If the grant holds several ad accounts, the owner picks one (or several) in the app.
  4. `abo_connector_save` writes the tokens to the vault and the connection row.
- **Login (Shiprocket, GoSwift):**
  1. A form in the app takes the API user's credentials.
  2. The server tries them once against the provider.
  3. On success it saves them, with the token it got and its expiry; on failure it says
     the provider's reason in plain words, and saves nothing.
- **Pause and Resume (0218):** the owner's, in Settings → Connections
  (`abo_connector_pause`).
  - Paused keeps the credential and the rows already brought, and brings nothing new: the
    tick, a ticket, every write a ticket makes, Sync now and a provider's own delivery all
    ask for `connected` already. Pausing drops the live ticket, so a sync on its way stops
    at its next write.
  - Resume marks it `connected` and syncs at once. A courier that posts to us (GoSwift)
    is not asked again for what it sent while paused; those parcels join when they next move.
  - Sync now that cannot start says why on the screen (already syncing, or no worker yet).
- **Disconnect:**
  - Deletes the vault secret and marks the row `disconnected`.
  - Keeps the rows already brought: they are the business's history, still useful in a
    report.
  - Deleting the store, or the app, deletes everything (cascade).

The connection row keeps who connected and who disconnected, and when.

## Sync

- **Schedule:** `abo-connector-tick` runs every five minutes where pg_cron exists.
  - It picks connections whose `next_sync_at` has passed, mints each a ticket and posts it
    to `/api/connectors/worker`.
  - The switch is a vault entry, `connector_worker_url`, as `import_worker_url` is. With none
    (the check project), nothing is dispatched.
  - **The check project must never get this entry**, for the same reason it must never get
    `import_worker_url`.
- **Worker:** presents the ticket and gets back, through `abo_connector_job`, only that
  connection's secret, cursors and tables. It walks resources page by page within a time
  budget, writes rows, saves cursors, and hands on to the next tick when time runs out.
- **Tokens:** renewed by the adapter before expiry and saved back through the ticket. A
  refused credential sets `needs_attention` and stops pulling until the owner reconnects.
  The bell says so: a connection needing attention is something waiting on them.
- **Freshness per kind:**
  - Ad spend: hourly for today and the last 3 days (platforms revise them), daily further
    back.
  - Shipments: pulled every 30 minutes where the provider has a list (Shiprocket), and
    pushed by webhook where it has none (GoSwift, 0205), with the quiet ones asked after.
  - Remittances: daily.
- **Webhooks (0205):**
  - `/api/connectors/[provider]/hook/[token]`. The connection's sync registers that address
    with the provider. The token is 256 random bits, kept in the connection's vault credential
    and as a hash on `store_connections.hook_hash`, as Shopify's webhook addresses are.
  - A delivery is resolved by the database from the token (`abo_connector_hook`), for a
    connection of that provider that is still connected, and writes that connection's rows
    alone. Disconnecting clears the hash, so the address is refused from then.
  - The sync keeps the address registered and listening, making it again in place when the
    provider no longer has it as ours, and asks after shipments that have been quiet for six
    hours (`abo_connector_open_shipments`), in case a delivery was missed.
- **Limits:** each adapter honours its provider's rate limits and backs off as the import
  step does; a 429 sets the next try, it does not loop.

## Who reads what

| Reader | Sees | How |
| --- | --- | --- |
| Owner | Connections, status, the data | Settings → Connections; sections and the Overview over the store lists |
| Member | Status and the data, as for orders | The same lists, no connect, pause or disconnect |
| Luke | The data | `STORE_TABLES`, store metrics (ROAS) |
| Their own AI (MCP) | The data, and which connections exist with their last sync | The store tools that already list `STORE_TABLES`; connecting stays in Warmluke |
| Alerts | The data | The alert rules over store lists (an NDR not acted on in a day, ad spend with no orders) start off, as every alert does (0199) |

## Security

- **Secrets:**
  - Credentials and tokens live only in the vault. Functions read them for one connection,
    and only with a live ticket for that connection or within the owner's own connect
    request.
  - No secret is a table column, so column privileges have nothing to leak; new tables are
    added to the grants check like any other.
  - Meta's and Google's app secrets are server environment settings, never in the database,
    and never in a response.
- **OAuth `state`:** single-use, ten minutes, bound to store and owner.
- **Login credentials:** Shiprocket's API user is a separate user the merchant creates for
  integrations, not their own login. The connect form says so and links to where they make
  one.
- **Privacy:** the privacy page lists each provider as a processor before its connector
  ships. Data deletion covers connector rows (store deletion cascades).

## Testing

- **Pure checks, one per adapter:**
  - The provider is stood in for with recorded responses, as `check-model-errors` stands in
    for the model.
  - They prove the mapping to columns, cursors, token renewal, refused credentials and rate
    limits.
- **A database check** (`check-connectors`) proves the walls and the ticket's reach:
  - a member cannot connect, and an OAuth client cannot write;
  - a ticket reaches one connection's secret and tables, and nothing after it lapses.
- **Browser walks** of Settings → Connections at desktop and phone width, with the provider
  stood in.
- **Live checks** against a real account run only on the user's word, against a test
  account they name.

## Phases

1. **Campaign data on Shopify orders.** Built (0203, 11 Oct). No outside approval;
   `read_orders` is already held.
   - Each order gains where it came from, from Shopify's `customerJourneySummary` (last
     visit): `visit_source`, `utm_source`, `utm_medium`, `utm_campaign`, `landing_page`,
     `referrer`. It also gains `channel` (Shopify's `sourceName`: web, pos, an app).
   - The webhook road reads the same from the order payload (`landing_site`, its `utm_`
     query parameters, `referring_site`, `source_name`).
   - Shopify fills the journey a little after the order: empty means not known yet, not
     "direct".
   - This is half of ROAS, and "orders by campaign" on its own.
2. **The framework, and Shiprocket.** Built (0204, 11 Oct): `store_connections`,
   `courier_shipments`, the vault save, the ticket and worker, the five-minute tick,
   `src/lib/connectors.ts`, the Shiprocket adapter (login, token renewal, orders and their
   shipments), `/api/connectors`, and Settings → Connections. Checked by `check-connectors`
   (walls and ticket), `check-shiprocket` (the adapter, Shiprocket stood in for) and
   `e2e/connections.spec.ts`. Waiting on a live account: NDR, RTO dates, freight and COD
   remittance (not in Shiprocket's published collection), and the `STORE_TABLES` entry that
   puts shipments before Luke and sections, so no store shows an empty list before it has one.
   - Tables, registry, vault save, ticket, worker, tick, and Settings → Connections.
   - Shiprocket: shipments with tracking, NDR, RTO, freight, and COD remittance.
   - Needs: an API user on a Shiprocket account to test with.
3. **GoSwift.** Built (0205, 11 Oct): the adapter (`src/lib/connectors/goswift.ts`), the hook
   route, and the address's half in the database, under [Webhooks](#sync). Checked by
   `check-goswift` (GoSwift stood in for, from its API v3.8.8), `check-connectors` (the
   address's walls) and the Connections walk.
   - Its API has no list of shipments and no COD remittance: shipments come as GoSwift posts
     them (made, made again, every tracking step), from the day a store connects. Older ones
     join the next time they move.
   - The login is a client ID and an API username and password, which GoSwift gives on request
     (tech-integrations@goswift.in). The token lasts about a day and is renewed near its end.
   - Waiting on a live account: the header GoSwift signs a delivery with is not in its docs.
     The address's token is the proof until a live delivery shows it.
4. **Meta Ads.** Built (0214, 14 Oct): `ad_spend` and its `store_ad_spend` list ("Ad spend"),
   the adapter (`src/lib/connectors/meta-ads.ts`) and Settings → Connections. Checked by
   `check-meta-ads` (Meta stood in for), `check-connectors` (the walls, and a courier's ticket
   writing no spend) and the Connections walk.
   - Connected with a **token from the store's own business**: a system user given the ad
     account, with `ads_read` and no expiry. A business's own app reading its own ad account
     needs only the access every app has, so it waits on no review of ours (Meta's Marketing
     API authorization docs, 14 Oct). Its limits are tighter, which one read an hour fits.
   - What a sync reads: insights at campaign level, one row per campaign and day, 90 days on
     the first run, a month per request; each run starts three days before the last one
     finished, which Meta still revises. Purchases are Meta's `omni_purchase`, its own claim,
     kept apart from the store's orders.
   - Later, for merchants without a business app: "Continue with Facebook" through our own
     app, once it has Business Verification and Advanced Access to `ads_read`. Only the login
     step changes.
   - Waiting on a live account: the first real token, to see an account's own answers.
5. **Google Ads.** Built (0215, 14 Oct) into the same `ad_spend` list as Meta's, by
   `src/lib/connectors/google-ads.ts` (API v25, GAQL over campaign by `segments.date`, a month
   per request, cost in micros). Checked by `check-google-connectors`.
   - Connected with the merchant's **own API access**: a developer token from their manager
     account, an OAuth client and its refresh token, and the account id (and the manager's
     when they sign in through one). Usually set up by whoever runs their ads.
   - "Conversions" are whatever the account counts as one; the list says so.
   - Later: "Continue with Google" through our own project, once it has Google Ads API
     access approved for production. Only the login step changes.
6. **ROAS across both.** Built (0217, 15 Oct): `store_campaign_results` ("Campaign results"),
   each campaign's spend by day beside the store's own orders that day whose UTM campaign is
   the campaign's name or id (case and spaces aside, cancelled ones left out, on the store's
   own calendar): `store_orders`, `store_revenue`, `store_roas`, `cost_per_order`, and the
   platform's own claim (`platform_roas`) beside them. Checked by `check-store-query`.
7. **The rest of the store's day.** Built (0215, 14 Oct): five lists by kind, each written
   only by a connection whose provider brings it (`abo_connector_holding`), with customers
   matched on write by email or the phone's last ten digits (`abo_connector_customer_for`).
   Checked by `check-email-connectors`, `check-support-crm-connectors`, `check-meta-social`,
   `check-connectors` (every list's walls, and the matching) and the Connections walk.
   - **Google Analytics** → `web_traffic`: visits, people, purchases and revenue by day,
     source, medium and campaign (Data API `runReport`). A service account of the merchant's
     own, added as a Viewer of the property; its key signs a JWT here.
   - **Mailchimp, Brevo** → `email_campaigns`: each send's opens, clicks, unsubscribes and
     bounces, and Mailchimp's credited orders and revenue. An API key each.
   - **Zendesk** → `support_tickets`: the incremental ticket export by cursor, with the
     requester, on the Shopify customer they are. An agent's email and an API token.
   - **HubSpot** → `crm_contacts`: contacts changed since the last run, through the CRM
     search, past its 10,000 cap. A private app's token.
   - **Facebook & Instagram** → `social_posts`: the Page's posts and the linked Instagram's
     media, with likes, comments and shares. A system user's token, traded for the Page's.
   - Not built, on purpose: scrapers of other sites (marketplaces, review sites, trends),
     which break those sites' terms; and Google Drive, which is files, not store data.
8. **Payments, messages, and two more.** Built (0216, 15 Oct). Checked by
   `check-klaviyo-whatsapp`, `check-razorpay-delhivery`, `check-connectors` (every list's walls,
   a payment on its order, Delhivery's AWBs) and the Connections walk.
   - **Klaviyo** → `email_campaigns`: email campaigns changed in the span, then one campaign
     values report a run (Klaviyo allows a couple a minute), revenue counted on the account's
     "Placed Order" metric, found at connecting. A private API key (`pk_…`).
   - **WhatsApp Business** → `message_stats`: each template's sends, deliveries, reads and
     clicks by day (template analytics, ten templates a call, 90 days kept). A system user's
     token and the WhatsApp Business account id; connecting turns template insights on.
     Messages themselves are not readable after sending, and are not read.
   - **Razorpay** → `gateway_payments` and `gateway_settlements`: payments on the Shopify order
     their notes or description name (never Razorpay's own order id), amounts in rupees, and
     settlements with their UTR. A key id and secret.
   - **Delhivery** → `courier_shipments`: Delhivery has no list of a client's shipments, so
     `abo_connector_carrier_awbs` hands its sync the AWBs on the store's own fulfilments with
     Delhivery as the carrier (60 days, not delivered or returned, not asked in two hours),
     tracked fifty a call. An API token.
   - Next, by what Indian stores run on: Zoho Books or Inventory, Google Sheets as a section,
     Freshdesk or Gorgias, Judge.me reviews, Search Console; marketplaces (Amazon, Flipkart)
     need each seller's developer registration first.

Provider facts (token lifetimes, rate limits, review steps) were researched on 9 Oct. Each
phase checks them against the provider's current documentation before it is built.
