---
name: conversation-autopsy
description: Take apart one Luke conversation from production, read only — the owner's words and Luke's replies in the shop's time, each turn's road, model, seconds and cost, what was built, the rules it made and whether they ever ran, the radar's signs, and what went wrong. Use when a merchant reports a problem, a conversation id or turn id shows up in a report or in the console's Needs a look, or someone asks "what happened in this conversation".
---

# Conversation autopsy

One command tells a conversation's story from the database, the way Tanish's first meeting
(a57134fd, 11 Oct) was taken apart by hand: five builds in two hours, rules that never ran,
"I can't see your custom rows", and an owner who ended up calling Luke stupid.

```sh
node scripts/autopsy.mjs <conversation-id>                      # production (.env.local)
node scripts/autopsy.mjs <conversation-id> --env .env.check.local
node scripts/autopsy.mjs <conversation-id> --full               # whole messages, not clipped
```

It only reads: every query goes through the Supabase management API with `read_only`, so it is
safe against production. It needs `SUPABASE_ACCESS_TOKEN` and the project URL in the env file.

Given a turn id instead of a conversation id, find the conversation first:
`select conversation_id from messages where id = '<turn>'` (a reply's message id is its turn).

## What it prints

- **The story:** every message in the shop's timezone. Owner words come from `payload.text`.
  Luke's come from `payload.message`, with the type (answer, blueprint, plans, clarify, build,
  stopped, unanswered). Each reply carries its turn: road, model, seconds, $, repairs, and
  whether the critic sent it back.
- **Turns by road:** count, cost, average and longest time, and the models used.
- **Builds:** each one applied, with what it changed.
- **Rules made while it ran:**
  - on or off, the trigger, and how often it ran (`automation_runs` and `code_jobs`);
  - how many rows it wrote, and reads cut short (0206).
  - A rule that "never ran", or ran and changed nothing, is the first thing to suspect when an
    owner says "it isn't syncing".
- **Signs:** the same ones the radar keeps (0211), worked out here, so it also works on a
  database without 0211:
  - slow and stopped turns, repairs, design sent back, unmet asks;
  - Luke saying he can't, the owner unhappy, rebuild loops;
  - rules failing, idle or cut short;
  - an owner who left a plan or question unanswered.
- **What went wrong:** the signs, grouped into a short list to act on.

## How to read it

- **Many builds close together** means Luke rebuilt instead of agreeing one design first. Look
  at what the owner said between builds: usually a requirement Luke should have asked about
  before the first build.
- **"Luke says he can't"** is either a missing tool (something he should be able to read or
  do), or a real wall in the platform. Name which. Never accept the owner's fault as the
  explanation.
- **A rule that never ran** after the owner did the thing it waits for means the platform did
  not fire it, or it fired and logged nothing. Check `automation_runs` for that rule, then the
  route that should have run it (`lib/code-rules`).
- **Cost and time:** design turns over 90 s are felt; the owner stopping a turn and typing "?"
  is the sign.

## After an autopsy

- Fix the root in the platform, not the one merchant's data. Then check: would the fix have
  caught every other conversation with the same sign? The console's Needs a look lists them
  (`abo_admin_trouble`).
- Write a reply the merchant can read: what broke, why, what changed. Own our part plainly.
- The patterns for "can't" and "unhappy" live in two places: `scripts/autopsy.mjs` and
  migration 0211's `abo_trouble_scan`. Change both together.
