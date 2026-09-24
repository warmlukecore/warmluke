# MCP integration

## Purpose and transport

`POST /api/mcp` lets a merchant use their own AI assistant to read their synchronized
store, inspect their generated application, and request controlled application changes.

The endpoint implements stateless Streamable HTTP semantics:

- one JSON-RPC response per request;
- no server-sent event stream;
- no durable MCP session;
- `GET` reports that server-initiated streaming is unavailable;
- `DELETE` has no session to terminate.

The server accepts the known MCP revisions listed in the route and forward-compatible
date-shaped newer revisions. Invalid version shapes are refused.

## Authentication discovery

`/.well-known/oauth-protected-resource` identifies `/api/mcp` as the protected resource
and the configured Supabase Auth service as its authorization server. Clients send the
resulting access token in the `Authorization: Bearer` header.

The consent page explains access in user terms. Database policies detect the OAuth
token's `client_id` claim and make it read-only at the table layer. Revocation is exposed
through owner-scoped RPCs and the built-in chat settings UI.

## Tool catalogue

| Tool | Purpose | Mutates state? |
| --- | --- | ---: |
| `ask_store` | Route a natural-language store question to the relevant list/window | No |
| `store_overview` | Store identity, timezone, currency, sync time, counts, and whether any resource is still importing | No |
| `search_orders` | Filter orders by date, status, or customer/order search | No |
| `get_order` | Read one order with its items | No |
| `search_store` | Read a supported canonical store list | No |
| `low_stock` | Read inventory at or below a threshold | No |
| `read_section` | List/inspect generated sections and owner-managed rows; with `history`, the section's version history instead | No |
| `undo_build` | Reverse a build this client made, from what that build recorded | Yes |
| `propose_change` | Run Warmluke's design engine and create an approval request | Creates a request only |
| `pending_changes` | Read requests currently awaiting a decision | No |
| `build_history` | Read completed, partial, or dismissed build history | No |
| `reject_change` | Record the merchant's rejection of the client's request | Request state only |
| `design_format` | Read the supported plan/capability contract | No |
| `validate_design` | Validate client-authored plans without submitting them | No |
| `submit_design` | Submit already-authored valid plans for merchant approval | Creates a request only |
| `approve_change` | Apply a previously stored and approved request | Yes, through build gateway |

Tool descriptions tell clients to use inline SVG for charts in artifacts and to propose
a persistent Warmluke section when the merchant wants the result retained.

The six store-reading tools (`ask_store` through `low_stock`) are declared once, in
[`src/lib/store-tools.ts`](../../src/lib/store-tools.ts): name, description, JSON Schema
and a `run()` that reads with the caller's own client. The MCP route lists that same array,
adding only `shop_domain` and the artifact note, and calls its `run()` once the store is
settled; `aiStoreTools()` gives the same tools to the AI SDK for Luke. `check-store-tools`
(pure) holds that there is one list and that each tool refuses a bad argument before any
read. The other tools stay in the route: they are MCP's approval flows.

## Read behavior

All reads use the caller-scoped Supabase client and inherit project/store RLS. Optional
project/shop selectors disambiguate accounts with more than one visible project or
store. Tools impose bounded limits and return user-readable text plus structured data as
appropriate.

Every tool call passes through `abo_mcp_call`, which applies the current usage ceiling
and records the authenticated user/client combination. A client cannot evade accounting
by changing a request argument because identity comes from the token.

## Change workflows

### Warmluke-authored design

`propose_change` sends the owner's words through the same `runTurn` engine used by the
built-in chat. It persists the exact validated plans and returns a request ID plus a
deterministic human-readable description.

### Client-authored design

A capable external assistant may call `design_format`, construct plans, and iterate with
`validate_design`. `submit_design` runs the same project-aware validation and creates the
same kind of approval request without spending a Warmluke model turn.

### Decision and build

`pending_changes` must be consulted before claiming something is still awaiting a
decision. `reject_change` records a durable no. `approve_change` can build only stored
plans from the referenced request; plans are not accepted as an approval-call argument.

Approval, claim, apply, outcome, and history operations are bound to the request's
project and originating client. Concurrent calls cannot spend the approval twice.

## Auto-build

When enabled on a project, any non-empty design may be approved and applied without a
second merchant action. Module deletion is excluded from MCP entirely and still requires
first-party typed confirmation. Auto-build is therefore a broad owner-granted setting,
not an additive-change filter. Database state records whether a build was automatic; the
route does not attempt an unauthorized direct table update after building.

## Limits and exclusions

- MCP does not expose arbitrary SQL or arbitrary URLs.
- Store data is never written directly. A client may propose one of the store actions
  declared in `src/lib/store-actions.ts` through `propose_store_action`; only the merchant
  can approve it, in the application, and the database refuses an approval from a client
  token. Actions that are not declared (cancelling, refunding, fulfilling, publishing,
  repricing) have no path at all, and `check-action-registry` holds that list to the copy
  that promises it. The gates (switch, registry, Shopify ids, size, what the change needs,
  granted scopes) live once in `src/lib/store-action-propose.ts`, shared with Luke;
  `check-store-action-propose` holds them. The store lists hand out the id a change is
  aimed with: `shopify_id` on orders, products and customers (0121), `inventory_item_id`
  and `location_id` on stock.
- A connected client cannot *build* a module deletion, though it may propose one. The
  request waits in the application, where the owner types the section's name to confirm.
  Auto-build never applies such a design, `approve_change` refuses it, and `abo_build`
  refuses `module_delete` to any client token regardless. `check-removals` holds all
  three, because what it protects is the absence of a path.
- A request cannot authorize a different plan supplied at approval time.
- The client cannot approve/reject another client's request.
- A design may contain at most six plans in one application batch.
- The endpoint is stateless even though build requests and call accounting are persisted
  in the database.
