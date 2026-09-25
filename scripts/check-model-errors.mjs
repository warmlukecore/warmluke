// When the model is not there, the merchant reads one sentence.
//
// A provider's refusal used to reach the chat as it came — a status
// code and three hundred characters of somebody else's JSON, "credit
// balance" and all. Now every way a model call can fail becomes one
// of a few kinds, each with a sentence that says what happened, that
// nothing changed, and whether trying again is any use. The raw
// answer goes to the server log instead, under one prefix.
//
// No network: fetch is stood in for, so each status can be dealt, and
// what each provider is sent can be read back. The calls go through the
// AI SDK; this is what holds that the SDK changed nothing the merchant or
// the bill can see: the request, the text, the failures, one attempt.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-model-errors.mjs

import { callAnthropicChat, callModel, draftMessage, ModelError } from "../src/lib/ai.ts";
import { jsonSchema, tool } from "ai";
import { isTransient } from "../src/lib/retry.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// The provider, stood in for: a queue of answers, dealt in order, and
// every request it was sent, kept.
const queue = [];
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  sent.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
  const next = queue.shift();
  if (next instanceof Error) throw next;
  return new Response(next.body, { status: next.status, headers: { "content-type": next.type ?? "application/json" } });
};
// The log line is the raw answer's home; caught here so the run stays readable.
const logged = [];
const realError = console.error;
console.error = (line) => logged.push(String(line));

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ANTHROPIC_MODEL = "claude-test";
delete process.env.ANTHROPIC_API_URL;

const call = () => callAnthropicChat("system", [{ role: "user", content: "hi" }]);
const failing = async (status, body) => {
  queue.push({ status, body });
  try {
    await call();
    return null;
  } catch (e) {
    return e;
  }
};

try {
  console.log("each way a model call fails reads as one sentence");
  const billing = await failing(
    400,
    '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'
  );
  check(
    "out of credit: paused, on our side, nothing changed",
    billing instanceof ModelError && billing.kind === "billing" && /paused.*our side.*Nothing was changed/.test(billing.message)
  );
  check("and the provider's JSON never reaches the sentence", !/credit balance|invalid_request_error|\{/.test(billing.message));
  check("but does reach the log, under one prefix", logged.some((l) => /^\[model\] anthropic 400 billing: .*credit balance/.test(l)));

  const auth = await failing(401, '{"error":{"type":"authentication_error"}}');
  check("a refused key: on our side, not a retry", auth?.kind === "auth" && /our side/.test(auth.message) && !isTransient(auth));
  const busy = await failing(429, '{"error":{"type":"rate_limit_error"}}');
  check("busy: try again in a minute, and worth a retry", busy?.kind === "busy" && /try again/.test(busy.message) && isTransient(busy));
  const overloaded = await failing(529, '{"error":{"type":"overloaded_error","message":"Overloaded"}}');
  check("overloaded reads as busy too", overloaded?.kind === "busy");
  const down = await failing(503, "<html>503 Service Temporarily Unavailable</html>");
  check("a 503 page: could not reach the model, worth a retry", down?.kind === "down" && /could not reach/.test(down.message) && isTransient(down));
  const refused = await failing(400, '{"error":{"type":"invalid_request_error","message":"prompt is too long"}}');
  check("any other 400 is refused, not billing", refused?.kind === "refused" && !isTransient(refused));
  queue.push(new TypeError("fetch failed"));
  let dropped = null;
  try {
    await call();
  } catch (e) {
    dropped = e;
  }
  check("a dropped connection is the model being down", dropped?.kind === "down" && isTransient(dropped));
  const empty = await failing(200, '{"content":[]}');
  check("an answer with nothing in it says so", empty?.kind === "empty" && /answered with nothing/.test(empty.message));

  console.log("\nand a stop is still a stop");
  const abort = new Error("aborted");
  abort.name = "AbortError";
  queue.push(abort);
  let stopped = null;
  try {
    await call();
  } catch (e) {
    stopped = e;
  }
  check("an abort passes through untouched, not dressed as an outage", stopped?.name === "AbortError" && !(stopped instanceof ModelError));

  console.log("\nno key at all");
  delete process.env.ANTHROPIC_API_KEY;
  let unset = null;
  try {
    await call();
  } catch (e) {
    unset = e;
  }
  check("says so in a sentence, and is not retried", unset?.kind === "unset" && /no model key/.test(unset.message) && !isTransient(unset));

  console.log("\nwhat Anthropic is sent, and what comes back");
  process.env.ANTHROPIC_API_KEY = "test-key";
  const reply = (text) => ({
    status: 200,
    body: JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-test",
      content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  });
  sent.length = 0;
  queue.push(reply('{"type":"clarify"}'));
  const text = await callAnthropicChat(["the contract", "this project"], [
    { role: "user", content: "track bikes" },
    { role: "assistant", content: "which stages?" },
    { role: "user", content: "intake, done" },
  ]);
  const req = sent[0];
  check("the text comes back whole, for parseReply to judge", text === '{"type":"clarify"}');
  check("to the messages URL, on our key", req?.url === "https://api.anthropic.com/v1/messages" && req.headers.get("x-api-key") === "test-key");
  check("the model named, and replies capped at 6000 tokens", req?.body?.model === "claude-test" && req.body.max_tokens === 6000);
  check(
    "the contract is cached, what changes per project is not",
    req?.body?.system?.length === 2 &&
      req.body.system[0].text === "the contract" && req.body.system[0].cache_control?.type === "ephemeral" &&
      req.body.system[1].text === "this project" && !req.body.system[1].cache_control
  );
  check(
    "the whole conversation goes, in order",
    JSON.stringify((req?.body?.messages ?? []).map((m) => [m.role, typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("")])) ===
      JSON.stringify([["user", "track bikes"], ["assistant", "which stages?"], ["user", "intake, done"]])
  );
  check("and nothing the call never set, like a temperature", req?.body && !("temperature" in req.body) && !("top_p" in req.body));
  sent.length = 0;
  await failing(529, '{"error":{"type":"overloaded_error"}}');
  check("a failure is tried once: retrying is the caller's call", sent.length === 1);
  process.env.ANTHROPIC_API_URL = "http://localhost:4010/v1/messages";
  sent.length = 0;
  queue.push(reply("ok"));
  await call();
  check("ANTHROPIC_API_URL still points the same call elsewhere", sent[0]?.url === "http://localhost:4010/v1/messages");
  delete process.env.ANTHROPIC_API_URL;

  console.log("\nwhat Gemini is sent, and the way back to Anthropic");
  process.env.GEMINI_API_KEY = "gemini-key";
  const gemini = (text) => ({
    status: 200,
    body: JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }),
  });
  sent.length = 0;
  queue.push(gemini("not json at all"));
  const said = await callAnthropicChat(["the contract", "this project"], [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ], undefined, "gemini-test");
  const g = sent[0];
  check("a reply that is not JSON comes back raw, for the repairs, not as an error", said === "not json at all");
  check("to the model's generateContent, on the Gemini key", (g?.url ?? "").endsWith("/v1beta/models/gemini-test:generateContent") && g.headers.get("x-goog-api-key") === "gemini-key");
  check("asked for JSON, capped at 6000", g?.body?.generationConfig?.responseMimeType === "application/json" && g.body.generationConfig.maxOutputTokens === 6000);
  check("the blocks as one instruction", g?.body?.systemInstruction?.parts?.map((x) => x.text).join("") === "the contract\n\nthis project");
  check("and the assistant speaking as the model", JSON.stringify(g?.body?.contents?.map((c) => c.role)) === '["user","model","user"]');
  sent.length = 0;
  queue.push({ status: 503, body: "busy" }, { status: 503, body: "busy" }, reply("from anthropic"));
  process.env.ANTHROPIC_FALLBACK_MODEL = "claude-fallback";
  const fell = await callAnthropicChat("s", [{ role: "user", content: "hi" }], undefined, "gemini-test");
  check(
    "Gemini busy twice: Anthropic answers instead, on the fallback model",
    fell === "from anthropic" && sent.length === 3 && sent[2].body?.model === "claude-fallback"
  );

  console.log("\nlooking things up before replying");
  process.env.ANTHROPIC_API_KEY = "test-key";
  const ran = [];
  const lookups = (steps) => ({
    steps,
    tools: {
      get_order: tool({
        description: "One order by number.",
        inputSchema: jsonSchema({ type: "object", properties: { order_number: { type: "string" } }, required: ["order_number"] }),
        execute: async (input) => {
          ran.push(input);
          return { order_number: input.order_number, financial_status: "PAID", total: 1499 };
        },
      }),
    },
  });
  const toolUse = (id, order) => ({
    status: 200,
    body: JSON.stringify({
      id: `msg_${id}`, type: "message", role: "assistant", model: "claude-test",
      content: [{ type: "tool_use", id, name: "get_order", input: { order_number: order } }],
      stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
    }),
  });
  sent.length = 0;
  ran.length = 0;
  queue.push(toolUse("toolu_1", "1042"), reply('{"type":"answer","message":"#1042 is paid: 1499."}'));
  const looked = await callModel({
    system: ["the contract", "this project"],
    turns: [{ role: "user", content: "is #1042 paid?" }],
    lookups: lookups(4),
  });
  check("it looks the order up, then replies from it", looked === '{"type":"answer","message":"#1042 is paid: 1499."}' && ran.length === 1 && ran[0].order_number === "1042");
  check("the tool is offered with its schema", sent[0]?.body?.tools?.[0]?.name === "get_order" && sent[0].body.tools[0].input_schema?.required?.[0] === "order_number");
  const second = JSON.stringify(sent[1]?.body?.messages ?? []);
  check("and what it found goes back to the model", sent.length === 2 && second.includes('"tool_result"') && second.includes("PAID"));
  check(
    "every step still caches the contract and caps the reply",
    sent.every((r) => r.body?.system?.[0]?.cache_control?.type === "ephemeral" && r.body.max_tokens === 6000)
  );

  sent.length = 0;
  ran.length = 0;
  queue.push(toolUse("toolu_1", "1042"), toolUse("toolu_2", "1043"), reply('{"type":"answer","message":"both paid"}'));
  const cut = await callModel({ system: "s", turns: [{ role: "user", content: "are #1042 and #1043 paid?" }], lookups: lookups(2) });
  const fold = sent[2]?.body;
  check("when the cap comes mid-lookup, it is still answered", cut === '{"type":"answer","message":"both paid"}' && ran.length === 2);
  check("by one more call, without tools", sent.length === 3 && !fold?.tools && !JSON.stringify(fold?.messages ?? []).includes("tool_use"));
  check(
    "carrying what the lookups found, in words",
    JSON.stringify(fold?.messages ?? []).includes("What your lookups returned") && JSON.stringify(fold?.messages ?? []).includes("1043")
  );

  sent.length = 0;
  ran.length = 0;
  queue.push(
    {
      status: 200,
      body: JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "get_order", args: { order_number: "1042" } } }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      }),
    },
    gemini('{"type":"answer","message":"paid"}')
  );
  const g1 = await callModel({ system: "s", turns: [{ role: "user", content: "is #1042 paid?" }], model: "gemini-test", lookups: lookups(4) });
  check("Gemini looks it up too", g1 === '{"type":"answer","message":"paid"}' && ran.length === 1);
  check(
    "and is not asked for JSON mode beside its tools, which it refuses",
    sent[0]?.body?.tools?.[0]?.functionDeclarations?.[0]?.name === "get_order" && !sent[0].body.generationConfig?.responseMimeType
  );

  console.log("\nwhat Luke is saying, read while it is still arriving");
  check("nothing until the message has begun", draftMessage('{"type":"answer",') === null && draftMessage("") === null);
  check("the words so far, mid-string", draftMessage('{"type":"answer","message":"Order #1001 is not') === "Order #1001 is not");
  check("the whole message once it closes, and not a word past it", draftMessage('{"type":"answer","message":"Paid.","kind":"store"}') === "Paid.");
  check("escapes read as what they stand for", draftMessage('{"message":"a \\"quote\\"\\nline 2') === 'a "quote"\nline 2');
  check("and a half-arrived escape waits", draftMessage('{"message":"cost \\u20') === "cost " && draftMessage('{"message":"₹ is \\u20b9') === "₹ is ₹");
  check("prose before the JSON is looked past", draftMessage('Here you go:\n```json\n{"type":"answer","message":"Hi') === "Hi");

  console.log("\nthe reply, streamed");
  const sse = (events) => ({ status: 200, type: "text/event-stream", body: events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("") });
  const anthropicStream = (chunks, end = "end_turn") =>
    sse([
      ["message_start", { type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ...chunks.map((text) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }]),
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: end, stop_sequence: null }, usage: { output_tokens: 20 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
  const heardText = [];
  sent.length = 0;
  queue.push(anthropicStream(['{"type":"answer",', '"message":"Order #1001 ', 'is not paid."}']));
  const streamed = await callModel({ system: ["the contract", "this project"], turns: [{ role: "user", content: "is #1001 paid?" }], onText: (t) => heardText.push(t) });
  check("the reply comes back whole, as ever", streamed === '{"type":"answer","message":"Order #1001 is not paid."}');
  check("heard as it grew, starting from nothing", heardText[0] === "" && heardText.at(-1) === streamed && heardText.length >= 4);
  const drafts = heardText.map(draftMessage).filter((d) => d !== null);
  check("and the draft read from it grows the same way", JSON.stringify(drafts) === JSON.stringify(["Order #1001 ", "Order #1001 is not paid."]));
  check("asked as a stream, still caching the contract and capping the reply", sent[0]?.body?.stream === true && sent[0].body.system?.[0]?.cache_control?.type === "ephemeral" && sent[0].body.max_tokens === 6000);
  const refusedStream = await (async () => {
    queue.push({ status: 529, body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
    try {
      await callModel({ system: "s", turns: [{ role: "user", content: "hi" }], onText: () => {} });
      return null;
    } catch (e) {
      return e;
    }
  })();
  check("a stream refused at the door is the same sentence", refusedStream instanceof ModelError && refusedStream.kind === "busy");
  const midway = await (async () => {
    queue.push(sse([
      ["message_start", { type: "message_start", message: { id: "msg_e", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
      ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
    ]));
    try {
      await callModel({ system: "s", turns: [{ role: "user", content: "hi" }], onText: () => {} });
      return null;
    } catch (e) {
      return e;
    }
  })();
  check("and one that breaks off midway, overloaded, is busy too", midway instanceof ModelError && midway.kind === "busy");
  const halted = await (async () => {
    const stop = new Error("aborted");
    stop.name = "AbortError";
    queue.push(stop);
    try {
      await callModel({ system: "s", turns: [{ role: "user", content: "hi" }], onText: () => {} });
      return null;
    } catch (e) {
      return e;
    }
  })();
  check("a stop is still a stop when streaming", halted?.name === "AbortError" && !(halted instanceof ModelError));
  sent.length = 0;
  const geminiHeard = [];
  queue.push({
    status: 200,
    type: "text/event-stream",
    body: [
      { candidates: [{ content: { role: "model", parts: [{ text: '{"type":"answer","message":"Pa' }] }, index: 0 }] },
      { candidates: [{ content: { role: "model", parts: [{ text: 'id."}' }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 } },
    ].map((d) => `data: ${JSON.stringify(d)}\n\n`).join(""),
  });
  const gs = await callModel({ system: "s", turns: [{ role: "user", content: "paid?" }], model: "gemini-test", onText: (t) => geminiHeard.push(t) });
  check("Gemini streams too, asked for JSON", gs === '{"type":"answer","message":"Paid."}' && /streamGenerateContent/.test(sent[0]?.url ?? "") && sent[0]?.body?.generationConfig?.responseMimeType === "application/json");
  check("and is heard as it grows", draftMessage(geminiHeard.at(-2) ?? "") === "Pa" && draftMessage(geminiHeard.at(-1)) === "Paid.");

  console.log("\nthe importer's own errors still read as they did");
  check("a Shopify 429 in plain words is transient", isTransient(new Error("Shopify said 429 Too Many Requests")));
  check("and a plain refusal is not", !isTransient(new Error("Shopify said 401 Unauthorized")));
} finally {
  globalThis.fetch = realFetch;
  console.error = realError;
}

console.log(fails.length === 0 ? "\nwhen the model is not there, the merchant reads one sentence" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
