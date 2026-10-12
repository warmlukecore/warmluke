# Luke as an agent (`LUKE_AGENT=on`)

Status: built 12 Oct 2026, **off by default**. With the switch off, nothing any model is sent
changes, and every recording replays as before.

## Why

The design road asked the model for **one JSON reply**, written whole under a contract of about
72,000 characters (~20,000 tokens) with 134 ALWAYS/NEVER/MUST rules and a capability list that
said "this list is exhaustive; anything not here does not exist". When the validator refused one
part, the whole reply went back. There was no loop of look, try, test and fix. The model spent its
thinking on the form, not on the merchant's problem.

## How it works

On Luke's own chat (not a design another assistant drew), with the switch on, one attempt of
`runTurn` is a tool loop (`src/lib/agent.ts`, `runAgent`):

1. **Think in words, and read.** The store tools, `read_section`, `rule_runs`, and `test_build`
   (what is already built, tried on their data: `lib/verify-tool.ts`).
2. **Read the exact grammar when it is needed.** `guide(topics)` hands out the design contract's
   own words by topic: plan, store_sections, features, rules, code_rules, screens, views,
   sections, questions, writing, on_screen, hard_rules, simpler. No rule was rewritten:
   the topics are cut from the contract by its own headings, and `check-agent-loop` fails if
   a heading moves.
3. **Build in small checked steps.**
   - `draft_change` puts one change into the design. The **whole** design is then checked by the
     same validator the old road used (`parseReply`, plus made-up rows beside the store's).
   - A change that adds a problem is refused, and the problem comes back to Luke as the tool
     result, in the validator's words. Nothing is added, and he fixes it on the spot.
   - `replace_change` and `drop_change` mend the draft.
4. **Try it on real rows.** `test_draft` runs the draft's rules on the rows they would meet
   (`dryRunRules`) and checks the values it leans on (`checkAgainstData`). Nothing is written.
5. **Finish.**
   - `finish` takes Luke's words, the design he drafted, and next steps. With
     `proposal: true`, it says how a bigger build would work and asks; "Build it" then agrees
     to it through the same `proposalOf` the plan step used.
   - Or `ask_owner`, which sends the questions as a clarify.

What the loop ends in is the reply the engine always read. So everything after an attempt is
unchanged: the new-section gate (a card first), the reuse question, the critic, the review gate,
the gap pass, `plainReply`, the receipt, the meeting's marks, the approval card, apply, the thread
and durable legs. A send-back (validator, critic or review gate) returns into the loop with "mend
the design with your tools", and the next attempt starts from the design it had (`draftOf`).

**After a build**, `/api/apply` tries what was saved on the store's real data
(`testAfterBuild`, `lib/verify.ts`). It writes what the test showed on the build's own line, and
the panel shows it beside the browser walk, with **Fix it** on each problem.

Luke's contract (`agentContract`) is about 19,000 characters, not 72,000. It holds who Luke is,
how he works, the building blocks (`buildingBlocks()`: the same lists, said as what an app is made
of, with code and written screens as the way out), where each thing works, and the guide's index.
The validator behind the tools still refuses what does not exist, so the words can be generous
while the build stays exact.

## Budgets

| Setting | Default | What |
| --- | --- | --- |
| `LUKE_AGENT` | unset | `on`: Luke's chat turns run as the agent loop |
| `LUKE_AGENT_STEPS` | 24 | Model steps in one attempt, at most |
| `LUKE_AGENT_MS` | 100000 | How long one attempt may work; never past the leg's deadline |

When the steps or the time run out, a draft is shown as "the design so far". With nothing drafted,
the attempt counts as refused, and the next attempt gets what went wrong.

Every agent turn uses the design model (or the owner's pick in the panel), at the design effort.
The plan step and the operator's view are skipped: Luke says his plan in words himself.

## Try it by hand

On localhost:

1. Add `LUKE_AGENT=on` to the server's env and restart it, with `MODEL_TAPE` unset on a real key.
   **Never on :3101**, which stays on replay.
2. Ask for something new: "I lose track of repairs, make me something for it". He should talk it
   through and end "Want me to build it?". Say "Build it".
3. Ask a store question that needs counting ("how many orders are still COD pending"). He should
   look it up and quote the **matched** count.
4. Ask for a rule over rows you have ("flag orders not shipped in 2 days"). His message should say
   what the test showed (how many rows it would flag).
5. Approve a build. The build's line should get "Tested on your data: …".

On production: set `LUKE_AGENT=on` in Vercel for the production env, redeploy, and try the same
in a test account (Luke test). Unset it to go back; nothing else changes.

## Checks

- `check-agent-loop` (pure):
  - the guide is the contract's own words;
  - a refused change comes back in the check's words and is never added;
  - the reply shapes, a repair from the draft, and out of steps;
  - the history note, the cut-and-said fold, and the stock count.
- `check-agent-turn` (live, model stood in): a whole `runTurn` with the switch on, through the real
  validator and gates to the card; then built, tested after the build on the check project, and
  said on the line. With the switch off, the same ask takes the old road and never sees the agent's
  tools.

## Making it the default, later

Turning it on in CI means Luke's design-road recordings would no longer match: the requests change
from one JSON reply to a tool loop. Re-recording the taped checks that design (about 15 turns across
check-luke-lookups, check-builds-on-store, check-meet-turns, check-answer, check-chat-stream and the
e2e Luke specs) is roughly **$4–8** on Opus 5.5 at today's token counts. A loop is several cached
calls per turn instead of one. Measure on the scenario suite (`evals/`) before switching.
