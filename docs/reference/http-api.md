# HTTP API reference

Unless noted otherwise, API routes run on the Node.js runtime, accept JSON, require a
Supabase bearer session, and execute database work through a caller-scoped client.
Database RLS remains authoritative.

## Projects and application structure

| Method and path | Purpose | Important rules |
| --- | --- | --- |
| `GET /api/projects` | List projects visible to the caller | RLS includes owned and joined projects as applicable |
| `POST /api/projects` | Create an empty project | Owner is the authenticated user |
| `PATCH /api/projects` | Rename/update locale, currency, or auto-build | Owner-only writes; chosen currency is tracked separately from its default |
| `DELETE /api/projects` | Delete a project | Owner-only and explicitly confirmed by the UI; cascades project data |
| `GET /api/modules?projectId=&id=` | Preview module deletion impact | Returns row and child-section impact |
| `POST /api/modules` | Create a section manually | Validates source table and creates initial schema |
| `PATCH /api/modules` | Rename/reorder/reparent/change source | Prevents invalid nesting/source transitions; versions schema changes |
| `DELETE /api/modules` | Delete a section | Owner-only with confirmation name and dependency checks |
| `POST /api/records` | Create, update, delete, or apply a row action | Reloads current schema, strips undeclared data, enforces computed/store restrictions |
| `POST /api/rollback` | Restore an earlier UI schema | Appends a new schema version rather than rewriting history |

The browser performs many ordinary reads directly through Supabase under RLS. These API
routes exist where server-side validation, orchestration, or secrets are required.

## Assistant and builds

| Method and path | Purpose | Response |
| --- | --- | --- |
| `GET /api/chat?projectId=` | List up to 30 recent conversation threads | JSON |
| `GET /api/chat?projectId=&id=` | Load one thread and up to 200 recent messages | JSON, chronological messages |
| `GET /api/chat?projectId=&latest=1` | Load the newest thread | JSON |
| `POST /api/chat` | Run one built-in-assistant turn | NDJSON progress events plus one final object; pre-run refusals are ordinary JSON |
| `POST /api/apply` | Validate and apply approved plans | Full, partial, already-claimed, or validation result |
| `POST /api/undo` | Conservatively reverse a recorded build | Reads undo steps from the authorized message; reports completed/refused steps |

`POST /api/chat` accepts `message`, `projectId`, optional `moduleId`, and optional
`conversationId`. It enforces the account feature switch, project ownership, hourly
ceiling, and included-turn ledger. It never applies plans.

`POST /api/apply` accepts `projectId`, plans, and an optional MCP `requestId`. With a
request ID it first claims the request atomically. Plans are capped, revalidated against
live state, and executed through `abo_build`.

## Shopify

| Method and path | Authentication | Purpose |
| --- | --- | --- |
| `POST /api/shopify/install` | Owner bearer session | Create pending store state and return Shopify authorization URL |
| `GET /api/shopify/callback` | Signed Shopify query + one-time state | Exchange token, connect store, subscribe webhooks, redirect |
| `POST /api/shopify/import` | Project user bearer session; secret token RPC is owner-restricted | Advance one bounded import step, report status, or begin recheck |
| `POST /api/shopify/webhooks/[token]` | Shopify raw-body HMAC and per-store URL token | Apply ordinary resource events |
| `POST /api/shopify/webhooks/compliance` | Shopify raw-body HMAC | Apply mandatory data request/redaction events |

Import request body:

```json
{
  "projectId": "uuid",
  "status": false,
  "recheck": false
}
```

`status` reads progress without contacting Shopify. `recheck` resets completed resource
cursors for a new full pass. Ordinary calls advance the first unfinished resource.

## Store support

| Method and path | Purpose |
| --- | --- |
| `GET /api/fx?project=&from=&to=` | Return a project-scoped cached or freshly fetched exchange rate |

FX codes must be three uppercase letters. Fresh rates come from Frankfurter/ECB data,
are cached for one day, may be served as explicitly stale for up to seven days, and are
otherwise omitted so the UI can retain the truthful source currency.

## MCP and OAuth metadata

| Method and path | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource[/...]` | Publish the protected resource and Supabase authorization server |
| `POST /api/mcp` | Handle authenticated MCP JSON-RPC requests |
| `GET /api/mcp` | Report that server-initiated streaming is unavailable |
| `DELETE /api/mcp` | Confirm there is no persistent server session to terminate |

See [MCP integration](../integrations/mcp.md) for the tool catalogue and approval model.

## Public server action

`bookDemo` in `src/app/actions.ts` validates and records a landing/demo request using the
public Supabase configuration. PostgreSQL rate limiting and table policy constrain the
anonymous write. Besides name, email, store and note it records team size, orders a month
and where the person heard of us, each kept only when it is one of onboarding's lists
(`src/lib/onboarding.ts`). The form will not send without them; with JavaScript off it
cannot ask them, and the booking is stored without them rather than lost. Administrators
read bookings back through `abo_admin_demo_requests` on `/admin/demos`, set each one's
stage and note through `abo_admin_demo_follow_up` (0120), and open one account's whole
story on `/admin` through `abo_admin_account`. Both screens take `?find=<text>` to open
with a search, and download what they show as CSV.

## Invite links

`/admin/invites` makes a link (`abo_admin_invite_create`) for one email or for several
people, for 24 hours to 30 days, and changes when it ends or withdraws it
(`abo_admin_invite_update`). `/start/[token]` asks `abo_invite_peek`, which anyone may
call and which answers only for that token: its state and, while it is open, the prefill.
Signing up there, or arriving signed in, calls `abo_invite_claim`, which takes a use once
per account, refuses a link made for another email, and lets an administrator look
without using it up. The name and business go into the account's metadata, where
onboarding picks them up.

## Error conventions

Routes return a concise user-facing `error` for expected failures and an appropriate HTTP
status. Model errors may also include a recovery hint. Partial build and undo responses
name both successful and refused operations; callers must not treat HTTP success as
proof that every requested plan stands.

The shared browser helpers `apiFetch` and `apiStream` attach the current access token and
normalize JSON/NDJSON handling. A stream ending without its final object is reported as
an interrupted turn, not a successful empty reply.
