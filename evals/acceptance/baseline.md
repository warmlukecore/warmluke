# Acceptance: baseline

## The ten critical scenarios

| Scenario | Checks | Browser | Eval cases | Open |
| --- | --- | --- | --- | --- |
| Numbers are counted over every row, never a page or a snapshot | check-store-query: pass, check-store-metrics: pass, check-rto-cohorts: pass, check-stock-cover: pass | - | not run |  |
| A retry or a second press never writes twice | check-build-once: pass, check-row-asks: pass | - | - |  |
| A correction is used in a fresh chat, and the old fact is retired | check-memory: pass, check-team-facts: pass | - | not run |  |
| A turn cut off is finished where it was asked, or tried again by one click | check-chat-stream: pass | e2e/retry.spec.ts | - |  |
| A teammate, or their own AI, cannot do what only the owner may | check-row-asks: pass, check-team: pass, check-oauth-writes: pass | - | - |  |
| One account never reads another's store | check-rls: pass, check-rto-cohorts: pass, check-stock-cover: pass | - | - |  |
| Deleting data, refunds and cancellations are never Luke's or their AI's to do | check-parity: pass, check-store-action-propose: pass | - | - |  |
| Ad budgets and Shopify stock are never changed on Luke's own say | check-store-send: pass, check-store-actions: pass | - | - | Per-kind auto-send (0195) lets an owner send stock changes without a yes each time: the sprint says stock is never autonomous. The owner's decision. |
| The first chat opens without waiting on the store's import | - | e2e/meet.spec.ts | not run |  |
| Going to the store works at once, from the first screen, in any words | - | e2e/meet.spec.ts | not run |  |

## Eval runs

Not run: the paid part waits for a budget (`--max-usd`).
