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

Every row is a link to its section's own address (`/app/<project>?section=<id>`; no
`section` is the Overview). A plain click opens it in place with `history.pushState`, so the
page does not load again; right-click, Cmd/Ctrl-click and middle-click are the browser's, so
a section opens in a new tab. The address is the one place the open section is kept: a
refresh stays on it, back and forward move between sections, and an address naming a
section that is not there (removed since, or another project's) opens the Overview and
drops the name.

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

| View       | Intended use                         |
| ---------- | ------------------------------------ |
| `table`    | Compare many fields across rows      |
| `board`    | Move work through grouped stages     |
| `calendar` | Place records on calendar dates      |
| `cards`    | Browse a catalogue-like collection   |
| `list`     | Process a compact queue or checklist |

Links store a target record UUID. `LinkContext` resolves user-facing labels from the
target section instead of copying label text into the source row.

A link may point at a section over a store's list (orders, their items, products,
customers): those rows are found as they are typed (`LinkSource.search`, twenty at a time,
asked of the server) rather than listed up front, and a store row a link points at is named
by `storeRowLabel`, never "(deleted)". Choosing a linked row in the row form fills the form
from it (`fillFromLinked` in `lib/links.ts`): a field of the same key or label takes the
row's value in its own type; what the owner typed, a computed column, a link and a field a
row keeps about itself (status, notes, reason) are never written; choosing again replaces
only what the last pick filled. A second link is narrowed by the first (`narrowFor`): a
store list by its parent's id column (`storeParents`: `order_id` is an order's), a section
of theirs by its link column to the chosen one; changing the first clears a second it no
longer fits. Nothing is configured: every section gets this from its own columns.

## Chat and design UI

`ChatPanel` renders four assistant reply shapes:

- `answer`: grounded Markdown (the `ui/Markdown` block) for store, product-help, or
  conversation questions, with a copy button under it, ending on the last reply with what
  to ask next, each a row that sends itself;
- under every reply that carries `usage`: the model that made it, and as much as the account
  is shown (its tokens; the cost in dollars, and in rupees at the ECB rate `/api/fx` gives,
  with the day it is from). Opened, each model and job apart (reply, gap check, question
  router), cache reads included; a call with no known price is said, never priced. Replies
  written before this carry none and show none;
- `clarify`: structured questions with suggestions and free-form answers: one shown
  directly, two independent ones together, otherwise one at a time with Back and Skip;
  a `multi` question takes several answers, and number keys pick while the card has focus.
  The answers go back as "Question" and "→ answer" pairs, which the owner's bubble shows
  as a short summary;
- `blueprint`: a workflow and selectable plans before a new build, one row per plan
  (its section's icon or its kind's, its name, what kind of change it is) with the detail
  behind the row; optional parts apart under "Also suggested", each with a checkbox; and a
  button that says what it builds ("Build 2 sections and a rule");
- `plans`: edits to an already-discussed application.

An empty thread offers, under "From your store", up to three asks read off the store's own
counts (`lib/suggest.ts` over `storeSignals`): its COD share, failed deliveries, refunds,
low stock, late shipments, repeat customers, abandoned carts. Each is offered only when the
store shows it and no section of theirs already meets it (by name); tapped, it is sent like
any message. They are counted once the empty welcome is on screen, once a store (`onEmpty`), not on every load. `read_section` gives the same list to an MCP client.

A section's header offers **Customize** to whoever made it (`ViewEditor`): each column's
name, whether it is on the table and where, the filters above it (only columns whose rows
give a choice: a tick, a status, a word with a few values) and the order rows open in.
Saved through `/api/apply` with `by: "user"`, as the plans Luke would send (`lib/view-edit.ts`),
so it is validated, kept as the owner's own version and put back by History; no model is
asked. A status's filter taken off the bar keeps its choices for the row form. On a section
over the store, a column keeps where the owner put it and a name they gave it (`named`).

Under a build's line, what the browser walk found on the sections it built (`walked`,
`lib/walk.ts`): "Tried in a browser on a laptop and a phone: N things, all worked", or what
did not work, each with "Fix it", which sends Luke the break in plain words.

A row button marked `approval` (a refund, a discount) goes to `/api/row-action` when
pressed, which works out the change from the row on the server. The owner's press is
made at once. A teammate sees a clock on that button, and their press waits: a note says
it went to the owner. The press shows in the owner's bell, under what waits on their yes,
as "A teammate asks", with the row named, Approve and Not this one. A teammate's hand edit
that would make the same change is refused by `lib/record-write.ts`, naming the button
(`lib/row-approval.ts`).

An answer that did something on the screen open (`show`, `lib/screen.ts`) does it as it
arrives: the section opens if it was not, its bar is set as the merchant would set it (a
view is the whole view: what it leaves out is cleared), and a row to put in opens the form
filled, under "Filled in for you", where a link given as words ("#1042") is searched as a
person would search it and picked only when one row alone answers, filling the rest as
their pick would; nothing is saved until Add row. Under the answer, "On your screen: …" in
the code's words, with Show again, and anything not done. On a phone the panel stands aside
so the section is seen. The same ask arrives as `?show=` in a link from their own AI
(`show_on_screen`), read again against the section as it opens and then taken off the
address. `e2e/screen.spec.ts` walks both.

It also renders pending MCP-originated requests, build history, turn progress, undo
controls, OAuth client connections, quotas, and feature-switch state. Plans are not
trusted merely because they arrived in the browser; `/api/apply` reloads live state and
validates them again.

Past conversations are listed by day (Today, Yesterday, Last 7 days, Older), each with
when it last moved and what it holds ("1 built · 2 answers", counted by `GET /api/chat`
from each message's type). The first thirty come with the panel and older ones on "Show
older"; once there are more than five, a search asks the server over every thread by name.
A thread can be renamed in the list; that name is kept (`named_by_owner`, 0126), and Luke's
replies no longer rename it.
While the last conversation loads, the panel shows its shape, not the empty welcome.

The model is picked under the composer when the account may use more than one
(`/api/models`): newest first, the default marked, and, where the cost is shown, each one's
price and about what a reply in this thread would come to on it, priced at the thread's
own average reply. The pick is kept on the device and sent with each turn; the server
checks it again.

## Records and writes

The store's fields on a store row cannot be edited; tapping one opens `StoreRecordDetail`,
a read-only view of the row and what belongs to it. A section over a store list may also
carry the merchant's own fields ("packed", "shelf"): columns of its schema that are not the
list's (`ownColumns` in `store-read.ts`). They sit in a record of the section pointing at the
row (`records.store_row_id`, 0128), laid over the store's rows as they load
(`withOwnFields`; the store's value wins a shared name, and `abo_section_stats` counts the
same rows), set by row actions and the scan
bar, and edited under "Your fields" in `StoreRecordDetail`. `/api/records` writes them with
`update_store_row` and refuses every other action on a store section: no row is added to or
taken from the store's list here. A list whose rows have no id of their own (return
reasons) carries none. `RecordModal` derives its inputs from schema columns. Before
`/api/records` writes a row, the server reloads the latest schema and removes undeclared
keys. Computed columns are not writable.

Staff members may read, insert, and update owner-managed records. Only owners may delete
records or change the application's design.

## Realtime behavior

`src/lib/live.ts` wraps Supabase channels. The shell and panels subscribe to relevant
tables so externally initiated changes are reflected in the open application. Realtime
is an invalidation mechanism: after a signal, the browser reloads authoritative rows;
it does not reconstruct complex state from event payloads alone. The changed row is
handed to the callback only so it can decide _what_ to reload.

Published tables are `modules`, `ui_schemas`, `records`, `build_requests`,
`conversations`, and `store_actions` (0122; it was listened for but never published, so a
change an assistant asked for only appeared on reload). The chat panel also reloads the
waiting changes when a turn reports a `proposed` step, so Luke's own request appears even
if the channel has dropped. Subscriptions:

| Subscriber | Table            | Reload                               |
| ---------- | ---------------- | ------------------------------------ |
| Shell      | `modules`        | Section list                         |
| Shell      | `records`        | Open section's rows                  |
| Shell      | `ui_schemas`     | Open section's design                |
| Shell      | `conversations`  | Thread list, and the affected thread |
| Chat panel | `build_requests` | Pending request queue                |

Every writer of a message advances its conversation's `updated_at`, so one subscription
on `conversations` covers the built-in assistant, external-assistant builds, and undo.
When the signalled thread is the open one, the shell reloads it in place. When it is a
different thread — in practice the one external builds are filed in — the shell opens it,
which is what a manual refresh would have done, unless a turn is in flight, the thread
on screen ends in a card still awaiting the merchant's answer, or the signalled thread's
`updated_at` did not move (a rename, which is nothing new to read), or it is a thread this
tab asked something in and left: its answer waits there, and the owner is never taken back
to it. While Luke answers in a thread they left, the one on screen says so with a way back,
and the answer is never put into the thread on screen.

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

`/onboarding` has three visible steps: about you (name, business, role, orders a month,
platform, and optionally website, team size and where they heard of Warmluke); the store
(one-tap connect, typed address or a link for another browser, or later); and ready.
Their own AI is not asked about here (9 Oct): the app offers it under "Use your own AI".
After "Open Warmluke", a new owner's app opens on the first conversation with Luke (0200):
`AppShell` reads `profiles.met_luke_at` and, while it is empty, shows `ChatPanel` alone and
full width (`meeting`), with no sidebar, section, panel controls or way past him. Luke
speaks first; "Open my store" appears once he has answered from their store or built
something, and entering moves him into the side panel with the same thread, the store rising
in beside him, the tour after. A refresh or another device resumes the same thread.
While a newly connected store imports, a
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
- A project's own sections, Luke's prompt and the screens Luke writes use one money and number
  style, `projectFormat` in `lib/money.ts`: the currency the owner chose in Project settings,
  otherwise the connected Shopify store's (its currency, numbers as its country writes them),
  otherwise the defaults. Nothing assumes a country: a shop in dollars reads in dollars.
- Time on a rule is the store's own clock, the `iana_timezone` Shopify gives at connect.
- When adding a view, column type, action, or expression, update the capability registry,
  validator, renderer/evaluator, database evaluator when applicable, and parity checks.
- Large coordinator components should be refactored by behavior boundary, not by moving
  arbitrary JSX fragments that still depend on shared state.
- An internal id (a row's, a section's, a thread's) is never shown. Text the app does not
  write itself (Luke's replies, step lines, validator errors, request summaries) passes
  through `withoutIds` in `lib/no-ids.ts`, which names a section's id and takes out any
  other; `Markdown` does it for every reply. A cell or field whose value is only an id reads
  "—", and the scan bar tells rows apart by what their columns show. `check-no-ids`.
- Luke's model picker lists the newest model of each kind, plus the one in use and the
  default, with the rest behind "Older models"; each row is one short price line, the full
  rate in its title.
- A thread the owner chose (opened, started, sent in) is never replaced by a load that set
  out before it (`threadChosen` in `AppShell`): the newest thread opened on arrival used to
  come back after "New conversation" on a slow link and take the question.
