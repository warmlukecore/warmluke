# Shopify integration

## Scope

The application is designed around one connected Shopify store per project. Shopify
supplies canonical commerce data; Warmluke does not write changes back to Shopify. The
runtime queries enforce the one-store expectation, although the database currently
enforces global shop-domain ownership rather than a unique `project_id`.

The integration includes:

- OAuth installation and reconnect;
- expiring access/refresh token handling;
- paginated and bulk initial/recheck imports;
- webhook subscriptions and incremental updates;
- mandatory compliance webhooks;
- drift reporting;
- store-backed application sections and MCP reads.

## Resource registry

`src/lib/shopify-resources.ts` declares each resource once. From each entry, the rest of
the system derives scopes, import order, count query, paged query, optional bulk query,
child truncation limits, save function, webhook topics, written tables, and drift policy.

Current resources:

| Resource | Primary data | Import mode | Incremental topics |
| --- | --- | --- | --- |
| `products` | Products and variants | Page or bulk | Product create/update/delete |
| `collections` | Catalogue groupings and their members | Page or bulk | Collection create/update/delete |
| `carts` | Abandoned checkouts and the recovery link | Page or bulk | Checkout create/update/delete |
| `customers` | Customer profile and spend | Page or bulk | Customer create/update/delete |
| `orders` | Orders, lines, totals, refunds, transactions | Page or bulk | Order create/update/cancel/pay/fulfil, transaction create |
| `locations` | Places the shop stocks or ships from | Page or bulk | Location create/update/activate/deactivate/delete |
| `inventory` | Variant/location stock | Page or bulk | Inventory level update/connect |
| `refunds` | Refund amount and units | Paged | Carried by order updates |
| `fulfillments` | Shipments and tracking | Page or bulk | Fulfillment create/update plus order payloads |

Adding a resource means extending this registry and implementing its query/result saver;
callers should not grow a second hard-coded resource list.

## Installation

`POST /api/shopify/install` reads the address the way a merchant gives it
(`src/lib/shop-address.ts`): the bare name, a copied store URL or an
`admin.shopify.com/store/<name>` link. Whatever it reads is held to the same strict
`*.myshopify.com` pattern the callback uses, and the callback itself stays strict. A
custom domain is refused with where to find the real address, never guessed. The route
then validates ownership, creates or updates a pending store with a ten-minute OAuth
state, and returns Shopify's authorization URL. `check-shopify` holds the reading and
`check-connect-address` holds the route. A project holds one store: connecting a
different shop beside a connected (or once-connected) one is refused with a 409, and an
attempt that never came back from Shopify is cleared rather than left beside the real
store.

### Connecting without typing

Shopify only names the store by itself when the install starts on Shopify's side, and
for any store that means a **public** app (unlisted is enough). With
`NEXT_PUBLIC_SHOPIFY_INSTALL_URL` set, **Connect with Shopify** goes through
`/api/shopify/start`, which remembers the project as a 15-minute cookie (a hint only) and
sends the merchant to the listing. Shopify then sends them to the app's address with
`shop`, `hmac`, `timestamp` and `host`. The App URL may be the site root, which `proxy.ts`
forwards, or `/api/shopify/entry` directly. The entry verifies the signature and freshness
and passes the store to `/connect`.

`/connect` requires sign-in and offers only projects the merchant owns that have no store,
or already have this one. It starts the ordinary install, including Shopify's approval.
The same page serves the **Copy a link** option for a merchant whose Shopify is signed in
in another browser. The link names only the project, and signing in there is what
authorizes it, so a link somebody else sent can only connect a store to the opener's own
account. The first tab waits and updates when the store connects.

### Uninstall and erasure

`APP_UNINSTALLED` is subscribed at connect (`LIFECYCLE_TOPICS`) and handled by
`abo_shopify_uninstalled`, which verifies the delivery like every webhook. It marks the
store `uninstalled`, drops the dead tokens and any import lease, and deletes nothing.
`shop/redact`, which Shopify sends 48 hours after an uninstall, erases the store unless
it was connected within those 48 hours. Shopify does not document whether a reinstall
cancels the redact, so the database guards against it. `check-uninstall` holds both.

The requested scopes are the unique union of resource scopes, the write scopes the
declared store actions need (`ACTION_SCOPES`), plus
`PLANNED_SCOPES`: reads asked for before the resource that will use them
exists. Adding a scope makes every connected store reconnect, so they are
asked for once while there is one store rather than once per pack. A planned
scope must leave that list when its resource claims it, and `check-shopify`
fails if the same scope is declared in both places.

Reconnecting does not interrupt a working store. The install route refreshes
the OAuth nonce and leaves a connected store connected, because the old token
stays valid until the callback replaces it and `abo_shopify_connect` matches
on the nonce rather than the status. A merchant who opens the consent screen
and closes the tab loses nothing. `read_all_orders` is added
only when `SHOPIFY_READ_ALL_ORDERS=true`, because requesting it before Shopify approves
the application fails authorization rather than granting a reduced set.

The callback:

1. verifies Shopify's signed query;
2. exchanges the authorization code;
3. reads shop timezone, currency, and country;
4. spends the OAuth state and stores token lifetimes;
5. subscribes declared webhook topics;
6. records subscription failures without undoing a valid connection;
7. redirects to the project.

## Token lifecycle

An access token may expire after approximately an hour and is refreshed on demand. The
refresh token has a longer lifetime. The dashboard treats a passed access-token expiry as
normal; it asks for reconnection only when no usable refresh token remains.

All Shopify GraphQL paths use `ensureFreshToken`. Token refresh writes through
`abo_store_renewed`, which the owner or the import ticket for that store may call, and
updates both expiry timestamps.

## Import strategy

The import runs on the server, with no tab open. `lib/import-step.ts` advances one
bounded piece of work and updates `import_runs`; a serverless request never attempts the
whole store. Two callers run that same step:

- **The worker** (`POST /api/shopify/import/worker`). The database dispatches it with
  `pg_net` when a store connects, every minute for stores with work left (`abo_import_tick`),
  and once a day for every connected store (`abo_import_sweep`, which picks up resources
  added to the registry later). It answers at once and works in `after()`, renewing its
  ticket each step and handing over to a fresh ticket and request after about 200 seconds.
- **The owner's browser**, only where the database has no worker address. `StoreStrip`
  asks for a kick; `not_configured` means no worker, and it drives the steps itself.

The worker has no key of its own. The database mints a random ticket bound to one store,
stores only its hash in `import_leases`, and posts the ticket to the worker, which sends
it as `x-import-ticket`. The `*_import_ticket` policies accept it for that store's rows in
the importer's own tables, and `check-shopify` holds that list to the registry. A ticket
lasts six minutes per renewal and at most thirty minutes in total. `check-import-worker`
tries other stores, lapsed and guessed tickets, and tables outside the list.

The switch is the vault secret `import_worker_url`. Without it nothing is dispatched and
the browser drives the import as before, so clearing it is the rollback.

A failure the worker hits records `attempts` and a `retry_at` doubling from a minute. It
stops after `MOST_ATTEMPTS` and waits for the merchant's "Try again", which the status
response reports as `stopped`.

For each resource:

1. Count the source rows.
2. Use pages of 50 for smaller resources.
3. Above `SHOPIFY_BULK_THRESHOLD` (default 250), start a Shopify bulk operation where
   that resource supports it.
4. Poll that exact operation by ID.
5. Read its JSONL result in byte ranges.
6. Keep parent/child families together and write assembled rows in bounded batches.

Paged GraphQL children have explicit limits. If a page reaches a child limit, it is
treated as possibly truncated and is not saved before switching to bulk. This avoids
replacing a complete local family with a silently truncated page.

A resource with no bulk query (`bulk: null`) has nowhere better to go, so its page is
saved as it came and its limits are set to the largest Shopify allows. `refunds` is that
case: refund line items are a connection inside a list, which Shopify refuses to export
in bulk, so refund units are paged over the refunded orders instead.

Resources import in dependency order so products/customers exist before order references
are resolved. Upserts also tolerate webhook data arriving before its parent import.

## Recheck and drift

A recheck resets resource cursors and walks Shopify from the beginning using idempotent
upserts. When the complete pass finishes, Warmluke compares selected parent-table counts
with imported counts.

If local holdings exceed what Shopify returned, the response reports drift. It does not
delete rows automatically because a partial upstream result is observationally similar
to a deletion, and an incorrect delete is harder to recover from than a warning.

`last_synced_at` advances to actual import completion or verified webhook time; merely
asking for status never makes data appear fresh.

## Webhooks

`subscribeWebhooks` registers all topics derived from the resource registry. Ordinary
topics use `/api/shopify/webhooks/[token]`; compliance topics use
`/api/shopify/webhooks/compliance`.

Both routes verify the raw-body HMAC in Next.js and call a database RPC that verifies the
signature at the write boundary. Topic-specific database handlers validate payload shape
and upsert/delete only the expected resource.

Webhook processing handles data arriving in unexpected order and prevents redacted
customer data from being recreated. A successful commerce webhook advances the store's
freshness timestamp.

## Store-backed sections

A module may set `source_table` to a supported store list. Such a section:

- reads the canonical security-invoker view;
- is read-only in the application;
- uses the canonical store schema, plus optional computed columns;
- supports display features and server-calculated section statistics;
- cannot contain seeded/generated copies of Shopify rows.

The valid table list and displayed schemas live in `src/lib/store-read.ts`.

## Disconnect and compliance

Disconnecting deletes the local `stores` row and cascades imported data and stored
tokens. It does not modify the Shopify shop and can be reconnected later.

Compliance handlers support customer data requests, customer redaction, and shop
redaction. Redactions remove covered local personal data and leave the minimum tombstone
needed to keep a later webhook/import from restoring erased data.
