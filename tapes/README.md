# Model tapes

Recorded answers from real models, played back by the checks so they run free,
identically, and without keys (in CI too). Written and read by
[`src/lib/model-tape.ts`](../src/lib/model-tape.ts); nothing else touches them.

- `<key>.json`: one request's answers, in the order they came. The key is the request
  itself (system prompt, conversation, tools) with run-to-run noise (ids, dates, store
  addresses) replaced by placeholders, tool calls numbered by position (Gemini's call ids
  are made up by the SDK), and without the model's name. `asked` is the last
  thing the user said, for you; `parts` fingerprints what the key is made of.
- `_models.json`: which models answered when these were recorded. Replay uses these, so a
  call takes the road it was recorded on.

Only answers, fingerprints and the last few words asked are kept: never a key, a header
or a system prompt. The answers are about the checks' own throwaway stores.

## When a check says "no recording"

The request changed. The log line says whether the system prompt did (what the model is
told), the tools did, or the conversation did. If the change is intended, record again,
with the check database idle (`gh run list --limit 1` says completed):

```sh
# the router eval: no database, no server
MODEL_TAPE=record node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-route-eval.mjs

# checks that talk to the server (check-luke-lookups, check-ask-store,
# check-judged, check-as-client): the dev server records too
(set -a; . ./.env.check.local; set +a; MODEL_TAPE=record pnpm exec next dev -p 3101)
MODEL_TAPE=record ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
  node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-luke-lookups.mjs
```

A check that talks to the server refuses to run when the server records or plays back
differently from it (the `x-model-tape` header says which), since the two halves would
then answer from different places.

Then replay once with no keys to confirm, and commit the tapes with the change that
needed them. Two things that broke replays, so they are not done again: the same data
must read the same to the model (a list with ties has to break them by what the rows
say, never by the database's order), and two specs must not send the same request, or
they share one recording and can replay each other's answers (the e2e projects are named
for their width for that reason). Answers that stop being used can be deleted: a file no request names is never
read. Review a re-recorded answer the way you would a code change: it is what the checks
now hold Luke to.
