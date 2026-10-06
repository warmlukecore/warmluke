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

| Tool              | Purpose                                                                                                                                                                                                                                                                                                                                                                      |             Mutates state? |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------: |
| `ask_store`       | Route a natural-language store question to the relevant list/window                                                                                                                                                                                                                                                                                                          |                         No |
| `store_overview`  | Store identity, timezone, currency, sync time, counts, and whether any resource is still importing                                                                                                                                                                                                                                                                           |                         No |
| `search_orders`   | Filter orders by date, status, or customer/order search                                                                                                                                                                                                                                                                                                                      |                         No |
| `get_order`       | Read one order with its items                                                                                                                                                                                                                                                                                                                                                |                         No |
| `search_store`    | Read a supported canonical store list                                                                                                                                                                                                                                                                                                                                        |                         No |
| `low_stock`       | Read inventory at or below a threshold                                                                                                                                                                                                                                                                                                                                       |                         No |
| `store_metrics`   | A figure over the whole store: a measure by a dimension in a window (revenue by week, orders by city, new customers this month), counted in the database                                                                                                                                                                                                                     |                         No |
| `read_section`    | List/inspect generated sections and owner-managed rows (a section over the store: the store's rows with the merchant's own fields beside them); with `history`, the section's version history instead. Listed with no section, it also returns `suggested_from_the_store`: what the store's own numbers make worth building (`lib/suggest.ts`), as asks for `propose_change` |                         No |
| `how_to_help`     | The guide their AI is given on connecting (below), for a client that does not read server instructions, with its version                                                                                                                                                                                                                                                     |                         No |
| `edit_view`       | How a section looks, with nothing designed or charged: names, columns on or off the table, their order, filters, the order rows open in (`lib/view-edit.ts`, the same as Customize in the app). Waits for the merchant's yes like any change, or builds at once with automatic builds on                                                                                     |     Creates a request only |
| `show_on_screen`  | A link that opens one of their sections the way they asked to see it (search, its own filters, a sort, its dates), or with a new row's form filled from details they gave (a customer's message), checked by the code Luke's answers go through (`lib/screen.ts`); what the section does not have comes back as `not_done`. The form waits for their own Add row             |                         No |
| `undo_build`      | Reverse a build this client made, from what that build recorded                                                                                                                                                                                                                                                                                                              |                        Yes |
| `propose_change`  | Run Warmluke's design engine and create an approval request                                                                                                                                                                                                                                                                                                                  |     Creates a request only |
| `pending_changes` | Read requests currently awaiting a decision; also `waiting_button_presses`, a teammate's press of a row button that waits for the owner (0183), listed so their AI can say it waits, never decide it                                                                                                                                                                         |                         No |
| `build_history`   | Read completed, partial, or dismissed build history                                                                                                                                                                                                                                                                                                                          |                         No |
| `reject_change`   | Record the merchant's rejection of the client's request                                                                                                                                                                                                                                                                                                                      |         Request state only |
| `design_format`   | Read the supported plan/capability contract                                                                                                                                                                                                                                                                                                                                  |                         No |
| `validate_design` | Validate client-authored plans without submitting them                                                                                                                                                                                                                                                                                                                       |                         No |
| `submit_design`   | Submit already-authored valid plans for merchant approval                                                                                                                                                                                                                                                                                                                    |     Creates a request only |
| `approve_change`  | Apply a previously stored and approved request                                                                                                                                                                                                                                                                                                                               | Yes, through build gateway |

Tool descriptions tell clients to use inline SVG for charts in artifacts and to propose
a persistent Warmluke section when the merchant wants the result retained.

The seven store-reading tools (`ask_store` through `store_metrics`) are declared once, in
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

Every tool call passes through `abo_mcp_record` (0180; `abo_mcp_call` before it), which
applies the current usage ceiling and records the authenticated user/client combination,
with the guide's version. Once the answer has gone, its outcome is read off the answer
itself (`outcomeOf` in `lib/client-guide.ts`: the status it said, `luke changed it`, an
error, or answered, with how many problems it listed) and kept on the same row by
`abo_mcp_outcome`. A connection and a prompt asked for are recorded too. The console's
**Their AI** screen reads it back by guide, by week and by tool. A client cannot evade accounting
by changing a request argument because identity comes from the token.

## What their AI is told

On `initialize` the server's `instructions` are a guide (`lib/client-guide.ts`, 5 Oct),
built from what Luke itself works to, so the merchant's own AI designs as Luke would
rather than be sent back by Luke's checks:

- how to help: hear the problem in their words, read before changing, say the plan back
  in plain words and build on their yes;
- the simpler builds, from the very list the simplicity reviewer reads (`SIMPLER_WAYS`,
  `REAL_WORK` in `lib/reviewers.ts`), edit_view for how a section looks, and
  show_on_screen for seeing rows a certain way or putting one in;
- what the shop allows, from the store-actions registry;
- every tool, by the first sentence of its own description;
- then this merchant: their apps and sections, and what Luke has learned about how they
  work (`luke_skills`), said as facts and never as instructions.

`how_to_help` returns the same guide. `prompts/list` and `prompts/get` offer ready-made
asks (what to build, what needs them today, change how a section looks, fix a section,
what runs on its own), whose words are built at the time asked: "what to build" carries
the store's own numbers (`lib/suggest.ts`). The guide's version is a hash of everything
but the merchant's part (`guideVersion`), so a change to a shared rule, a tool's words or
a prompt makes a new version by itself, and each call is recorded under it.
`check-client-guide` (pure) holds that the guide carries the reviewer's list, names only
tools there are, and moves its version with our words and never a merchant's.

## Change workflows

### Warmluke-authored design

`propose_change` sends the owner's words through the same `runTurn` engine used by the
built-in chat. It persists the exact validated plans and returns a request ID plus a
deterministic human-readable description.

Each ask is a conversation of its own in the merchant's Luke panel, marked with the
assistant that asked (migration 0139: `conversations.asked_by`, `asked_client`), and runs
as Luke's turn does: durably (`workflows/luke-turn.ts`) when `LUKE_WORKFLOW=1` and the
client's token has time left, otherwise inside the request, held open past its answer.
A client's token may not write conversations or messages, so two definer functions write
for it, scoped to its own threads: `abo_client_ask` keeps the question and a line for its
answer (the same words again within 30 minutes are handed the ask already made, not a
second design), and `abo_client_settle` fills that line once, only as an answer, a
question, a failure or a build, never as a design card.

The turn ends in `lib/client-turn.ts`: a design is settled as a request
(`lib/client-design.ts`, shared with `submit_design`) and built at once if the merchant
turned automatic builds on, recorded on the line with its undo; a question is shown to the
merchant in the thread and returned with a `conversation_id` to carry on in; a failure says
why in both places; a stop in Warmluke requests nothing. The assistant's own answer is kept
on the line. `propose_change` waits 40 seconds (`MCP_DESIGN_WAIT_MS`) for it and otherwise
answers `still designing`; `pending_changes` lists `your_asks` (still designing, needs
answers, failed, or carried on in Warmluke) until they become requests.

### What the account is shown

Every tool call runs inside what the account is shown of the store's lists (0192): an
administrator may narrow a list to some of its columns, per account. `read_section` gives
only those columns and rows cut to them, the store tools' rows leave the others out,
`design_format`'s `store_columns` and `store_advice` name only those, and
`store_columns_not_shown` says which lists are narrowed so the assistant says a column is not
shown rather than guess. The app the call names (`project_id`), or the account's only app,
or one it owns, decides. Listed with no section, `read_section` also says which sections are
`new_to_them` (0191): made and not opened yet, or changed since they last looked.

### Client-authored design

A capable external assistant may call `design_format`, construct plans, and iterate with
`validate_design` (free and at once: the validator and the free checks, `heads_up`, and the
tryout, `tried_as_used`: the design used as the merchant will on their own rows, with what
would break, notes and what a linked row fills; `lib/tryout.ts`).
`submit_design` puts the design through everything Luke's own designs go through (5 Oct).
What the validator refuses goes back to the assistant that wrote it, free and at once: its
own shape to fix. A design that holds is run as Luke's turn in a thread of its own, with the
design as the first attempt (`givenDesign`), so the critic and the reviewers read it and Luke
fixes what they find, with the business's context the outside assistant lacks. The answer says under
`checked_by_luke` whether Luke changed it and why; past the wait it is `still designing`,
like `propose_change`. It spends none of the merchant's included designs. Up to 20 a day
for each app (`DRAWN_REVIEWED_A_DAY`); past that, the validator alone, as before. `design_format`
carries the plan's shape, `linked_rows` (a link fills the merchant's form from the row chosen and narrows a second link to it, so a section beats a written screen that copies a row), and the same guides Luke designs by, from the same constants:
`written_screens` (`CUSTOM_VIEW_GUIDE`: `window.wl`, the kit) and `code_rules`
(`CODE_RULE_GUIDE`: what a rule's code is handed, the store's clock, `next`). When the
assistant passes the merchant's own words as `request`, the submitted design goes through
Luke's gap pass and carries what it leaves out, as Luke's designs do.

### The design drawn in the assistant

Hosts that speak MCP Apps (2026-01-26: Claude, ChatGPT, VS Code, Goose) draw a page a
server hands them beside a tool's answer. `initialize` declares the extension
`io.modelcontextprotocol/ui`; `resources/list` and `resources/read` serve
`ui://warmluke/design` (`text/html;profile=mcp-app`, `lib/design-view`); `propose_change`
and `submit_design` name it in `_meta.ui.resourceUri` (and `openai/outputTemplate`). Each
design's answer carries `structuredContent.design`: every part's words, the fields it shows
and a few rows of the section it changes, and a written screen, which the page runs
read-only over those rows. The page loads nothing, follows the host's theme, and opens the
design in Warmluke through the host. Text stays the whole answer for any other client.
`check-byo-design` holds the server's side; `e2e/mcp-view.spec.ts` the page, against a
stand-in host speaking the protocol.

### Connecting an assistant

Any assistant that connects to remote MCP servers with OAuth can connect: the sign-in
registers clients itself (dynamic client registration), which ChatGPT requires. The panel's
"Use your own AI" lists the steps for ChatGPT, Claude, Claude Code, Cursor, VS Code and any
other from one list, `lib/connect-assistants.ts`.

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
- A connected client cannot _build_ a module deletion, though it may propose one. The
  request waits in the application, where the owner types the section's name to confirm.
  Auto-build never applies such a design, `approve_change` refuses it, and `abo_build`
  refuses `module_delete` to any client token regardless. `check-removals` holds all
  three, because what it protects is the absence of a path.
- A request cannot authorize a different plan supplied at approval time.
- The client cannot approve/reject another client's request.
- A design may contain at most six plans in one application batch.
- The endpoint is stateless even though build requests and call accounting are persisted
  in the database.
