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

- `answer`: grounded prose for store, product-help, or conversation questions;
- `clarify`: structured questions with suggestions and free-form answers;
- `blueprint`: a workflow and selectable plans before a new build;
- `plans`: edits to an already-discussed application.

It also renders pending MCP-originated requests, build history, turn progress, undo
controls, OAuth client connections, quotas, and feature-switch state. Plans are not
trusted merely because they arrived in the browser; `/api/apply` reloads live state and
validates them again.

## Records and writes

`RecordModal` derives its inputs from schema columns. Before `/api/records` writes a
row, the server reloads the latest schema and removes undeclared keys. Computed columns
are not writable. Store-backed rows are read-only in the application.

Staff members may read, insert, and update owner-managed records. Only owners may delete
records or change the application's design.

## Realtime behavior

`src/lib/live.ts` wraps Supabase channels. The shell and panels subscribe to relevant
tables so externally initiated changes are reflected in the open application. Realtime
is an invalidation mechanism: after a signal, the browser reloads authoritative rows;
it does not reconstruct complex state from event payloads alone.

## Marketing and onboarding

`src/proxy.ts` assigns the landing-page hero before rendering and forwards the chosen
variant through a request header. A stable HTTP-only cookie remembers the assignment.
Campaign parameters may select a specific hero. Landing events are written through the
server action or browser client and rate-limited in PostgreSQL.

A prompt entered before authentication is stored temporarily in browser storage. After
signup/login, the dashboard creates a project, transfers the prompt to the builder, and
opens the assistant.

## UI maintenance notes

- Preserve the boundary between display filtering and server-wide statistics. A stat is
  over the section, not only the currently loaded page.
- Keep store money in its source currency; conversion is a secondary dated estimate.
- When adding a view, column type, action, or expression, update the capability registry,
  validator, renderer/evaluator, database evaluator when applicable, and parity checks.
- Large coordinator components should be refactored by behavior boundary, not by moving
  arbitrary JSX fragments that still depend on shared state.
