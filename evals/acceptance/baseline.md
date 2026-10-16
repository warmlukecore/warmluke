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
| The first chat opens without waiting on the store's import | - | e2e/opens-fast.spec.ts, e2e/meet.spec.ts | not run |  |
| Going to the store works at once, from the first screen, in any words | - | e2e/meet.spec.ts | not run |  |

## The conditions every run is tried under

| Scenario | Checks | Browser | Eval cases | Open |
| --- | --- | --- | --- | --- |
| A fresh chat uses what was said in another, without asking again | check-memory: pass, check-team-facts: pass | - | not run |  |
| A long chat keeps its newest messages and a digest of the ones before | check-thread-window: pass, check-agent-loop: pass, check-lean-turns: pass | - | - |  |
| A vague ask gets a question or a plan in words before anything is built | check-talk-first: pass | - | not run |  |
| A correction replaces the old line, in this chat and the next | check-memory: pass, check-team-facts: pass | - | not run |  |
| Data missing, unfinished or stale is said, never counted as none | check-memory: pass, check-site-read: pass, check-stock-cover: pass, check-rto-cohorts: pass | - | - |  |
| A refused design or a failed read is repaired or said, and the same reply is not sent twice | check-repair-honest: pass, check-model-errors: pass, check-errors: pass | - | - |  |
| A login that ran out is said, with the way to reconnect, and nothing is read with it | check-store-switcher: pass, check-connectors: pass, check-meta-ads: pass, check-import-worker: pass | - | - |  |
| A reload mid-reply finishes it or says it did not, and shows what was really done | check-thread-reload: pass, check-chat-stream: pass | e2e/retry.spec.ts | - |  |
| Work cut off is taken up where it stopped, by one worker, and closed after its tries | check-turn-legs: pass, check-connectors: pass, check-code-jobs-live: pass | - | - |  |
| What an account may not do is refused and said | check-row-asks: pass, check-team: pass, check-oauth-writes: pass, check-luke-access: pass | - | - |  |

## Eval runs

Not run: the paid part waits for a budget (`--max-usd`).
