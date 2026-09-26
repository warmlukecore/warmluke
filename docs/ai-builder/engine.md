# AI builder engine

## Purpose

The builder translates an owner's words into a bounded application design. It is not a
code generator. Model output is parsed into closed TypeScript contracts and validated
against live project state before any write is possible.

The reusable turn implementation is `runTurn` in `src/lib/engine.ts`. The built-in chat
route and MCP `propose_change` tool both call it; persistence remains with each caller.

## Reply contract

The model must return one of four reply types:

| Type | Meaning |
| --- | --- |
| `answer` | Answer a store question, explain the product, or continue ordinary conversation |
| `clarify` | Ask structured questions whose answers materially change the design |
| `blueprint` | Present workflow and executable plans before creating new sections |
| `plans` | Propose changes in a context where plans may already be shown directly |

An `answer` about store data receives server-written grounding metadata. The model's own
claim that it “checked” something is not treated as evidence.

Every reply carries a `title` of three to six words, which names the conversation while
its subject holds. An `answer`'s message is Markdown (short headings, bullets, steps and
bold; no tables, code or images) and its `next` holds what the owner might ask next:
three or four after a store answer, one or two otherwise, two after a build. A question
about the store's numbers is answered from the data at once, with a section to build
offered among the `next`, never a blueprint in its place. A `clarify` asks the fewest
questions, in the order their answers depend on each other; a question is `multi` when
more than one answer fits, and exactly two independent questions may be asked `together`.

## Plan contract

Each `AssistantPlan` has one change type:

- `UI_CHANGE`
- `FIELD_ADD`
- `NEW_MODULE`
- `MODULE_UPDATE`
- `MODULE_DELETE`
- `FEATURE_UPDATE`
- `RECORD_SEED`
- `AUTOMATION_ADD`
- `AUTOMATION_REMOVE`

The plan carries all data required for that change. In a multi-plan blueprint, temporary
references such as `#orders` connect later plans to sections created earlier in the same
batch. `applyPlans` resolves them to actual UUIDs in order.

Blueprint prose is secondary. The plans inside the blueprint are the exact objects later
submitted for application, and human-readable descriptions are derived from those plans.

## Capability registry

`src/lib/capabilities.ts` is the single declaration point for:

- column types;
- view types and required field references;
- expression operators and arity;
- automation triggers and supported actions;
- statistic aggregations;
- explicitly unsupported product capabilities.

The system prompt and validator both read this registry. A capability absent from the
registry should be neither advertised nor accepted.

Supported column types currently include text, long text, numbers, currency, percent,
date, time, boolean, badge, dropdown, phone, email, URL, record link, and barcode.

## Context construction

For each turn, the engine reads:

- project name, locale, and currency;
- every module and its current effective schema;
- current module context, when present;
- up to 40 existing automation rules;
- recent external-assistant build requests;
- conversation history supplied by the caller;
- connected-store facts and bounded data snapshots.

For store-backed modules, effective schemas combine canonical store columns with saved
computed columns and features. This prevents prompt/validation context from describing a
different shape than the renderer uses.

### Store grounding

The fixed snapshot contains counts, recent orders, low stock, leaders, values useful for
filters, import completeness, and last sync time. A Jev question router may additionally
select a list, time window, and question kind; `fetchSlice` then retrieves up to 50 rows
for that specific question.

Most questions are answered from that read in one model call. In the chat (`lookups: true`)
the model may also look up what the snapshot does not hold with five read-only store tools
(`LUKE_TOOLS`): at most three lookups before its reply, on the first attempt only, each read
with the caller's own client. Every lookup is recorded by the tool that ran it, as a
`lookup` step and in the answer's `grounding.looked_up`, never by the model's word. A cap
reached mid-lookup is still answered, in one more call with the results folded into words.
The MCP design engine does not look things up; the client asking has the same tools.

When the account's `store_actions` switch is on, the chat also offers
`propose_store_action`, through the same gates as MCP (`store-action-propose.ts`). It only
ever makes a request: the server writes the card's sentence from the change, the request
waits on the card under the conversation, and the merchant's yes runs it
(`POST /api/store-actions`). The same change asked twice in one turn is one request. With
the switch off the tool is not offered and the prompt does not mention changing the shop.

## Validation and repair

Parsing removes code fences and normalizes a small set of known aliases, then validates
the reply and each plan. Validation covers, among other rules:

- known change, column, view, trigger, action, statistic, and operator types;
- expression arity, depth, and field existence;
- view/feature references to real compatible fields;
- immutable/removal rules for fields;
- valid links and cross-module automation targets;
- read-only store-backed sections;
- computed-field write refusal;
- scan and scheduled-rule safety gates;
- duplicate modules and unresolved references;
- seeded copies of data already supplied by Shopify.

When validation fails, the rejected model output and exact errors are sent back to the
model. The engine permits the initial attempt plus two repair attempts. Rejected output
is not persisted as conversation history.

## Human-in-the-loop gates

- A new module cannot arrive as plain plans in built-in chat before a blueprint has been
  shown.
- Chat always requires the owner; project staff cannot spend the owner's design quota or
  redesign the application.
- MCP proposals persist exact plans for later approval.
- Module deletion requires the first-party application and explicit name confirmation.
- When a project has auto-build enabled, any non-empty MCP design may be approved and
  applied automatically. Module deletion is refused by the MCP path before a request is
  created; database approval state remains authoritative for everything that proceeds.

## Gap pass and judgement

After structural validation, `findGaps` compares the owner's original request with a
deterministic description of what the plans actually build. Missing requested outcomes
are returned as unmet items. Suggested next steps that merely repeat unmet work are
removed.

The optional Jev design judge records observations asynchronously after the response.
It does not block, approve, or rewrite the design. Its role is evaluation, not authority.

## Provider behavior

The main call selects provider by model name:

- Gemini model IDs use the Gemini API.
- Other model IDs use the Anthropic Messages API or a compatible configured host.
- Gemini transient failure may fall back to the configured Anthropic model.

Provider failures are normalized into billing, authentication, busy, unavailable,
refused, empty, or unset categories so the UI can provide a useful recovery prompt.

The gap pass may use a smaller separately configured model. Jev is optional; without its
key, routing and judgement degrade without disabling the primary builder.

## Turn accounting and persistence

`POST /api/chat` enforces a feature switch, owner-only use, a per-hour ceiling, and the
included-turn ledger before running a paid model call. A failed charge is refunded using
the exact spend identifier. Successful user and assistant messages receive distinct
timestamps to preserve order.

Progress is streamed as NDJSON events representing actual completed/started work:
accepted, store context, project context, model attempt, validation result, and gap pass.
The final line contains the reply or error.

## Extending the engine safely

Adding a capability normally requires coordinated changes to:

1. `capabilities.ts` and shared types;
2. prompt serialization and parsing;
3. plan/feature/expression validation;
4. browser renderer or evaluator;
5. PostgreSQL evaluator/build gateway when server behavior changes;
6. human-readable plan descriptions;
7. pure parity/design checks and relevant live scenarios;
8. this documentation.
