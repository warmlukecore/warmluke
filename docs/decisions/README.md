# Architecture decisions

These records summarize decisions already embodied in code and migration history. They
are not a substitute for the owning implementation. Add a focused ADR when a future
change reverses one of these decisions or introduces a comparable long-lived trade-off.

## ADR-001: Business behavior is declarative data

**Decision:** Models emit validated schemas, features, expression trees, and plans rather
than executable code.

**Why:** Generated code would expand the execution and security surface for every
merchant request. A closed vocabulary makes rendering, validation, explanation, and
database execution inspectable.

**Consequence:** New capabilities require coordinated platform work; a model cannot
invent an unsupported workaround.

## ADR-002: Adaptive records and commerce records use different models

**Decision:** Owner-defined sections use generic JSONB records; Shopify commerce uses
canonical relational tables and views.

**Why:** Adaptive workflows require flexible shapes, while synchronized commerce data
requires stable semantics, relationships, queries, webhooks, and privacy behavior.

**Consequence:** Store-backed modules reference canonical views and remain read-only.

## ADR-003: UI schemas are append-only versions

**Decision:** Every design change writes a new `ui_schemas` version. Restoration also
writes a new version.

**Why:** Rewriting an old row would erase what actually happened and make audit/undo
ambiguous.

**Consequence:** Readers select the latest version; storage grows with design history.

## ADR-004: The database owns authorization

**Decision:** RLS and narrow security-definer functions are the final authority.

**Why:** Multiple entrances—browser, Next routes, OAuth clients, callbacks, and direct
PostgREST—cannot safely depend on each UI remembering the same rules.

**Consequence:** Server routes use caller-scoped clients; database migrations and
adversarial checks are part of every authorization change.

## ADR-005: OAuth AI clients are read-only except through approved requests

**Decision:** A JWT containing `client_id` is blocked from table writes by restrictive
policies. Approved builds pass through `abo_build`.

**Why:** Supabase OAuth otherwise grants a normal user session, making an apparently
read-only MCP server insufficient protection.

**Consequence:** Every legitimate client mutation needs an explicit, audited RPC path and
client/request binding.

## ADR-006: The blueprint contains the actual plans

**Decision:** The plan shown to the merchant is stored and applied; approval does not
trigger fresh plan generation.

**Why:** Regenerating after approval allows the promise and resulting application to
drift.

**Consequence:** Human-readable descriptions are derived from plans, and request rows
persist exact plans.

## ADR-007: Plan application uses compensation

**Decision:** Each builder write uses the common RPC gateway. A multi-plan failure replays
recorded inverse operations in reverse order.

**Why:** PostgREST calls cannot hold one transaction open across the whole application
batch.

**Consequence:** Practical atomicity depends on complete inverse metadata; irrecoverable
effects must be surfaced, never hidden.

## ADR-008: Undo protects later work

**Decision:** Undo refuses restoration when a schema/module has changed again and removes
seeded rows only when untouched.

**Why:** Blindly restoring an older snapshot can erase newer human or automation work.

**Consequence:** Some old builds intentionally become non-undoable without manual
intervention.

## ADR-009: Shopify import is resumable and registry-driven

**Decision:** Resource metadata is centralized; imports advance in bounded requests and
switch between paging and bulk operations.

**Why:** Repeated resource lists drift, and one serverless request cannot import a large
store reliably.

**Consequence:** New resources must fully declare scopes, query paths, limits, writes,
topics, and drift behavior.

## ADR-010: Shopify drift is named after one pass and removed after two

**Decision:** Every write marks its row seen (migration 0123). A row the last finished pass
did not see is named on the store strip; a row two finished passes in a row did not see is
removed, the way a delete webhook removes it. Rows no pass could have seen are never
counted: one that arrived after the pass began, and orders outside the sixty days Shopify
returns without `read_all_orders`.

**Why:** Missed pages, truncated files and outages look like a deletion once; the same rows
missing from two finished passes is one. Reporting alone, the decision this replaces, left
deleted rows on screen for good under a warning nothing could clear.

**Consequence:** A row removed by mistake returns with the next pass that brings it, under a
new internal id, so anything that pointed at the old id loses it. Revised 2026-09-26; it
was "reported, never deleted".

## ADR-011: MCP transport is stateless

**Decision:** The MCP endpoint answers each JSON-RPC request independently and implements
neither SSE nor durable server sessions.

**Why:** The current tools need no server-owned conversational state; database records
already preserve approvals, history, and accounting.

**Consequence:** Clients receive no server-initiated notifications and must query pending
changes/history when needed.

## ADR-012: Store questions are grounded before generation

**Decision:** The server reads bounded store context and an optional routed slice before
calling the model.

**Why:** Authorization and evidence remain properties of code, and providers with or
without native tool support behave consistently.

**Consequence:** One turn cannot arbitrarily explore the whole store; routing and snapshot
limits determine what can be answered faithfully.

## ADR-013: Verification is tiered by dependency and cost

**Decision:** Checks are discovered automatically and classified as pure, live, or model.

**Why:** Deterministic checks should gate every change; database checks need isolation;
paid model checks should not make ordinary pushes flaky.

**Consequence:** CI and pre-push have complementary responsibilities, and model evaluation
remains a deliberate run.
