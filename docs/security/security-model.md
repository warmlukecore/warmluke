# Security model

## Security posture

Warmluke treats the database as the authorization boundary. Browser checks and route
handler checks improve behavior and error messages, but Row Level Security (RLS) and
narrow security-definer functions determine what a caller may ultimately read or write.

There is no service-role key in the application runtime path. Administrative scripts and
live checks may use privileged credentials against an explicitly selected project.

## Identities

| Identity | Token characteristic | Intended access |
| --- | --- | --- |
| Anonymous visitor | Supabase anon role | Public pages, bounded landing-event insert, verified OAuth/webhook RPCs |
| Application user | Authenticated JWT without `client_id` | Owner or member access determined by project RLS |
| OAuth AI client | Authenticated JWT with `client_id` | Reads under the owner identity; direct table writes refused |
| Superadmin | Authenticated user with protected account setting | Narrow admin RPCs only; not a general service-role session |

`getUserClient` verifies a bearer token with Supabase Auth, then creates a Supabase client
whose access-token callback supplies that same JWT. PostgREST therefore evaluates RLS as
the caller, not as the server.

## Project roles

| Capability | Owner | Member | OAuth client acting for owner |
| --- | ---: | ---: | ---: |
| Read project/modules/schemas | Yes | Yes | Yes |
| Read generated and store data | Yes | Yes | Yes |
| Insert/update ordinary records | Yes | Yes | No direct table writes |
| Delete ordinary records | Yes | No | No |
| Read assistant conversations | Yes | No | No direct table access |
| Change modules/schemas/rules | Yes | No | Only through approved `abo_build` operations |
| Manage members/store/settings | Yes | No | No |
| Use built-in paid assistant | Yes | No | Not applicable |

Members join through an unguessable invitation token. The token, not an email address,
proves possession; this matters because an auto-confirmed email alone is not a trusted
invitation claim.

## OAuth-client write wall

Supabase OAuth access tokens otherwise behave like ordinary user sessions. Migration
`0028_oauth_read_only.sql` introduced restrictive insert, update, and delete policies on
public tables whenever the JWT contains `client_id`.

Later migrations extend the guard to new tables. `abo_tables_missing_oauth_guard()` and
security checks detect tables that were added without the wall.

The client has only narrow security-definer doors:

- record a proposed/requested design;
- count an MCP call;
- approve or reject its own request under defined conditions;
- build the exact approved request through `abo_build`;
- record the resulting history entry.

It cannot bypass these functions by calling PostgREST directly.

## Build authorization

`abo_build(project, request, operation, payload)` is the canonical write gateway used by
`applyPlans`.

For a first-party owner session, it requires project ownership. For a token with
`client_id`, it additionally requires:

- a request ID;
- the same project;
- the same client identity;
- an approved request in an allowed transient state;
- an operation allowed to external clients.

Module deletion is refused for OAuth clients even with an approved request. Request
claiming uses compare-and-set semantics so concurrent approvals cannot apply one design
twice. The final outcome spends the approval and records what was actually written.

TypeScript validation decides whether a plan is meaningful; the database function
decides who may write and which project rows may be touched. Both layers are required.

## Shopify trust boundaries

### OAuth callback

The callback verifies Shopify's HMAC before trusting query parameters. It normalizes and
binds the shop domain, exchanges the code, and spends a short-lived OAuth state through
`abo_shopify_connect`. The state is single-use and ties the callback to a pending store
row.

### Ordinary webhooks

Each connected store receives a tokenized callback URL. The route verifies the HMAC over
the raw request bytes. PostgreSQL resolves the store from the URL token and verifies the
signature again before applying a topic-specific payload.

The `X-Shopify-Shop-Domain` header is not treated as identity: Shopify's application-wide
HMAC proves that a delivery came from Shopify, but not that an independently supplied
header belongs to a particular store.

### Compliance webhooks

Shopify requires one global endpoint for data request and redaction topics. These
payloads carry the shop domain inside the HMAC-signed body, so the database may bind the
request to that signed value. Other topics are refused on this endpoint.

### Tokens

Store access and refresh tokens are not readable table columns for ordinary callers.
The import path retrieves them through an owner-only function. Access tokens are renewed
when needed; an expired refresh token requires reconnection.

## Data minimization and destructive actions

- Store sections expose only declared view columns.
- The built-in assistant sees bounded snapshots/slices, not unrestricted database access.
- MCP tools have explicit input schemas, row limits, and per-hour call accounting.
- Project/module/store deletion is owner-only and requires explicit UI confirmation.
- Undo refuses to overwrite changes made after the target build.
- Shopify drift detection reports unmatched rows but does not infer deletion.
- Customer/shop compliance redaction is intentionally irreversible and tombstoned.

## Web and transport protections

`next.config.mjs` applies content type, framing, referrer, permissions, and conditional
Content Security Policy headers. The CSP permits inline scripts because of the current
Next.js hydration setup; this limits external script sources but is not a complete XSS
defense. The source comment identifies per-request nonces as the stronger future option.

The MCP protected-resource metadata advertises the Supabase authorization server and
bearer-header method. The MCP route requires an authenticated bearer token for protocol
operations.

## Security verification

Relevant checks include RLS isolation, second-merchant isolation, OAuth write refusal,
build-door approval, request claiming, store-token access, webhook gating, client token
behavior, client revocation, and missing OAuth guards. Some require an account-wide
Supabase management token and therefore run in the local pre-push hook rather than CI.

When adding a public table, write path, security-definer function, webhook topic, or MCP
tool, update the corresponding adversarial checks before treating the boundary as safe.
