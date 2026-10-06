# HTTP API reference

Unless noted otherwise, API routes run on the Node.js runtime, accept JSON, require a
Supabase bearer session, and execute database work through a caller-scoped client.
Database RLS remains authoritative.

## Projects and application structure

| Method and path                   | Purpose                                                                               | Important rules                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects`               | List projects visible to the caller                                                   | RLS includes owned and joined projects as applicable                                                                                                                                                                  |
| `POST /api/projects`              | Create an empty project                                                               | Owner is the authenticated user                                                                                                                                                                                       |
| `PATCH /api/projects`             | Rename/update locale, currency, or auto-build                                         | Owner-only writes; chosen currency is tracked separately from its default                                                                                                                                             |
| `DELETE /api/projects`            | Delete a project                                                                      | Owner-only and explicitly confirmed by the UI; cascades project data                                                                                                                                                  |
| `GET /api/modules?projectId=&id=` | Preview module deletion impact                                                        | Returns row and child-section impact                                                                                                                                                                                  |
| `POST /api/modules`               | Create a section manually                                                             | Validates source table and creates initial schema                                                                                                                                                                     |
| `PATCH /api/modules`              | Rename/reorder/reparent/change source                                                 | Prevents invalid nesting/source transitions; versions schema changes                                                                                                                                                  |
| `DELETE /api/modules`             | Delete a section                                                                      | Owner-only with confirmation name and dependency checks                                                                                                                                                               |
| `POST /api/records`               | Create, update, delete, or apply a row action                                         | Reloads current schema, strips undeclared data, enforces computed/store restrictions                                                                                                                                  |
| `POST /api/row-action`            | A row button that waits for the owner (0183): a press, or the owner's decision on one | Works the change out from the row on the server; the owner's press is made, a teammate's waits; only the owner decides (`abo_decide_approval`), and an approved change is worked out again from the row as it is then |
| `POST /api/rollback`              | Restore an earlier UI schema                                                          | Appends a new schema version rather than rewriting history                                                                                                                                                            |
| `POST /api/code-rules/worker`     | Run a project's queued code rules                                                     | Called by the database only; `{ project, ticket }`, the ticket checked by the database; 202, the work in `after()`                                                                                                    |

The browser performs many ordinary reads directly through Supabase under RLS. These API
routes exist where server-side validation, orchestration, or secrets are required.

## Assistant and builds

| Method and path                     | Purpose                                       | Response                                                                         |
| ----------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/chat?projectId=`          | List up to 30 recent conversation threads     | JSON                                                                             |
| `GET /api/chat?projectId=&id=`      | Load one thread and up to 200 recent messages | JSON, chronological messages                                                     |
| `GET /api/chat?projectId=&latest=1` | Load the newest thread                        | JSON                                                                             |
| `POST /api/chat`                    | Run one built-in-assistant turn               | NDJSON progress events plus one final object; pre-run refusals are ordinary JSON |
| `POST /api/apply`                   | Validate and apply approved plans             | Full, partial, already-claimed, or validation result                             |
| `POST /api/undo`                    | Conservatively reverse a recorded build       | Reads undo steps from the authorized message; reports completed/refused steps    |

`POST /api/chat` accepts `message`, `projectId`, optional `moduleId`, optional
`conversationId`, and optional `alertId` (an alert asked about from the bell or the Overview;
the new thread is kept on it through `abo_alert_link`, 0163). It enforces the account feature switch, project ownership, hourly
ceiling, and included-turn ledger. It never applies plans. Lines with `step` are progress
(including `lookup` when a store tool ran), lines with `words` are drafts of the reply's
message, and the last line is the result.

`POST /api/apply` accepts `projectId`, plans, and an optional MCP `requestId`. With a
request ID it first claims the request atomically. Plans are capped, revalidated against
live state, and executed through `abo_build`.

## Shopify

| Method and path                         | Authentication                                                    | Purpose                                                          |
| --------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `POST /api/shopify/install`             | Owner bearer session                                              | Create pending store state and return Shopify authorization URL  |
| `GET /api/shopify/callback`             | Signed Shopify query + one-time state                             | Exchange token, connect store, subscribe webhooks, redirect      |
| `POST /api/shopify/import`              | Project user bearer session; secret token RPC is owner-restricted | Advance one bounded import step, report status, or begin recheck |
| `POST /api/shopify/webhooks/[token]`    | Shopify raw-body HMAC and per-store URL token                     | Apply ordinary resource events                                   |
| `POST /api/shopify/webhooks/compliance` | Shopify raw-body HMAC                                             | Apply mandatory data request/redaction events                    |

Import request body:

```json
{
  "projectId": "uuid",
  "status": false,
  "recheck": false
}
```

`status` reads progress without contacting Shopify. `recheck` resets completed resource
cursors for a new full pass. Ordinary calls advance the first unfinished resource.

## Store support

| Method and path                  | Purpose                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| `GET /api/fx?project=&from=&to=` | Return a project-scoped cached or freshly fetched exchange rate |

FX codes must be three uppercase letters. Fresh rates come from Frankfurter/ECB data,
are cached for one day, may be served as explicitly stale for up to seven days, and are
otherwise omitted so the UI can retain the truthful source currency.

## MCP and OAuth metadata

| Method and path                                   | Purpose                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource[/...]` | Publish the protected resource and Supabase authorization server |
| `POST /api/mcp`                                   | Handle authenticated MCP JSON-RPC requests                       |
| `GET /api/mcp`                                    | Report that server-initiated streaming is unavailable            |
| `DELETE /api/mcp`                                 | Confirm there is no persistent server session to terminate       |

See [MCP integration](../integrations/mcp.md) for the tool catalogue and approval model.

## Public server action

`bookDemo` in `src/app/actions.ts` validates and records a landing/demo request using the
public Supabase configuration. PostgreSQL rate limiting and table policy constrain the
anonymous write. Besides name, email, store and note it records team size, orders a month
and where the person heard of us, each kept only when it is one of onboarding's lists
(`src/lib/onboarding.ts`). The form will not send without them; with JavaScript off it
cannot ask them, and the booking is stored without them rather than lost. Administrators
read bookings back through `abo_admin_demo_requests` on the console's `demos` screen, set each one's
stage and note through `abo_admin_demo_follow_up` (0120), and open one account's whole
story on its first screen through `abo_admin_account`. Both screens take `?find=<text>` to open
with a search, and download what they show as CSV.

## The superadmin console

The administrators' screens answer on one secret path segment, `ADMIN_PATH` in the server's
environment (`src/lib/console-path.ts`), and on no other: `/admin` and any guess are the
site's ordinary 404, and the segment is in neither the repository nor the browser's code.
An administrator's header learns it from `POST /api/console`, which answers anyone else
with a 404. Unset, the console is at `/admin`. The screens still refuse non-administrators,
and so does every function behind them; the address only keeps it from being found.

Its Conversations screen (0158) opens any conversation by its id, a message's or a turn's:
Since 0184 every console report (`abo_admin_spend`, `_routing`, `_trouble`, `_their_ai`, `_agents`,
`_learning`, `_conversations`, `_tour_report`, `_what_stuck`) takes `p_account` and `p_app`: one account's
apps and the team in them, or one app, counted in the database; neither is everyone, as before. The
access log takes `p_account` and `p_admin`, and says which administrators have acted.
`abo_admin_conversations` lists them (latest, went wrong, cost most, took longest, over a
window of days, or by owner, project, store or title words), and `abo_admin_conversation`
returns one whole, with every turn's trace, writing a `view_conversation` row to the
account's trail each time. Warmluke's testing team (`account_settings.tester`, set with
`abo_admin_set_tester`) and administrators see, under each reply, its cost, tokens, time and
turn id, and the conversation's id and running total; nobody else does, and only they can
read `turn_traces`.

Three more screens (0159). **Data & privacy** sets how long traces are kept
(`abo_admin_retention`, `abo_admin_set_retention`): off by default, every trace is kept;
switched on, `abo_trace_sweep` deletes traces older than the kept days (7 to 3650) each
night at 03:17 UTC where the database has pg_cron, and `abo_admin_sweep_traces` runs it
once on demand. It deletes traces only, never messages, records or the audit trail.
**Access log** (`abo_admin_access_log`) reads every account's `admin_account_audit` lines,
newest first, by kind and by either email. **Spend** (`abo_admin_spend`) adds the traces'
dollars by UTC day, by model and by account, so it reaches back only as far as traces are
kept. Its Road choice card (`abo_admin_routing`, 0169) counts the turns that took the
wrong road: questions answered on the design road, with what they cost, and builds the
talk road handed back; past one turn in ten it says a small model should read the
messages the rules are unsure of. **Needs a look** (`abo_admin_trouble(p_days)`, 0175)
lists where something went wrong, newest first, up to 100, each with its project and
thread: a turn that failed (`unanswered`), needed two or more repairs or was sent back by
the critic; an owner's words that say it went wrong (a word list, English and Hinglish);
a section changed four or more times in a day; a rule whose runs or code jobs failed; a
schedule setting fields on every row with no `when`; three or more yes/no or status
fields sharing a word; a written screen that broke while it ran (`screen_errors`, 0178: kept
by the app once a message a visit, insert only, read by this function alone). **Learning** (0176) reads what Luke learned for each store:
`abo_admin_learning(p_days)` gives the window's totals (lessons and skills active today; created,
patched, retired, struck, used, helped, hurt and broken again; the owners' thumbs; the reflector's
runs and their dollars, `reflections` and `learning_usd`) and the repeat rate, mistakes made again
over the distinct lessons used in the window; each store's counts,
newest first, up to 200; and the 20 active lessons most used across stores by their shared name.
`abo_admin_learning_project(p_project, p_days)` opens one store (`?project=`): every lesson and
skill in any status, its timeline (newest 300, a patch with its version counted) and its owner's
verdicts on replies (newest 100). **Their AI** (`abo_admin_their_ai(p_days)`, 0180) reads the
calls an outside assistant made (a client id on the token): the same figures by guide version,
by week, by tool and in all (connections, accounts, designs drawn and refused, problems a
refusal listed, designs Luke changed before the merchant saw them, free view edits, designs
asked of Luke, undos, errors), each tool's outcomes as the rows hold them, and the requests
it raised by status; the guide itself is shown as served, from `how_to_help` and
`prompts/list`. **Agents** (`abo_admin_agents(p_days)`, 0176) says how each of
Luke's agents did, from the traces and the learning timeline: plan, design, validator, critic,
gap, memory, reflect and the shadow judge, each with its runs, how they came out, its metered
calls, tokens and dollars (null where nothing was metered), and each road's turns with their p50
and p90 times. The reflector runs after a turn is priced, so its runs, what they kept and their
dollars are read from its own `reflected` rows, not the traces. Since 0177 it also counts the
reviewers after the critic from their trace steps: the operator's view, simplicity and the screen
check on their own metered jobs (`ops`, `review`, `ux`), and the data check and the rule dry-run,
which are code and have no dollars. 0185 adds the tryout (its `tryout` step and job) and the AI
step in a rule, which runs outside any turn and is read from its own runs in `automation_runs`
(filled, left, dollars and tokens); 0186 gives any model job no card counts a card of its own
under the job's name, so a new agent shows the day it first runs. Each card's name and words come
from `src/lib/agents.ts`, where an agent is named once; `scripts/check-registries.mjs` fails until
every model job and every step a turn tells is named there, and every console page is in the
sidebar (`src/lib/console-nav.ts`, whose `scoped` flag also puts the scope bar above a report).
**Rename** (`abo_admin_rename(p_user, p_full_name, p_business, p_apps)`, 0187) corrects an
account's name and business (`profiles`) and the names of the apps it owns, written to the
audit trail as `rename` with the names before and after; blank keeps a name, an app not theirs is
passed over, and an administrator's own account and other administrators are refused. 0188 makes
Learning's "across stores" and the access log's counts by kind follow the scope as their rows do.
**Scout** (`abo_store_profile(p_store, p_views, p_sample)`, 0189) reads every store list the app
names (the views of `STORE_TABLES`, as the caller, so only a store they can see) in one call: per
column, its kind, how often it is filled, how many values it has and, when they are 25 or fewer and
repeat, which and how often, over the newest 2,000 rows a list. `src/lib/scout.ts` writes it for
Luke's design and plan prompts as the exact fields of each list with rows; a turn tells it as the
`scout` step, and the Agents screen counts it. `design_format` gives the merchant's own AI the same
brief as `this_store` (`project_id` when they have more than one app).
The console's word searches have trigram indexes on conversation titles, project
names and shop domains. Every console screen asks `abo_admin_luke_health` (0165) whether
Luke's newest answers are failing because the model was not there (`payload.failed`), and
says so in red, with how many turns and apps since when and what to do, until an answer
comes through again.

A section over the store reads its table through `abo_store_page(p_module, p_query)` (0167): one page of the whole list (`offset`, `limit` up to 200), searched, filtered and sorted in SQL by the counters' rules, the merchant's own fields joined only when asked about, an order's dates as a range on `placed_ts`, the exact total, and on request each filter's values from the whole list. Readable where the counters are: the section shared with them and its store open to them. A yes/no field is filtered as a tick (`p_query.flags`, 0171): ticked, or every row not, blank and false alike. A list of events (orders, shipments, refunds and the like, `dated` in `store-read`) opens on its last 30 days when its design names no dates. A section of the owner's own rows reads `records` directly, 200 more a Load more, in reads of up to 1,000 (the server's most a request), so it goes on past a thousand.

## Rule logs

The Rules dialog asks `abo_rule_log(p_project)` (0172) what each rule has done: how many
times it ran, how many failed, and its last run (when, whether it worked, its error), over
both kinds of run, `automation_runs` for a rule of expressions and `code_jobs` for a rule of
code. It runs as the caller, so it counts only what their policies let them see.

## Invite links

The console's `invites` screen makes a link (`abo_admin_invite_create`) for one email or for several
people, for 24 hours to 30 days, and changes when it ends or withdraws it
(`abo_admin_invite_update`). `/start/[token]` asks `abo_invite_peek`, which anyone may
call and which answers only for that token: its state and, while it is open, the prefill.
Signing up there, or arriving signed in, calls `abo_invite_claim`, which takes a use once
per account, refuses a link made for another email, and lets an administrator look
without using it up. The name and business go into the account's metadata, where
onboarding picks them up.

## Error conventions

Routes return a concise user-facing `error` for expected failures and an appropriate HTTP
status. Model errors may also include a recovery hint. Partial build and undo responses
name both successful and refused operations; callers must not treat HTTP success as
proof that every requested plan stands.

The shared browser helpers `apiFetch` and `apiStream` attach the current access token and
normalize JSON/NDJSON handling. A stream ending without its final object is reported as
an interrupted turn, not a successful empty reply.
