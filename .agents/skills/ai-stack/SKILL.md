---
name: ai-stack
description: How Warmluke's AI layer is built and how to change it — model calls through the AI SDK (v7, direct providers), models chosen by settings, the store's tools declared once for MCP and Luke, and how each is tested. Use when adding or changing a model call, a model, a tool Luke or an MCP client can call, Luke's loop or stream, or when a model or tool check fails.
---

# Warmluke AI stack

Luke (the built-in assistant) and a merchant's own AI over MCP share one engine and one
set of tools. This skill says where each piece lives and the rules that keep it safe.
The architecture it serves is in [`docs/architecture/overview.md`](../../../docs/architecture/overview.md);
read its invariants first: models propose data, never code; a design is not a write; the
database decides who may do what.

## The pieces

| Piece | Where | What it is |
| --- | --- | --- |
| Model calls | `src/lib/ai.ts` (`callAnthropicChat`, `generate`) | AI SDK v7 `generateText`, straight to Anthropic (`@ai-sdk/anthropic`) or Google (`@ai-sdk/google`) on our own keys |
| Which model | `MODEL_JOBS` in `src/lib/ai.ts` | One table: each job (design, gap, fallback) reads its setting when called; the defaults are only for an unconfigured server |
| Failures | `ModelError` in `src/lib/ai.ts` | Every failure is one sentence for the merchant; the raw answer goes to the log under `[model]` |
| Store tools | `src/lib/store-tools.ts` | The six reading tools, declared once: name, description, JSON Schema, `run(args, { db, store })` |
| MCP | `src/app/api/mcp/route.ts` | Lists `STORE_TOOLS` (adding `shop_domain` and the artifact note) and its own approval flows |
| Luke's tools | `aiStoreTools(ctx, { only, observe })` in `src/lib/store-tools.ts` | The same tools as AI SDK tools, bound to one caller and one store, cut to fit (`fitForModel`) and heard as they run |
| Luke's loop | `runTurn` in `src/lib/engine.ts` with `lookups: true`, `callModel` in `src/lib/ai.ts` | Up to three lookups before the JSON reply (`LOOKUP_STEPS`), on the first attempt only; each told as a `lookup` step and kept for the receipt |
| Asking to change the shop | `src/lib/store-action-propose.ts` (`proposeStoreAction`, `aiProposeTool`) | One set of gates for MCP and Luke; only ever a request the merchant approves on a card; offered to Luke only when the account's switch is on |

## Rules

1. **Read the installed SDK, not memory.** The docs ship in `node_modules/ai/docs` and
   `node_modules/@ai-sdk/*/docs`. v7 renamed things (`system` → `instructions`,
   `stepCountIs` → `isStepCount`, `onFinish` → `onEnd`); code from older examples breaks.
2. **No model name in code.** A new job gets a row in `MODEL_JOBS` and a line in
   `docs/reference/environment.md`. A `gemini-…` name goes to Google, anything else to the
   Anthropic-format host, and a proxy (`ANTHROPIC_API_URL`) must serve every name it is
   sent, or it refuses them.
3. **Retrying is the caller's decision.** Calls pass `maxRetries: 0`; the SDK would
   otherwise try three times unseen. Gemini is retried once, then falls back to Anthropic.
4. **A reply is text until `parseReply` says otherwise.** Do not use `Output.json()` or a
   schema-enforcing output for designs: it throws on a reply that does not parse, and that
   reply belongs to the repair loop. Gemini's JSON mode is set by the `JSON_MODE` middleware.
5. **Keep prompt caching.** The first system block carries
   `providerOptions.anthropic.cacheControl`; the fixed contract is most of the bill.
6. **A tool reads with the caller's client, never the service role.** RLS is what makes
   a tool safe; a tool that needs more is a security-definer function with its own check.
   Store tools never write. Writing goes through `applyPlans` (`abo_build`) or a store
   action the merchant approves, never a tool's `run()`. A tool may *ask* for a store
   action (`propose_store_action`), and only through `proposeStoreAction`: it never runs
   one, and the card's sentence is the server's, never the model's. Anything a change
   aims at must be handed out by some list's `gives` (`check-store-action-propose`).
7. **Declare a tool once.** A reading tool Luke and MCP both need goes in `STORE_TOOLS`,
   with the store settled by the caller, never guessed inside the tool. Tools that only
   make sense for an outside client (approvals, requests) stay in the MCP route.
8. **Refuse before reading.** A bad argument returns `{ error: "<sentence>" }` before any
   query. Arguments are read leniently (`"10"` is ten), as clients send them.
9. **The loop has edges, all handled in `generate`.** A cap reached mid-lookup is answered
   by one more call with the lookups folded into words and no tools, never by
   `toolChoice: "none"`: the SDK then drops the tools, and Anthropic refuses tool calls
   with none declared. Gemini refuses JSON mode beside tools, so `JSON_MODE` stands aside
   when a call carries them. A tool that is not in `LUKE_TOOLS` is not Luke's; `ask_store`
   is left out because the turn's question was routed already.
10. **What was read is told by the tool, not the model.** `observe` hears a lookup once it
   has run; that is the step the merchant sees and the receipt the answer carries. A prompt
   offers lookups only when the call has tools (`canLookUp`).
11. **A draft is never the reply.** With `onText`, a call streams (`streamText`); every
   other caller keeps the plain call. `draftMessage` reads the reply's `message` out of
   JSON still arriving; the route sends it as `words` lines, throttled, and drops the one
   waiting when the turn ends. A new attempt clears the draft. Stream failures are thrown
   and mapped to the same `ModelError` sentences (`StreamProviderError` too).

## Adding a store tool

1. Add it to `STORE_TOOLS` with a description a model can act on and a JSON Schema whose
   `required` names only properties it has.
2. Return a plain object; say which store, which currency and whether rows are partial.
3. Extend `scripts/check-store-tools.mjs` (its name list, and its refusal) and the tool
   catalogue in `docs/integrations/mcp.md`.
4. If it reads a new table, its RLS decides what callers see; prove it with a live check.

## Testing

- `check-model-errors` (pure) stands in for `fetch`: it reads back each provider's request
  as sent, the one-sentence failures, one attempt only, and the Gemini fallback. Change the
  model layer and this must still pass unchanged, plus a new assertion for what you added.
- `check-store-tools` (pure): one list, MCP sends it, refusals before any read, the words
  each lookup is told in, the size guard.
- `check-luke-lookups` (model tier, by hand, cents): a real turn that must look an order
  up, with the router off so only a lookup can find it, and one that must not.
- Live, through a real server: start
  `(set -a; . ./.env.check.local; set +a; pnpm exec next dev -p 3101)` and run the checks
  with `ENV_FILE=.env.check.local APP_URL=http://localhost:3101`. Without `ENV_FILE` a
  check reads `.env.local`, which is production. Use `localhost`, not `127.0.0.1`: the MCP
  discovery check compares the host.
- One real call per provider is worth its cents after changing the model layer: it proves
  the host accepts what the SDK sends. Never loop real calls.

## Not here, on purpose

No Python agent, no graph framework, no second runtime, and no browser-run tools: the
database-centred security model does not survive them. A new framework is proposed to the
user with pros and cons, never adopted unasked.
