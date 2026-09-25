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

CI runs dependency audit, typecheck, lint, build, pure checks, zizmor over its own workflow,
migrations/seeding, the live tier against the check project, and the browser specs. The
pre-push hook repeats pure checks and adds PAT-only security checks that CI must not hold
credentials for.

`pnpm lint` is oxlint (`.oxlintrc.json`): correctness rules fail the build, the rest are
advice. A rule silenced on one line says why on the line above. The workflow's actions are
pinned to commit hashes, and Dependabot (`.github/dependabot.yml`) proposes updates weekly:
npm minor and patch as one pull request, majors alone, actions together. Its pull requests
run the static job only; the live job needs secrets Dependabot is not given.

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
| Store tools | `check-store-tools` (pure) for one declaration and refusals before reads; `check-ask-store` (live, its router half played back from `tapes/`), `check-leaders`, `check-free-turns`, `check-mcp-limit` (live) through MCP |
| Luke's lookups | `check-model-errors` (pure) for the loop, the cap and Gemini's JSON mode; `check-luke-lookups` (live, played back from `tapes/`) for a real turn that must look an order up, and one that must not |
| Model calls in tests | `check-model-tape` (pure) for the recorder itself; `check-route-eval` (pure, played back) for the router on forty real questions against its baseline |
| Asking to change the shop | `check-store-action-propose` (pure) for every gate, the server's wording, one request per change and that each target kind is handed out; `check-luke-lookups` (live, played back) for Luke's real proposal, and none with the switch off; `e2e/luke.spec.ts` for the request waiting in the bell |
| Overview figures | `check-overview` (live); `e2e/store.spec.ts` for the seeded shop's overview in a browser |
| A flow in the browser | `pnpm exec playwright test` (`e2e/`, desktop and phone width, played back) |

New regression tests should prove behavior rather than source wording. Source-text checks
are appropriate only when the invariant itself is a declaration that must remain in one
place.

## Real models, recorded

Checks that need a model do not call one in CI. `src/lib/model-tape.ts` records a real
answer once (`MODEL_TAPE=record`) and plays it back after (`MODEL_TAPE=replay`), keyed by
the whole request, normalised, without the model's name. CI's server runs in replay, so
`check-luke-lookups` runs there with no key; `check-route-eval` replays by default. A
request nothing was recorded for fails at once and says what changed: the system prompt,
the tools or the conversation. Changing what a model is told therefore means recording
again, and the new answers are reviewed like code. See [`tapes/README.md`](../../tapes/README.md).

The router eval (`scripts/fixtures/route-questions.json`) scores forty real questions, half Hinglish, part by
part (gated, list, window, month, kind, needle), and fails below the baseline written in the
file. Recording it measures the real router and its latency; the baseline moves only with
`EVAL_REBASELINE=1`.

## In a browser

`e2e/` holds Playwright specs run at desktop (1440×900) and phone (390×844) width against a
server that is already up: CI's, after the live checks, or yours on 3101. Each worker makes a
throwaway `check e2e` project with the seeded shop's rows (below) and removes it after; a spec
fails on any uncaught page error. Luke's turns play back from `tapes/`, and a spec refuses a
server that records or replays differently. The env file must declare `CHECK_PROJECT=1`.

```sh
(set -a; . ./.env.check.local; set +a; MODEL_TAPE=replay pnpm exec next dev -p 3101)
ENV_FILE=.env.check.local APP_URL=http://localhost:3101 pnpm exec playwright test
```

A spec asked in new words needs recording once: the same two commands with
`MODEL_TAPE=record` on both. A failure in CI leaves the report, traces and screenshots as the
`playwright-report` artifact.

## The seeded shop

The check project always holds one store: `seed-shop.myshopify.com`, owned by
`seed@warmluke.test`, made again from nothing by `scripts/seed-check-project.mjs` on every CI
run. Its rows are Shopify-shaped nodes (`scripts/fixtures/seed-shop.ts`: ten orders over four
weeks, refunds, COD, a cancelled order, returns, drafts, discounts, two locations, payouts)
saved through each resource's own saver, in import order, twice, as an import does. So the
store checks test the import's flattening too, not just the reads. A resource added to the
registry does not type-check until the fixture has rows for it.

The store checks (`check-store-read`, `check-store-sections`, `check-store-token`,
`check-webhook-gate`) read it through `realStores`, which skips the throwaway `check …`
projects. Checks that call Shopify or write webhooks into a store (`check-import`,
`check-recheck`, `check-drift`, `check-catalog-webhooks`, `check-order-webhook`) use
`shopifyStores`, which also skips the seeded shop: its token opens nothing, and the read
checks count on its rows staying as seeded. To seed by hand, with CI idle:

```sh
node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/seed-check-project.mjs --env .env.check.local
```

