# Testing strategy

## Check discovery

Every `scripts/check-*.mjs` file is a check. `scripts/run-checks.mjs` discovers them from
the directory, classifies them from their dependencies, and executes them sequentially.
There is no manually maintained test list to forget to update.

At this documentation checkpoint there are 67 checks:

- 19 pure
- 46 live
- 2 model

Use `pnpm check:list` for the current count and classification.

## Tiers

### Pure

Pure checks require no live database or application server. They cover deterministic
contracts such as:

- AI plan/feature validation and safety gates;
- expression/operator parity declarations;
- error normalization and recovery prompts;
- landing variant resolution;
- question routing behavior;
- gap/judge input behavior with local stubs;
- Shopify HMAC/OAuth/import helpers;
- bulk-file family handling;
- filter and money behavior;
- undo metadata/rollback logic;
- migration numbering and structure.

Run with:

```bash
pnpm check:pure
```

### Live

Live checks use the isolated Supabase project and/or a server on port 3100. They cover:

- tenant and staff RLS;
- OAuth-client write refusal and revocation;
- approved build claims and application outcomes;
- request history, rejection, automatic-build gates, and undo;
- conversation reload/window/streaming;
- admin switches and turn ledger, demo requests readable only by an administrator,
  suspending, restoring and deleting an account, and invites to start (made, read,
  taken by their own email once, shortened and withdrawn);
- that no security definer function is open to the public key without a guard (PAT);
- the landing's event cap, which never lets browsing use up a demo booking's room;
- Shopify import, webhooks, drift, canonical views, statistics, totals, refunds, variants,
  order items, and fulfillments;
- store-token secrecy and webhook authorization.

Run with:

```bash
pnpm check:live
# or
node scripts/run-checks.mjs --tier live --env .env.check.local
```

Some security checks require `SUPABASE_ACCESS_TOKEN` to execute raw SQL as different
roles. That token is account-wide and stays local; `scripts/hooks/pre-push` selects these
checks automatically.

### Model

Model checks exercise actual design behavior and can cost money or vary across runs.
They are intentionally manual/nightly rather than merge gates.

```bash
node scripts/run-checks.mjs --tier model --env .env.check.local
```

## Runner behavior

- Checks run sequentially because live checks share a seeded user and usage budget.
- TypeScript-importing scripts run through the repository's strip-types hook.
- A missing server is a clear runner-level error, or an explicit skip with `--no-server`.
- A server connected to a different Supabase project is rejected.
- Checks requiring a management token or manually supplied JWT say why they were skipped.
- Failure output is summarized around useful error markers instead of dumping every log.

## CI and pre-push split

CI runs dependency audit, typecheck, build, pure checks, migrations/seeding, and the live
tier against the check project. The pre-push hook repeats pure checks and adds PAT-only
security checks that CI must not hold credentials for.

Install the hook once:

```bash
pnpm hooks
```

## Choosing coverage for a change

| Change | Minimum targeted verification |
| --- | --- |
| Capability/type/validator | Pure design and gate checks; operator parity if expressions change |
| Renderer or record behavior | Typecheck/build plus targeted live record/section checks |
| RLS/table/RPC | Migration check, RLS/OAuth guards, second-merchant test, targeted live scenario |
| MCP tool | MCP limit/client test, tool-specific live check, approval tests if mutating |
| Shopify resource | Registry/bulk pure checks plus import, webhook, drift, and store-view live checks |
| Undo/build result | Rollback pure check plus apply/outcome/put-back live checks |
| Conversation streaming | Stream, reload, and window checks |
| Environment/build config | Production build and CI workflow review |
| Screen styling | Typecheck, pure checks, build, and screenshots at desktop and phone width ([design system](../design/design-system.md)); `check-tone` for badge meaning |
| Onboarding or profiles | `check-onboarding` (pure) and `check-profiles` (live) |
| Admin screens | `check-admin` (live); `check-follow-up` (pure) for the CSV formula guard and the demo stages against 0120 |
| Model calls | `check-model-errors` (pure): each provider's request as sent, the one-sentence failures, one attempt, the Gemini fallback |
| Store tools | `check-store-tools` (pure) for one declaration and refusals before reads; `check-ask-store`, `check-leaders`, `check-free-turns`, `check-mcp-limit` (live) through MCP |
| Luke's lookups | `check-model-errors` (pure) for the loop, the cap and Gemini's JSON mode; `check-luke-lookups` (model, by hand) for a real turn that must look an order up, and one that must not |
| Overview figures | `check-overview` (live) |

New regression tests should prove behavior rather than source wording. Source-text checks
are appropriate only when the invariant itself is a declaration that must remain in one
place.
