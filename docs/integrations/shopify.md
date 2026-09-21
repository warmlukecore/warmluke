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
| `customers` | Customer profile and spend | Page or bulk | Customer create/update/delete |
| `orders` | Orders, lines, totals, refunds | Page or bulk | Order create/update/cancel/pay/fulfil |
| `inventory` | Variant/location stock | Page or bulk | Inventory level update/connect |
| `refunds` | Refund amount and units | Paged | Carried by order updates |
| `fulfillments` | Shipments and tracking | Page or bulk | Fulfillment create/update plus order payloads |

Adding a resource means extending this registry and implementing its query/result saver;
callers should not grow a second hard-coded resource list.

## Installation

`POST /api/shopify/install` validates ownership and normalizes the `*.myshopify.com`
domain. It creates or updates a pending store with a ten-minute OAuth state, then returns
Shopify's authorization URL.

The requested scopes are the unique union of resource scopes. `read_all_orders` is added
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

All Shopify GraphQL paths use `ensureFreshToken`. Token refresh writes through the
owner-scoped database path and updates both expiry timestamps.

## Import strategy

The browser repeatedly calls `POST /api/shopify/import`. Each call advances one bounded
piece of work and updates `import_runs`; a serverless request never attempts the whole
store.

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
