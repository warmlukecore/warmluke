# Frontend architecture

## Rendering model

The marketing home page, legal pages, and root layout use the App Router's server
rendering where practical. Authentication, dashboard, administration, builder, and all
interactive components are client components.

The builder route (`/app/[projectId]`) authenticates in the browser and renders
`AppShell`. The server APIs still verify every bearer token and the database still
applies RLS; the client-side redirect is user experience, not authorization.

## Application shell

`src/components/AppShell.tsx` is the builder's coordinator. It owns:

- project, owner/member, store, and currency-conversion context;
- module navigation, nesting, collapse state, and drag ordering;
- current schema, schema history, records, link options, and pagination;
- current conversation, thread list, streamed turn progress, and build state;
- settings, history, automation, record, scan, and chat panels;
- Supabase Realtime subscriptions and post-build refreshes.

The shell loads current module data differently by source:

- ordinary modules read `records` and the latest `ui_schemas` version;
- store-backed modules read a canonical store view through `store-read.ts` and combine
  its fixed columns with saved computed columns and presentation features.

## Navigation

The sidebar is grouped by where rows come from:

- **Overview**, when the project has a store: the store's figures (`Overview.tsx`).
- **Store**: sections whose `source_table` is a store list. When there are none yet, the
  owner is offered orders, products, customers and stock in one tap; the + opens
  `StorePicker` for any other list.
- **Your sections**: what the merchant built, by hand or with Luke.

Search covers both groups, and dragging reorders within a group only. The foot of the
sidebar holds the store switcher and the store's status line (`StoreStrip`): connected
and when it last synced, the import while it runs, and anything that needs the owner.

## Schema-driven renderer

`GenericRenderer` receives rows and the latest `UiSchema`. It applies:

- computed expressions;
- text search and declared filters;
- sorting;
- section-wide server statistics for store-backed or paginated data;
- record editing for owner-managed modules;
- row actions and scan actions;
- one of the supported views.

Supported views are declared in `src/lib/capabilities.ts` and implemented in
`src/components/views.tsx`:

| View | Intended use |
| --- | --- |
| `table` | Compare many fields across rows |
| `board` | Move work through grouped stages |
| `calendar` | Place records on calendar dates |
| `cards` | Browse a catalogue-like collection |
| `list` | Process a compact queue or checklist |

Links store a target record UUID. `LinkContext` resolves user-facing labels from the
target section instead of copying label text into the source row.

## Chat and design UI

`ChatPanel` renders four assistant reply shapes:

- `answer`: grounded Markdown (the `ui/Markdown` block) for store, product-help, or
  conversation questions, ending on the last reply with what to ask next, each a row that
  sends itself;
- `clarify`: structured questions with suggestions and free-form answers: one shown
  directly, two independent ones together, otherwise one at a time with Back and Skip;
  a `multi` question takes several answers;
- `blueprint`: a workflow and selectable plans before a new build;
- `plans`: edits to an already-discussed application.

It also renders pending MCP-originated requests, build history, turn progress, undo
controls, OAuth client connections, quotas, and feature-switch state. Plans are not
trusted merely because they arrived in the browser; `/api/apply` reloads live state and
validates them again.

## Records and writes

Store rows cannot be edited; tapping one opens `StoreRecordDetail`, a read-only view of
the row and what belongs to it. `RecordModal` derives its inputs from schema columns. Before `/api/records` writes a
row, the server reloads the latest schema and removes undeclared keys. Computed columns
are not writable. Store-backed rows are read-only in the application.

Staff members may read, insert, and update owner-managed records. Only owners may delete
records or change the application's design.

## Realtime behavior

`src/lib/live.ts` wraps Supabase channels. The shell and panels subscribe to relevant
tables so externally initiated changes are reflected in the open application. Realtime
is an invalidation mechanism: after a signal, the browser reloads authoritative rows;
it does not reconstruct complex state from event payloads alone. The changed row is
handed to the callback only so it can decide *what* to reload.

Published tables are `modules`, `ui_schemas`, `records`, `build_requests`,
`conversations`, and `store_actions` (0122; it was listened for but never published, so a
change an assistant asked for only appeared on reload). The chat panel also reloads the
waiting changes when a turn reports a `proposed` step, so Luke's own request appears even
if the channel has dropped. Subscriptions:

| Subscriber | Table | Reload |
| --- | --- | --- |
| Shell | `modules` | Section list |
| Shell | `records` | Open section's rows |
| Shell | `ui_schemas` | Open section's design |
| Shell | `conversations` | Thread list, and the affected thread |
| Chat panel | `build_requests` | Pending request queue |

Every writer of a message advances its conversation's `updated_at`, so one subscription
on `conversations` covers the built-in assistant, external-assistant builds, and undo.
When the signalled thread is the open one, the shell reloads it in place. When it is a
different thread — in practice the one external builds are filed in — the shell opens it,
which is what a manual refresh would have done, unless a turn is in flight or the thread
on screen ends in a card still awaiting the merchant's answer.

Commerce tables are deliberately not published; a store-backed section refreshes when the
tab regains focus instead, because publishing every webhook row is not free on a large
catalogue.

## Marketing and onboarding

`src/proxy.ts` assigns the landing-page hero before rendering and forwards the chosen
variant through a request header. A stable HTTP-only cookie remembers the assignment.
Campaign parameters may select a specific hero. Landing events are written through the
server action or browser client and rate-limited in PostgreSQL.

A prompt entered before authentication is stored temporarily in browser storage.

After sign-in the dashboard reads the person's `profiles` row. Anyone who has not
finished onboarding goes to `/onboarding` first, except a person who only works in
somebody else's app through an invite, and Warmluke's own team (administrators), who are
not a business signing up; they can still open `/onboarding` by hand to see it. The
accounts screen marks them "Warmluke team" and leaves them out of its figures. A failed
read never blocks the dashboard. A person joining by invite is asked one short question
on `/join` (their name, and what they do on the team); the owner sees it on the seat, and
the accounts screen shows whose app they joined and who invited them.

A customer invited by an administrator opens `/start/<token>`: a sign-up with their email
(locked when the invite names one), name and business already known, then onboarding
with those answered. An address that already has an account is offered sign-in instead,
and comes back to take the invite. A link that ran out, was used or was withdrawn says
which, and what to do.

Across every page, `ConnectionWatch` notices the connection dropping: a small panel says
nothing is lost, with a game to pass the wait, and does not cover the page. The way back
is confirmed by asking the site for its icon; then it says so, and the screens that
re-read their data on coming back into view are told to. `not-found.tsx`, `error.tsx` and
`global-error.tsx` replace Next's bare defaults, with a reference to quote rather than the
error's own words. The
landing-page prompt waits until onboarding is done, then opens in their project with the
assistant.

`/onboarding` has four visible steps: about you (name, business, role, orders a month,
platform, and optionally website, team size and where they heard of Warmluke); the store
(one-tap connect, typed address or a link for another browser, or later); their own AI
(the MCP address, noticed automatically when it connects, or later; shown only when the
account has it switched on); and ready. While a newly connected store imports, a
"preparing" state shows its progress. Which step is shown is computed from what is true
(`src/lib/onboarding.ts`), so leaving midway resumes at the first missing thing. Saving
the answers creates a project named for the business if the person has none. Leaving for
Shopify sets a one-hour note in browser storage; the app page sees it on
`?shopify=connected` and sends the person back to finish.

Screens are drawn from the [design system](../design/design-system.md).

## UI maintenance notes

- Preserve the boundary between display filtering and server-wide statistics. A stat is
  over the section, not only the currently loaded page.
- Keep store money in its source currency; conversion is a secondary dated estimate.
- When adding a view, column type, action, or expression, update the capability registry,
  validator, renderer/evaluator, database evaluator when applicable, and parity checks.
- Large coordinator components should be refactored by behavior boundary, not by moving
  arbitrary JSX fragments that still depend on shared state.
