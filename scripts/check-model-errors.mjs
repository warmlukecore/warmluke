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

import { callAnthropicChat, ModelError } from "../src/lib/ai.ts";
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
  return new Response(next.body, { status: next.status, headers: { "content-type": "application/json" } });
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
  check("to the model's generateContent, on the Gemini key", /\/v1beta\/models\/gemini-test:generateContent$/.test(g?.url ?? "") && g.headers.get("x-goog-api-key") === "gemini-key");
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

  console.log("\nthe importer's own errors still read as they did");
  check("a Shopify 429 in plain words is transient", isTransient(new Error("Shopify said 429 Too Many Requests")));
  check("and a plain refusal is not", !isTransient(new Error("Shopify said 401 Unauthorized")));
} finally {
  globalThis.fetch = realFetch;
  console.error = realError;
}

console.log(fails.length === 0 ? "\nwhen the model is not there, the merchant reads one sentence" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
