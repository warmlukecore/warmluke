// When the model is not there, the merchant reads one sentence.
//
// A provider's refusal used to reach the chat as it came — a status
// code and three hundred characters of somebody else's JSON, "credit
// balance" and all. Now every way a model call can fail becomes one
// of a few kinds, each with a sentence that says what happened, that
// nothing changed, and whether trying again is any use. The raw
// answer goes to the server log instead, under one prefix.
//
// No network: fetch is stood in for, so each status can be dealt.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-model-errors.mjs

import { callAnthropicChat, ModelError } from "../src/lib/ai.ts";
import { isTransient } from "../src/lib/retry.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// The provider, stood in for: a queue of answers, dealt in order.
const queue = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
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

  console.log("\nthe importer's own errors still read as they did");
  check("a Shopify 429 in plain words is transient", isTransient(new Error("Shopify said 429 Too Many Requests")));
  check("and a plain refusal is not", !isTransient(new Error("Shopify said 401 Unauthorized")));
} finally {
  globalThis.fetch = realFetch;
  console.error = realError;
}

console.log(fails.length === 0 ? "\nwhen the model is not there, the merchant reads one sentence" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
