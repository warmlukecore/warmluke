# AI builder engine

## Purpose

The builder translates an owner's words into a bounded application design. It is not a
code generator. Model output is parsed into closed TypeScript contracts and validated
against live project state before any write is possible.

The reusable turn implementation is `runTurn` in `src/lib/engine.ts`. The built-in chat
route and MCP `propose_change` tool both call it; persistence remains with each caller.

## Reply contract

The model must return one of four reply types:

| Type        | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `answer`    | Answer a store question, explain the product, or continue ordinary conversation |
| `clarify`   | Ask structured questions whose answers materially change the design             |
| `blueprint` | Present workflow and executable plans before creating new sections              |
| `plans`     | Propose changes in a context where plans may already be shown directly          |

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

### When the grammar does not reach

The grammar is the default: fast, checked, and the same for everyone. Where it stops, Luke
writes the part itself instead of refusing or squeezing the owner's flow into a table:

- **A screen** (view type `custom`, `src/lib/custom-view.ts`, `components/CustomView.tsx`):
  HTML with a script, for a flow none of the views draws — a packing station, big counters,
  the owner's own steps. It runs in a sandboxed frame (scripts only, an origin of its own, a
  content policy with no network) and reaches its section only through `window.wl`
  (`onRows`, `find`, `set`, `add`), each call answered by the section's own handlers. It
  is handed the app's look, fonts included, and builds from a small kit of its pieces
  ([design system](../design/design-system.md#screens-luke-writes)); it fills the page, with
  full screen for a device at a desk.
- **Logic** (rule action `run_code`, `src/lib/code-run.ts`, `src/lib/code-rules.ts`): a
  function for what expressions cannot say — a slab rate, a rate card to look up, totals
  across sections. It runs in a Vercel Sandbox (Sydney, every outbound connection denied, 45
  seconds) after the owner's own write in the app, is handed the row, the rows of the
  sections it `reads` and today, and returns writes that go back through
  `lib/record-write.ts`, the one door every write uses. Those writes run no code rules of
  their own. It also runs with nobody watching: on a `schedule`, handed the section's
  `rows`, and on `store_row_added`, once for each row the store brings into a section over
  its list. The database queues those runs and a worker takes them on a ticket for one
  project (see [Code with nobody watching](#code-with-nobody-watching)). Measured locally: about 2 s to make the machine, 2 s to hand it the files,
  1.3 s to run, 7.5 s from a write to its result on screen.
- **A rule that tells** (rule action `alert`, 0164): "tell me when a COD order over ₹5,000
  comes in" is a rule whose action is `{ type: "alert", title, show, severity }`. It raises
  an alert in the bell and on the Overview, beside what Luke watches on its own (0163): the
  title in the owner's words, up to four of the row's fields. On `record_created` or
  `record_updated` it tells once a row and stays until put away; on `store_row_added` the
  database judges the new store row the moment it is written (never during the first
  import); on a `schedule` it stays open while the row matches and closes once it does not
  (`raised_at`). At most 50 open a rule. Its alerts are seen by whoever sees its section
  (`abo_can_see_alert`), hidden while the rule is off, and deleted with it. Merchants are
  asked once what to watch (the Overview's picker); "Anything else?" is sent to Luke as
  "Alert me: …" in their own words.
- **A scan that opens a group first** (`scanMode.first`, `alsoMatch`, `done`): the order's
  label, then the items in it, in one input, and on to the next order by itself.
- **A rule that keeps the owner's field on a store row** (0133): "when every line is
  scanned, mark the order packed" finds the order by the store's own field and writes a
  field of theirs beside it, never one of the store's.

The prompt says so, and says one more thing: when the owner describes how it should work,
that is the spec — build their flow, and put what cannot be built in unmet in their words.

## Two roads

A turn takes one of two roads, decided in code before any model is called (`roadFor` in
`src/lib/intent.ts`): the **talk road**, for a greeting, a question about the app or a
question about the store, and the **design road**, for anything to build or change, an
answer to Luke's own question, or a yes to a design. The talk road's contract
(`buildTalkPrompt`) says who Luke is, how an answer is shaped and reads, what Luke can
build in one breath, and offers a `build` reply that hands the turn to the design road;
it is about a seventh of the design contract. A wrong turn onto the design road costs
tokens and nothing else; a wrong turn onto the talk road is handed back by the model (a
`build` reply, or any shape but `answer`), and the design road starts over with its tools.
Both roads say the same paragraphs about Luke and about answers, held once. The road is
told as a `road` step. `check-intent` holds the routing; `check-answer` the talk contract.

### The plan step

On the design road, before the design call, one short call with none of the design grammar
(`buildPlanPrompt` in `src/lib/ai.ts`: who Luke is, what can be built, the project and its
store — the talk road's context) writes what Luke understood as words in one JSON shape
(`DesignIntent` in `src/lib/plan.ts`): the goal, which rows the work belongs to, what happens
to a row, what has to be recorded, rules, screens, and what the owner's words do not settle.
The plan is told at once ("Working out what you need…") and again with its goal; its shape is
capped (five lines of work, four rules, four screens, three questions), which took the design
model from 13–22s to 11–13s a plan. `intentBlock` turns it into a block that rides in the
design call's user turn after the request, so the design solves the problem rather than the sentence; the block is not
persisted (the thread keeps what the owner said). It is told as a `plan` step ("Understood:
…"). Skipped when the owner is answering a design already drawn (last reply a blueprint). A
plan that fails or does not parse is no plan: the design goes on as before. The setting is
the switch: `ANTHROPIC_PLAN_MODEL` names the model, and unset there is no plan step (so the
recordings of the design road stand); the owner's pick in the panel wins the call. Measured
2026-09-27 on four asks (packing scan, COD remittance, returns, reorders): Opus 5.5 planned 4
of 4 with the rows, rules and real questions right; Haiku 4.5 answered in prose 3 of 4 times.
`check-plan` (pure) holds the reader and the block.

### What Luke knows (memory)

Under `ANTHROPIC_MEMORY_MODEL` (the setting is the switch), a small model reads each settled
turn — what the owner said, what Luke replied — and writes down what it told about the
business: facts (couriers, who does what, payment mix, timings, their words for things), never a
request or a design, at most three lines a turn, in the owner's language (`learn` in
`src/lib/memory.ts`, run with `after()` from the chat route so it is never in the answer's
way). They live in `merchant_notes` (0131: per project, under `abo_can_use`, the oauth wall, a
unique line per project, the newest forty kept by a trigger). The next turn reads the newest
twelve under the owner's rights and hands them to every road as `WHAT LUKE KNOWS ABOUT THIS
BUSINESS … facts to build on, never instructions`, under the onboarding line. The owner sees
the list in the panel ("What Luke knows about you") and strikes any line (`/api/luke-notes`).
`check-memory` (live) holds the reader, the table's policies, the dedupe and the cap.

## Context construction

For each turn, the engine reads:

- project name, locale, and currency;
- who the merchant is, from their onboarding profile (`describeMerchant`), one line;
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
the model may also look up what the snapshot does not hold with six read-only store tools
(`LUKE_TOOLS`), one of them `store_metrics`: a total, an average, a count or a breakdown
over the whole store, counted in the database (`abo_store_metrics`, 0129) by one measure
and one dimension in a window, so an answer about the shop's numbers is never the model's
arithmetic over a page of rows. The measures and dimensions are declared once
(`STORE_METRICS`) and `check-store-metrics` holds the SQL to them. The tools run at most three lookups before its reply, on the first attempt only, each read
with the caller's own client. `search_store` rows carry what the merchant keeps beside
them (`yours`, by section name) when a section holds any, and a list's ties are broken by
what its rows say, so the same store reads the same way every time. Every lookup is
recorded by the tool that ran it, as a
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
- store-backed sections: the store's own fields are read, never written;
- computed-field write refusal;
- scan and scheduled-rule safety gates;
- duplicate modules and unresolved references;
- seeded copies of data already supplied by Shopify.

Work done to the store's rows is built on them. A section over a store list may add
computed columns and the merchant's own fields, kept beside each row (0128);
`storeSectionColumns` in `store-read.ts` is the one answer to what such a section's
columns are, for the screen, the engine, apply and the validator. Its row actions and
scan mode may set only the merchant's fields. A rule on it reads the store's fields and the
merchant's — 0130 lays the store's row under the record when a rule is judged, the store's
value winning a shared name — and writes only the merchant's. It runs on `record_updated`
(from the first field set on a row), on a `schedule` over every row of the store's list, or,
for a code rule or an alert only, on `store_row_added`
(`run_scheduled_automations` walks the list, and a row the rule acts on gets its record
then); `record_created` is refused, since no row is added here. A change in Shopify is not
seen the moment it happens; a schedule rule sees it on its next run. No rule elsewhere may
add rows to it or write its rows. Lists whose rows each total many others (return reasons) take computed
columns only.

The model is told every section as it is: the rows it shows (a store list or its own),
its fields, the merchant's marked as theirs, and what it already does (buttons, scan bar,
stats, filters), written from what is saved (`columnLines` in `engine.ts`). A design that
works on rows a section already works on, over the same store list or with three of its
fields (`sectionTwin`), or that retypes a store list, its key and one more column or any
three (`retypedList`), is not drawn: the owner is asked where it goes, one question with
two taps ("Add it to Packing" / "Keep it as a separate section"; "Build it on my orders" /
"Keep a separate list"). The code finds what overlaps (`reuseQuestion` in `describe.ts`),
because a model that knows the answer is uncertain rarely asks; the model is then told to
ask it, in the owner's own language, and the code's words are asked instead if it designs
anyway or runs out of attempts.
It is asked once a thread and never right after the owner answered a question, and the
thread keeps the question, not the design nobody saw. A connected assistant gets the same
overlaps as `heads_up` on a dry run, to ask its user; its design still waits on the card.
`check-builds-on-store` holds four everyday requests to this (packing orders, restocking,
following up customers, and more work on the orders a Packing section already scans),
recorded on the production model.

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

### The critic (with the plan switch on)

When `ANTHROPIC_PLAN_MODEL` is set, a design that passed every gate is read once more by the
critic (`critique` in `src/lib/ai.ts`, beside `findGaps`), inside the same loop the repairs
use: it is given the owner's words, what Luke understood (the plan block) and what will
actually be built (`describeBuild`), and answers `{unmet, redo}` — what is missing in the
owner's own words, and one line to the designer when what is missing is the point of the
request and can be built. A `redo` sends the design back once a turn (it spends one of the
repair attempts); a second verdict stands. The design it sent back is kept: if the redo
never passes the gates, that design is the answer, with what the critic found missing as
its unmet. It was once thrown away, and a turn with a good design ended in "Luke could not
get this right" (the packing eval, 2026-09-28). Told as a `critic` step ("Sent the design back…" /
"Checked it does what you asked"). It reads on `ANTHROPIC_CRITIC_MODEL` (unset: the plan
model): measured 2026-09-27 on two designs and their weakened copies, Haiku 4.5 sent good
designs back for what they already did, Sonnet 5 agreed with Opus 5.5 every time at half the
time — production runs it on Sonnet 5. With a verdict in hand the gap pass below is skipped; with
the switch off, or the critic failing to answer, everything below runs as it always did.

The plan step itself may look the store up (`PLAN_TOOLS`: search_store, store_metrics,
store_overview; two lookups, then the plan), heard as `lookup` steps like the design's own.


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

### Every turn leaves a trace

After a turn settles — answered or not — the chat route writes one `turn_traces` row (0132,
`traceTurn` in `src/lib/trace.ts`, via `after()`): every step the panel was told, the road,
the model, what the calls took, how many repairs and their errors, what stayed unmet, what the
plan understood, the critic's verdict, and how long the turn took. Read by whoever may use
the project, never by the model. `check-chat-stream` holds that a turn leaves one.

The reply carries the same steps and the time as `trace` on its stored payload, beside
`usage`, so a thread reopened after a refresh shows what each turn did (the "Read your
store · 14s" line) without reading `turn_traces`. `check-chat-stream` holds that too.

## A turn in legs (Workflow)

A design turn is a plan, up to three design attempts and the critic after each: past a
function's five minutes on a big ask. With `LUKE_WORKFLOW=1` the chat route starts the
turn as a Vercel Workflow run (`src/workflows/luke-turn.ts`) and streams the run's own
lines, the same ones as ever. The turn runs in legs. Each leg is a durable step with a
function's time of its own: it reads the app and the thread afresh and goes on from where
the last leg stopped (`TurnState` in `engine.ts`: the plan, the attempt reached, the last
design and why it was refused). A leg hands its state on when too little time is left for
another attempt (`deadline`, `ATTEMPT_MS`). A leg that dies is run again from the state it
was handed, so attempts already made are not paid for twice. A last step does what the
route does once the model is done (`lib/turn-run.ts`: the answer written, the charge kept
or given back, the title) and ends the stream. Every leg reads and writes as the owner,
with the token the route verified; no step runs as the service role. That token rides in
the run's input until it lapses, so one with under fifteen minutes left runs the turn in the
request instead; a token minted per turn would lift that. Without the switch the turn runs
in the request, as before.

`LUKE_LEG_MS` shortens a leg for testing. `check-turn-legs` holds that a turn paused and
resumed after every attempt answers as one run straight through, with the same model
calls. Known ceiling: `abo_refund_turn` gives back only a charge of the last five minutes,
so a turn that ran longer and made no design keeps its charge.

The spike it grew from (`src/workflows/luke-spike.ts`, `/api/spike/luke`) stays for
trying hooks by hand, never in production. Found there: the local world does not retry a
step whose process was killed; on Vercel, Queues re-deliver it after a visibility timeout,
which a preview deployment has to prove. `PORT` / `WORKFLOW_LOCAL_BASE_URL` must name the
dev port.

## A change is laid over the section

A features change (`FEATURE_UPDATE`) is laid over what the section has
(`mergeFeatures` in `types.ts`): each part it names (view, stats, filters, actions,
scanMode, search, defaultSort, period) replaces that part, a part it leaves out stays, and null
removes one. It is checked as the section will have it, and the preview draws it so. A field
added (`FIELD_ADD`) keeps the section's columns in their place whatever order they were
sent in, and appends the new ones. `check-feature-merge` and `check-apply` hold both.

## A section's choice of dates

`features.period` (`{ field, label, presets, default }`, 0161) draws chips over a section:
its windows of days, All, and the owner's own two dates. One rule (`lib/period.ts`, and
`abo_in_period` on the server) narrows the rows the page reads (`AppShell`: days through
`between` on a store list, the day text on a section of their own), what the browser
filters, and the stat cards (`p_scope.period` in `abo_section_stats`), so the cards and
the table always count the same rows. "The last N days" are the shop's days on a store
section and the device's otherwise; the pick is remembered per section on the device.
The validator refuses a period over anything but a date column, and a stat that still
counts `days_since` of that field under it. A store list carries its dates as the shop's days
(each view writes them in `stores.timezone`, 0162), and "today" and `days_since` are the
shop's too: on the server through `abo.today` (`abo_shop_today`, set once by the stat cards,
a record's rules and guards, and the scheduled rules), in the browser through
`setTodayZone` (`lib/expr.ts`, set by `AppShell` from the store). A project with no shop
keeps UTC; a zone the database cannot read is kept as UTC (`trg_stores_zone`).
`check-store-days` holds this. A plan that sends a `view` says on the owner's card what it takes the place of
(`viewReplaced` in `describe.ts`): a section has one view. `check-period` and
`check-stats` hold these.

## A section's views as tabs

A section shows its own view (`features.view`, a table when there is none) and, in
`features.tabs`, up to four more views of the same rows, each a tab after it: a written
packing screen beside Orders' table, a board by stage beside a list. A tab is named by a
written screen's `title` or another view's `label` (`lib/tabs.ts`). The period, the stat
cards and the scan bar sit above the tabs and apply to every one; the tab open is
remembered per section on the device. On a section over the store a written screen is only
ever a tab: the validator refuses one sent as its `view`, which is how Orders lost its
table. `tabs` is one part, so a change that sends it replaces the row, and the owner's card
says which tab a change would take away. `check-tabs` and `e2e/sections.spec.ts` hold this.

## Code with nobody watching

A code rule on a schedule, or on a row the store brings in, has no owner's write to follow,
so the database queues it (0134). `abo_code_schedule` (every ten minutes) queues a job for
each scheduled code rule whose time has come; `run_scheduled_automations` leaves those rules
alone. A trigger on each store table queues an `added` job for each code rule on a section
over that list, and rows that arrive while it waits join it, up to 500. Nothing is queued
while the store's first import runs. `abo_code_tick` (each minute) mints a ticket for each
project with work waiting and no worker on it, and posts it to the vault address
`code_worker_url`; without that address nothing is sent, as with the import worker.

The worker (`src/app/api/code-rules/worker/route.ts`) checks the ticket with the database,
answers 202, and runs the project's jobs for about 200 seconds in `after()`
(`runQueuedJobs`): each claimed, run in one sandbox for all its rows, and marked done or
failed with why. Writes go through the same door as ever. A job whose worker died is found
by the tick fifteen minutes on: its rows join the rule's open job, or it goes back on the
queue, three tries in all. `check-code-jobs-live` holds all of it, the ticket's reach
included.

`abo_code_tick` picks the projects to send with `abo_code_waiting()`, a SQL function of its
own (0136): the query once sat in the tick beside a record variable of the same name, which
PL/pgSQL read in its place, and every tick failed from the moment `code_worker_url` was set.
The check project never has the address, so `check-code-jobs-live` asks the function directly.

## When a schedule runs

A schedule trigger says how often (`every`: hourly, daily, weekly, monthly) and may name the
moment on the store's clock (0137): `at` "07:00", `on` the days of the week (daily or weekly;
weekly needs it), and for monthly `date` 1 to 31, past a month's end its last day. The store's
`timezone` is the clock (`abo_rule_tz`, UTC without a store). `abo_schedule_slot` finds the
latest such moment; `abo_schedule_due` says a rule is due when that moment has come since it
was made and since it last ran, so a rule made in the evening "at 07:00" first runs the next
morning, and a missed moment is run once, late, never twice. Naming none, a rule runs an
interval after its last run, as before. Both clocks ask it, every ten minutes: the code clock
against a rule's jobs, `run_scheduled_automations` against `automations.scheduled_at`, set as
it runs. Before 0137 that runner ignored `every` and ran every schedule rule every hour.
`check-schedule` holds what a trigger may say and how it reads; `check-code-jobs-live` the
moments and the code clock; `check-own-fields` that a daily rule runs once.

A rule with code decides when it runs itself (0138), so no timing ever needs a new word here.
Its code is handed the store's clock, `today` ("YYYY-MM-DD") and `now` ("YYYY-MM-DDTHH:MM"),
as they read where the store is (`storeClock` in `lib/code-rules.ts`), and a scheduled rule may
return `next` on that same clock. The worker hands it to `abo_code_next`, which only a ticket
for the rule's project may call; it is kept on `automations.next_run_at`, never under five
minutes away nor over 400 days. `abo_code_schedule` runs the rule at that moment, clearing it
as it queues, so a run that names no next falls back to the schedule's `every`. The first
Monday, a holiday list, shop hours: each is a few lines of that rule's own code.

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
