// Model calls are recorded once and played back, and a recording answers
// only the request it was made for.
//
// Everything here runs in a temporary tape folder with the network stood
// in for: off unless asked, never in production, the same request from
// two runs is one recording, a different question or a different prompt
// is not, a recorded retry plays back in order, a miss says what changed,
// a stop stays a stop, and a whole model call through callModel comes
// back from the tape with no key and no network at all.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-model-tape.mjs

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, keyFor, normalise, tapeFetch, tapeMode, tapedSetting } from "../src/lib/model-tape.ts";
import { callAnthropicChat } from "../src/lib/ai.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const tapes = mkdtempSync(join(tmpdir(), "tapes-"));
process.env.MODEL_TAPE_DIR = tapes;
delete process.env.VERCEL_ENV;
const saved = {
  key: process.env.ANTHROPIC_API_KEY,
  model: process.env.ANTHROPIC_MODEL,
  url: process.env.ANTHROPIC_API_URL,
};
const logged = [];
const realError = console.error;
console.error = (line) => logged.push(String(line));

// The network, stood in for: answers dealt in order, calls counted.
let calls = 0;
const deal = [];
const net = async () => {
  calls++;
  const next = deal.shift() ?? { status: 200, body: "{}" };
  return new Response(next.body, { status: next.status, headers: { "content-type": next.type ?? "application/json" } });
};
const request = (said, system = "the contract", extra = {}) =>
  JSON.stringify({
    model: "claude-x",
    max_tokens: 6000,
    system: [{ type: "text", text: system }],
    messages: [{ role: "user", content: said }],
    ...extra,
  });
const ask = (said, system) =>
  tapeFetch("anthropic", net)("https://api.anthropic.com/v1/messages", { method: "POST", body: request(said, system) });

try {
  console.log("off unless asked, and never in production");
  delete process.env.MODEL_TAPE;
  calls = 0;
  deal.push({ status: 200, body: "straight through" });
  check(
    "with no setting, a call goes straight to the network",
    (await (await ask("hi")).text()) === "straight through" && calls === 1 && readdirSync(tapes).length === 0
  );
  process.env.MODEL_TAPE = "replay";
  process.env.VERCEL_ENV = "production";
  check("in production it is off, whatever the setting says", tapeMode() === null);
  delete process.env.VERCEL_ENV;
  process.env.MODEL_TAPE = "nonsense";
  check("and a setting it does not know is off too", tapeMode() === null);

  console.log("\nwhat differs between runs is not the request");
  check(
    "ids, times, dates, Shopify ids, store addresses and call ids become placeholders",
    normalise(
      "3f2b1c4d-1111-2222-3333-444455556666 2026-09-24T12:00:01.5Z 2026-08-25 gid://shopify/Order/31003 luke-mufjhory.myshopify.com toolu_01AbC"
    ) === "‹id› ‹time› ‹date› gid://shopify/Order/‹n› ‹shop› ‹toolu›"
  );
  const a = fingerprint(
    "anthropic",
    "https://api.anthropic.com/v1/messages",
    request("is #1001 paid? store a-1.myshopify.com, row 3f2b1c4d-1111-2222-3333-444455556666")
  );
  const b = fingerprint(
    "anthropic",
    "https://api.atria-asi.ai/v1/messages",
    request("is #1001 paid? store b-2.myshopify.com, row 9a9a9a9a-1111-2222-3333-444455556666", "the contract", {
      model: "Atria-Dawn-Preview",
    })
  );
  check("the same request from two runs, on another host and model, is one recording", a.key === b.key);
  const c = fingerprint("anthropic", "https://api.anthropic.com/v1/messages", request("is #1002 paid?"));
  check(
    "a different question is not",
    c.key !== fingerprint("anthropic", "https://api.anthropic.com/v1/messages", request("is #1001 paid?")).key
  );
  const d = fingerprint(
    "anthropic",
    "https://api.anthropic.com/v1/messages",
    request("is #1001 paid?", "a changed contract")
  );
  const e = fingerprint("anthropic", "https://api.anthropic.com/v1/messages", request("is #1001 paid?"));
  check(
    "nor is the same question under a different prompt",
    d.key !== e.key && d.parts.conversation === e.parts.conversation
  );
  const g1 = fingerprint("gemini", "https://x/v1beta/models/gemini-3.6-flash:streamGenerateContent", '{"contents":[]}');
  const g2 = fingerprint("gemini", "https://x/v1beta/models/gemini-9:streamGenerateContent", '{"contents":[]}');
  check("Gemini's model, named in the path, is left out too", g1.key === g2.key);
  check(
    "and the provider is not: its answers are shaped differently",
    g1.key !== fingerprint("anthropic", "https://x/v1beta/models/gemini-9:streamGenerateContent", '{"contents":[]}').key
  );
  // A turn that went through Gemini: the SDK makes each call's id up, so two runs differ only there.
  const called = (ids, extra = []) =>
    JSON.stringify({
      system: "s",
      messages: [
        { role: "user", content: "tag #1003 VIP" },
        {
          role: "assistant",
          content: ids.map((id, i) => ({ type: "tool_use", id, name: i ? "propose" : "search", input: {} })),
        },
        {
          role: "user",
          content: [...ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "ok" })), ...extra],
        },
      ],
    });
  const run1 = fingerprint("anthropic", "https://x/v1/messages", called(["aB3dE5fG7hJ9kL1m", "Qw8eR7tY6uI5oP4a"]));
  const run2 = fingerprint("anthropic", "https://x/v1/messages", called(["Zx1cV2bN3mA4sD5f", "Gh6jK7lP8oI9uY0t"]));
  check("tool calls with made-up ids from two runs are one recording", run1.key === run2.key);
  check(
    "but a turn with another call in it is not",
    run1.key !== fingerprint("anthropic", "https://x/v1/messages", called(["a1", "b2", "c3"])).key
  );
  const gem = (id) =>
    JSON.stringify({
      contents: [
        { role: "model", parts: [{ functionCall: { id, name: "search", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { id, name: "search", response: {} } }] },
      ],
    });
  check(
    "and the same holds for Gemini's own call ids",
    fingerprint("gemini", "https://x/v1beta/models/m:generateContent", gem("r4nd0m1")).key ===
      fingerprint("gemini", "https://x/v1beta/models/m:generateContent", gem("0th3rId")).key
  );

  console.log("\nrecorded, then played back");
  process.env.MODEL_TAPE = "record";
  calls = 0;
  deal.push({ status: 429, body: '{"error":"busy"}' }, { status: 200, body: '{"ok":1}', type: "text/event-stream" });
  const r1 = await ask("tag #1003 VIP");
  const r2 = await ask("tag #1003 VIP");
  check(
    "recording makes the real call and hands back what it said",
    calls === 2 && r1.status === 429 && (await r2.text()) === '{"ok":1}'
  );
  const files = readdirSync(tapes).filter((f) => !f.startsWith("_"));
  const kept = JSON.parse(readFileSync(join(tapes, files[0]), "utf8"));
  check(
    "into one tape, both answers in order, with what was asked",
    files.length === 1 && kept.responses.map((r) => r.status).join() === "429,200" && /tag #1003 VIP/.test(kept.asked)
  );
  check(
    "and nothing secret in it: no key, no header",
    !JSON.stringify(kept).includes("x-api-key") && !JSON.stringify(kept).includes("test-key")
  );
  process.env.MODEL_TAPE = "replay";
  calls = 0;
  const p1 = await ask("tag #1003 VIP");
  const p2 = await ask("tag #1003 VIP");
  const p3 = await ask("tag #1003 VIP");
  check("replay never touches the network", calls === 0);
  check(
    "a retry plays back as it happened: busy, then the answer, then the answer again",
    p1.status === 429 && p2.status === 200 && (await p3.text()) === '{"ok":1}'
  );
  check(
    "with the answer's own type, so a stream is read as one",
    p2.headers.get("content-type") === "text/event-stream"
  );

  console.log("\na miss says what changed");
  logged.length = 0;
  const miss = await ask("tag #1003 VIP", "a changed contract");
  check("is refused, not retried: a 400, not a busy provider", miss.status === 400);
  check(
    "and says the prompt changed, and how to fix it",
    logged.some((l) => /different system prompt/.test(l) && /MODEL_TAPE=record/.test(l))
  );
  logged.length = 0;
  await ask("something never asked");
  check(
    "or that nothing like it was recorded",
    logged.some((l) => /nothing like this conversation was recorded/.test(l))
  );
  const halt = new AbortController();
  halt.abort();
  const stop = await tapeFetch("anthropic", net)("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: request("tag #1003 VIP"),
    signal: halt.signal,
  }).catch((err) => err);
  check("a stop is still a stop in replay", stop?.name === "AbortError");

  console.log("\nthe models, and the keys");
  process.env.MODEL_TAPE = "record";
  tapedSetting("ANTHROPIC_MODEL", "gemini-3.6-flash");
  process.env.MODEL_TAPE = "replay";
  check(
    "replay uses the model the tapes were recorded with",
    tapedSetting("ANTHROPIC_MODEL", "claude-sonnet-4-5") === "gemini-3.6-flash"
  );
  check(
    "and what was never recorded is left as the environment has it",
    tapedSetting("ANTHROPIC_GAP_MODEL", "claude-haiku") === "claude-haiku"
  );
  check("a missing key is a stand-in while replaying", keyFor(undefined) === "replay" && keyFor("real") === "real");
  check("but set and empty still means none", keyFor("") === "");
  delete process.env.MODEL_TAPE;
  check("and outside replay a missing key is missing", keyFor(undefined) === undefined);

  console.log("\na whole model call, from the tape, with no key");
  const reply = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "x",
    content: [{ type: "text", text: '{"type":"answer","message":"#1001 is paid."}' }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const realFetch = globalThis.fetch;
  process.env.ANTHROPIC_MODEL = "claude-test";
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_API_URL;
  process.env.MODEL_TAPE = "record";
  globalThis.fetch = async () =>
    new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  const recorded = await callAnthropicChat("s", [{ role: "user", content: "is #1001 paid?" }]);
  process.env.MODEL_TAPE = "replay";
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = async () => {
    throw new Error("the network was used");
  };
  const replayed = await callAnthropicChat("s", [{ role: "user", content: "is #1001 paid?" }]);
  globalThis.fetch = realFetch;
  check("recorded through callModel", recorded.includes("#1001 is paid."));
  check("and played back through it, with no key and no network", replayed === recorded);
} finally {
  console.error = realError;
  delete process.env.MODEL_TAPE;
  for (const [k, v] of [
    ["ANTHROPIC_API_KEY", saved.key],
    ["ANTHROPIC_MODEL", saved.model],
    ["ANTHROPIC_API_URL", saved.url],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tapes, { recursive: true, force: true });
}

console.log(fails.length === 0 ? "\na recording answers only the request it was made for" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
