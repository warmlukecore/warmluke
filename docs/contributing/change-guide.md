# Change guide

This guide maps common changes to their real implementation surface. Read the relevant
installed Next.js 16 guide in `node_modules/next/dist/docs/` before changing Next.js APIs
or conventions; this repository intentionally does not assume older Next.js behavior.

## Before changing code

1. Read `AGENTS.md` and the relevant document in this directory.
2. Inspect the current implementation and its callers with `rg`.
3. Read the latest migration that defines any function/table you will modify—not only
   the migration that first introduced it.
4. Identify the relevant `check-*.mjs` coverage.
5. Keep unrelated user changes intact.

## Add a platform capability

Examples: a column type, view, expression operator, statistic, trigger, or action.

Review and usually update:

- `src/lib/capabilities.ts`
- `src/lib/types.ts`
- prompt/parser/validator portions of `src/lib/ai.ts`
- browser evaluator/renderer (`expr.ts`, `GenericRenderer.tsx`, `views.tsx`)
- PostgreSQL evaluator/automation migration when server evaluation is involved
- `describe.ts` for approval language
- operator/design/gate checks
- AI builder, domain, frontend, and decision documentation

Never advertise a capability only in prompt prose. The registry, validator, executor,
renderer, and descriptions must agree.

## Add or change a plan type

Update the `ChangeType`/`AssistantPlan` contract, plan format, parser, validation, plan
description, `validateAndApply`, `abo_build` operation if required, result/undo metadata,
and both built-in and MCP flows. Decide explicitly:

- whether a blueprint is required;
- whether auto-build may apply it;
- whether an OAuth client may apply it;
- how partial failure is compensated;
- whether and how a completed build can be undone.

## Add a database table or RPC

1. Add the next sequential migration.
2. Enable RLS immediately.
3. Add owner/member policies intentionally; absence must be deliberate.
4. Add restrictive OAuth-client write guards for public tables.
5. For security-definer functions, set a controlled `search_path`, revoke public
   execution, grant only required roles, and re-check caller identity/ownership inside
   the function.
6. Notify PostgREST after replacing functions.
7. Add isolation and adversarial live checks.
8. Update the domain/security/API documentation.

Do not edit `supabase/schema.sql` as if it were a current snapshot. It is the immutable
historical base for new-project reconstruction.

## Add a Shopify resource

Add one entry to `SHOPIFY_RESOURCES` and implement the resource-specific query/types/save
logic in `shopify-import.ts`. Declare:

- scopes;
- count/page/bulk queries;
- root field and bulk assembler;
- child limits;
- save function;
- webhook topics;
- written tables;
- drift behavior.

Then add schema/RLS/views, webhook database handling, store-read exposure where desired,
and page/bulk/webhook/drift checks. Derived scope/topic/import/progress lists should not
be hard-coded elsewhere.

## Add an MCP tool

Define a bounded input schema and clear tool description in `/api/mcp`. Route it through
the call-accounting gate, select project/store under RLS, cap returned data, and decide
whether it is read-only, request-state-only, or a true build operation.

A mutating tool must not become a generic table-write escape. Reuse the request approval
and `abo_build` path, bind operations to the token's client identity, and add OAuth-client
tests.

## Change authentication or authorization

Treat browser redirects as UX only. Trace the bearer token through `getUserClient`, the
PostgREST client, RLS predicates, restrictive OAuth policies, and security-definer RPCs.
Test at least owner, member, second merchant, anonymous, and OAuth-client identities as
relevant.

## Change the frontend

Start from the owning state boundary:

- project cards/settings/store connect: dashboard;
- module/record/schema/realtime coordination: `AppShell`;
- assistant/design/request UI: `ChatPanel`;
- generic fields/features/views: renderer and `views.tsx`;
- import progress: `StoreStrip`.

Preserve accessibility labels, loading/error states, mobile layout, and the distinction
between owner-managed and store-backed data. For a Next.js convention, read the installed
version's guide before coding.

## Add a check

Name it `scripts/check-*.mjs`; the runner will discover it. Let its actual dependencies
determine its tier:

- deterministic/local: pure;
- database/server: live;
- paid/non-deterministic generation: model.

Avoid production credentials and clean up created test state. If it needs the management
PAT, keep that need explicit so CI skips it and pre-push selects it.

## Definition of done

- Behavior and security decisions are enforced outside model prose/UI hiding.
- Targeted checks pass.
- `pnpm typecheck` passes.
- `pnpm build` runs for routing/configuration/client-boundary changes.
- `pnpm check:pure` passes.
- Relevant live checks pass against the isolated project.
- Documentation is updated with `$update-readme-agent`.
- The final diff contains no credentials, generated noise, or unrelated changes.
