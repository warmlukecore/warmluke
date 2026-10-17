# Luke evals

Luke in whole conversations, against a running app, graded. A check asks one thing and
reads one answer; what goes wrong with Luke goes wrong over a conversation (the RTO
tangle took four turns, each reasonable on its own). So each case here is an owner with a
problem. Its opening goes to the running app as the panel sends it, a simulated owner
answers Luke only from the case's facts and says yes when the plan fits, the yes is built
as the panel builds it (`POST /api/apply`), and what is left in the app is graded.

- `cases/*.json`: forty-six owners, in our own words: the first eight on the seeded shop,
  twenty-four more on six other kinds of business (12 Oct), six asks real owners made that
  went wrong in production (`r-…`, 15 Oct), five first meetings (`m-…`, 15 Oct), and three
  investigations (`i-rto-why`, `i-runs-out`, `i-ads-stock`, 17 Oct) on a shop with its
  connections. No real store, person, phone number,
  email or order number: the repository is public, and `check-eval-harness` fails a case
  that holds an email, an eight-digit number or an id.
- `runs/<YYYYMMDD-HHMM>-<label>.json`: one run each (UTC minute). `runs/index.json` lists
  them; `runs/all.ts` imports them for the console page. The harness writes all three; none
  is edited by hand.
- `acceptance/`: the sprint's acceptance (16 Oct). `scripts/acceptance.mjs --label <name>` runs
  every check the ten critical scenarios stand on (`src/lib/acceptance.ts`), and with
  `--max-usd` every case three times on a fresh store (`eval-luke --repeat 3`, in two halves),
  then writes `acceptance/<name>.md`: the checks, 68 of 75 runs as the bar, every critical
  case on every run, p50 and p95 by kind, and the failed runs. `owner-session.md` is the
  owner's 30 minutes with no developer, and how a failure is captured.
- `scripts/eval-luke.mjs`: the harness (`--repeat 1-3`: each case that many times). `scripts/check-eval-harness.mjs`: its logic, tested
  without a model, a server or a database (pure tier, in CI).
- `src/lib/eval-report.ts`: what a run is, and how a pass, a sign, a score out of 10 and the
  summary are counted, for the harness and the page alike.
- `scripts/fixtures/shops.ts`: seven more shops as data (phone cases, clothes in sizes,
  skincare, gadgets, snacks, wholesale, and ethnic wear with what its connections bring: a
  courier's shipments where RTO rose on COD, two sizes that run out before the restock, and an
  ad export, marked a dated export, whose Diwali campaign sells them);
  `scripts/fixtures/business-shop.ts` turns each into the Shopify-shaped nodes `seed-shop.ts`
  makes and saves them through the import's savers. `check-investigation-shop` seeds ethnic
  wear and reads it with the database's own tools, so its cases are graded on what is there.
- `expect.mjs`: what each case expects, worked out from the very nodes its store was seeded
  with, so a change to a shop moves its answers with it.
- `scripts/check-eval-graders.mjs` (live, no model): every shop saves, and the graders pass a
  right build and fail a wrong one on real rows read as the screen reads them.

## The cases

| Case               | Language | What it tests                                                                                                                                                                 |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rto-new`          | Hinglish | RTO from nothing: Luke asks what an unmarked shipment means; RTO is one tick (true or blank), with a filter and a count; no status beside it, no rule filling every row         |
| `rto-cleanup`      | Hinglish | A Shipments section with RTO kept three ways (`rto`, `rto_status`, `is_rto`) and a note: the extras go, the note is hidden but kept, nothing new is added                      |
| `repeat-orders`    | English  | Flag repeat orders: a rule or worked-out flag over the store's orders, matching phone or email, with the 90-day window asked or stated                                         |
| `returns-screen`   | Hinglish | Asked for a "screen": a table with a row form that fills from the order is preferred; a written screen, if any, reads only real sections, looks like the app, has empty states |
| `cod-confirm`      | Hinglish | COD confirmation: To call / Confirmed / Cancelled, new COD orders start at To call, a filter or view of who is left to call, nothing cancelled in Shopify                       |
| `low-stock`        | English  | An alert rule on stock at 5, not a field written into every product every hour                                                                                                 |
| `repeat-customers` | Hinglish | Customers with more than one order shown, and Luke asks whether "tag" means a Shopify tag (a store change, which needs the owner's yes) or a mark in the app                    |
| `return-reasons`   | English  | The reason as one choice from sensible options, and a weekly count or chart                                                                                                    |

Every build case also asks that the plan is said in plain words before anything is built,
with no field names or types, ending by asking whether to build; and fails jargon such as
"boolean" or "set_fields" in what the owner reads.

The twenty-four from 12 Oct, by kind. Each names its shop (`shop`) and what code checks
(`expect`):

| Kind | Cases | Graded by code |
| ---- | ----- | -------------- |
| `question`: one answer from the store | q-cod-pending, q-discount-use (seed); q-out-of-stock (cases); q-top-size (fashion); q-week-vs-week (cosmetics); q-big-cod (gadgets); q-repeat-buyers (snacks); q-owed, q-top-customers (wholesale) | the number, or the names, worked out from the shop are in what Luke said |
| `question`: an investigation | i-rto-why, i-runs-out, i-ads-stock (ethnic) | the rates, days and names worked out from the shop are in what Luke said; the window, the evidence, that it was seen and not proven, and a next step are judged |
| `build`: rows a design must point at | o-repeat-cod (snacks), o-not-shipped (fashion), o-call-list (gadgets), o-overdue (wholesale), o-expiring (cosmetics, its batches kept in the app), i-reorder (fashion), i-sku-twins (cases) | a field of the owner's marks exactly those rows, or a counter shows how many, or a rule's dry run matches them |
| `build`: an event rule, used | o-blank-stock (cases) | after the build, the owner ties designs to their blank and sets the blank's count through `/api/records`; every design then shows it |
| `vague`: a question first | v-warranty (gadgets), v-track-better (snacks) | the first reply asks, and draws nothing |
| `limit`: a plain no | l-whatsapp (fashion), l-amazon (cosmetics) | Luke says plainly he can't |
| `build` with a follow-up | f-cod-callers (seed), f-dues-per-invoice (wholesale), f-blank-rename (cases) | two builds at most, and the second changes what is there rather than deleting it and making it again |

The six from real conversations (15 Oct), each an ask that went wrong in production, retold
without the owner's names or numbers. `--set real` runs them:

| Case | What went wrong then | Graded by |
| ---- | -------------------- | --------- |
| `r-analytics-cod` | Net sales left out delivered COD orders whose payment still said pending | criteria |
| `r-keep-orders-table` | A chart was added by removing the orders table already there; its range was fixed | criteria, two builds, the second an edit |
| `r-pack-scan` | An order scanned twice gave no warning | criteria |
| `r-pnl-month` | Months were rolling 30-day windows | criteria |
| `r-repeat-cancel` | What the cancel pick does in Shopify was not said | criteria |
| `r-price-filter` | A price bracket was written into every order by rules, where a Min and Max filter does it | criteria |

The five first meetings (15 Oct, `kind: "meet"`, `"meeting": true`), `--set onboarding`: the
check user is made a new owner for the case (`profiles.met_luke_at` cleared, put back after),
Luke speaks first, the case's `opening` is the owner's first words, and the meeting ends once
their store opens (`open_store`).

| Case | What it tests | Graded by |
| ---- | ------------- | --------- |
| `m-informed` | His first words use one or two real things from the store, then one open question | criteria; no design in the first three replies (`talks`) |
| `m-discovery` | "Returns eat my day": how it happens and who does it, before any idea | criteria; no design in five replies |
| `m-exit` | "Take me to the dashboard" first: in at once | `opens` |
| `m-exit-hinglish` | "Skip karo, dashboard dikhao": in at once | `opens` |
| `m-policy` | The published 7 days and the 15 days in practice, both kept | criteria; no design in three replies |

Not covered here: a store whose import is slow, partial or failed (the sprint's second case);
the harness seeds the shop whole before the first turn.

The shops are built so a window can't straddle a row (no order 6–8, 13–15 or 28–32 days back
where a case asks about that window), no count sits on a threshold a case names, and where a
window matters an older row would win if the window were ignored. `smoke: true` marks the six
cases `--set smoke` runs: q-cod-pending, q-big-cod, o-repeat-cod, v-warranty, l-whatsapp and
f-cod-callers.

A case file: `id`, `title`, `language` (`hinglish` or `english`), `persona`, `before` (plans
applied through `/api/apply` before the conversation, or `[]`), `opening`, `facts` (topic →
what the owner would answer; anything else gets "aap decide karo" / "you decide"),
`success`, `must_not`, `max_turns`.

## How a case is graded

0. **The outcome, by code first** (the `checks`, 12 Oct): what the case's `expect` names, plus,
   on every case, `capable`: no "I can't" or "nahi kar sakta" where the platform can (or, on a
   `limit` case, `honest`: a plain one). A question ends once it is answered; a vague or limit
   case is one turn. A case's **score out of 10** is the share of its checks passed, criteria
   met and must-nots clear; a run's score is the mean. A case passes when every check passes
   too.
1. **Code, no model** (the `signs`): 0175's workaround signs in JavaScript (a schedule
   writing fields with no condition; three or more yes/no, status or choice fields sharing
   a word; a written screen over rows a table shows), builder's words in what the owner read
   (types, rule parts, a field's own `snake_case` name), whether a plan in words came before
   the build, and the number of turns.
2. **A grader model**, Reality Checker style: each `success` and `must_not` item answered
   yes or no. A yes needs an exact quote, and the harness checks the quote is really in the
   conversation or the app; a yes without one is not counted. An answer that is not JSON
   meets nothing and rules out nothing. It scores 1 to 5: discussed first, plain words,
   better idea, simplest design, and treats a 5 as suspicious.
3. **Cost and time**: Luke's priced usage per turn (from the turn's trace, as the console's
   Spend page reads it), the simulated owner's and the grader's own calls priced with
   `src/lib/model-prices.ts`, and each turn's time until its answer settled.

A case **passes** when every success criterion is met and no must-not is hit. Signs are
counted beside it, not in it.

## How to run

The check project only. Start the check server calling the real model (no `MODEL_TAPE`),
with the model settings you are measuring (production's are in
`docs/reference/environment.md`), then run the harness from the repository's root:

```sh
# one terminal: the check server
(set -a; . ./.env.check.local; set +a; pnpm exec next dev -p 3101)

# another: the run
ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
EVAL_SIM_MODEL=claude-haiku-4-5 EVAL_GRADE_MODEL=claude-haiku-4-5 \
node scripts/eval-luke.mjs --label before --max-usd 1.5
```

- `--label`: what this run is (`before`, `after-rto-prompt`); it names the file.
- `--max-usd`: the cap, in dollars (at most 10, the whole budget). Required.
- `--cases rto-new,low-stock`: only these.
- `--set smoke`: the six cheap cases across every kind; `--set full-a` and `--set full-b`: every
  case in two halves, each under its own cap; `--set full`: all of them under one.
- `--design-model claude-sonnet-5`: the owner's pick in the panel, sent with every turn.
  Refused before anything is spent when the check account may not use it, since the chat
  route would quietly use the default instead.

It refuses to start without `CHECK_PROJECT=1` in the env file, `APP_URL`, `EVAL_SIM_MODEL`
and `EVAL_GRADE_MODEL` (each with a price), a model key (`ANTHROPIC_API_KEY` from the
environment or the env file), or with `MODEL_TAPE` set; and when the server at `APP_URL` is
built for another project. It stops at the first turn when the server plays its calls back
from tapes. It prints the plan before starting and the running spend after every case.

Each case makes a throwaway project with the seeded shop in it (`scripts/fixtures/seed-shop.ts`)
and deletes it at the end. For the run the check account's designs are unlimited, and put back
after. Commit what it wrote: the run file, `runs/index.json` and `runs/all.ts`.

## What it costs

With the thirty-eight cases (15 Oct), production's models (Opus 5.5 designing, Sonnet 5 talking
and criticising) and Haiku as owner and grader:

| Kind | Per case | Cases | Basis |
| ---- | -------- | ----- | ----- |
| question | about $0.10 | 9 | one talk turn with one to three lookups on a fresh thread, about 15–25k tokens in and 600 out, plus the grader |
| vague, limit | about $0.12 | 4 | one turn, plus the grader |
| build | about $0.35 | 8 | the measure below; the code checks cost nothing (no model) |
| build with a follow-up | about $0.70 | 3 | two builds |
| the first eight | about $0.32 | 8 | below |

- **Smoke** (6): about **$1.5** (0.10 + 0.10 + 0.35 + 0.12 + 0.12 + 0.70). `--max-usd 2.5`.
- **Real** (6): about **$2.5** (five builds and one with a follow-up). `--max-usd 3.5`.
- **Full** (38): about **$11.3** (0.90 + 0.48 + 2.80 + 2.10 + 2.56, and the six real at 2.45). Run it as `--set full-a --max-usd 7`
  and `--set full-b --max-usd 7`; each half is counted before it is spent and stops at its cap.

```sh
ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
EVAL_SIM_MODEL=claude-haiku-4-5 EVAL_GRADE_MODEL=claude-haiku-4-5 \
node scripts/eval-luke.mjs --label smoke --set smoke --max-usd 2.5
```

The first eight alone, as measured before:

About **$0.32 a case** with production's models (Opus 5.5 designing and planning, Sonnet 5
as critic), about **$2.60 for all eight**. How:

| Part                    | Per case    | Basis                                                                                                                                                                            |
| ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Luke's build turn       | about $0.18 | Opus 5.5 designed 20 asks for $3.63 with its plan step and critic (`docs/reference/environment.md`, 2026-09-25)                                                                  |
| Luke's turns before it  | about $0.12 | One or two plans in words or answers: the plan step alone, about 8–10k tokens in and 600 out on Opus 5.5 ($4 in, $5 cache write, $20 out per million), $0.05–0.08 each            |
| The simulated owner     | under $0.01 | Haiku 4.5 ($1 in, $5 out per million): up to three lines, each about 1.5k tokens in and 100 out                                                                                  |
| The grader              | about $0.015 | Haiku 4.5: the conversation and the build, 5–8k tokens in and about 800 out                                                                                                     |

A case that goes to four turns, or needs a repair, can reach $0.50. With $10 for every eval,
that is two full runs (a before and an after) with room for a rerun of the cases that moved.

Not in the number: what the server does after a turn outside the turn's meter (what Luke
learns, `ANTHROPIC_MEMORY_MODEL`, a fraction of a cent a turn; the shadow judge on designs).

## The cap

Before every call it makes and every turn it asks, the harness counts what that could cost
and stops when what is spent plus that would pass `--max-usd`:

- a Luke turn is counted at **$0.30** (the $0.18 design, half again for a repair or a
  lookup), or at the case's average so far when that is dearer: a case's first turn is a
  cheap plan in words, and its average alone would under-guess the build after the yes;
- an owner's line and a grading are counted from the characters sent (3.5 to a token, at
  the cache-write price) and 400 or 2,000 tokens back;
- every turn and owner's line also keeps back the grading of its case, so a case that
  starts can be graded.

What it measures afterwards replaces the count. A turn dearer than its count can pass the
cap by the difference, which the $0.30 is set high to make rare. A run that stops writes the
cases that finished, marked partial, with everything spent; the case it stopped in is kept
under `unfinished`, what was said and traced so far, never graded. Every case keeps each
turn's trace (`trace`: its steps, repairs and what the validator refused), since the turn's
own trace goes with the case's project. With the cap at 1.5 a run stops
after three or four cases: give a full run about 3, or run it in halves with `--cases`.

## Reading the page

The console's **Evals** page (`src/app/[gate]/evals/page.tsx`) reads the committed runs, so
it works in production with no database.

- **The runs**, newest first: label, date, design model, cases, how many passed, the average
  score (and each of the four), the signs, the cost and the average time of a case.
  **Partial** means the cap or a failure stopped it early.
- **Before and after**: pick two runs. For each case, passed or failed in each, every
  criterion met before and after, every must-not hit or clear, and what each score, the
  signs and the cost moved by.
- **The cases** of the run picked in the list: each criterion with the grader's quote
  ("not counted" when the quote was missing or not really there), the must-nots it hit, the
  signs, the scores and the conversation.

**A run is compared only with a run on the same design model.** A change of model moves
every number, and would be read as the change being tested; the page says so and shows no
comparison when the two models differ. To compare models, run the same cases on each and
read them side by side, not as a before and after.
