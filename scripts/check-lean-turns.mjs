// What a turn sends, kept lean (12 Oct).
//
// Carefone's thread on 11 Oct paid 57,360 uncached input tokens for a
// one-lookup answer: every older design was replayed whole, and nothing
// past the contract was cached, so the lookup's second call sent the whole
// thread again at full price. Holds: an older design replayed as what was
// said and changed, the last reply whole; the thread cached at its last
// turn on Luke's calls (and not on a one-off), with the tape key blind to
// where the cache ends; and the first meeting's way out, held by code: the
// answer that asks is marked, and the yes after it opens their store.
// Beside them, a column's "about", bounded.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-lean-turns.mjs
import { callModel, clipAbout, ABOUT_MAX, validatePlan } from "../src/lib/ai.ts";
import { pastReply, meetTurn, NOT_ANSWERED } from "../src/lib/engine.ts";
import { historyOf, meetStateOf } from "../src/lib/turn-run.ts";
import { fingerprint } from "../src/lib/model-tape.ts";
import { MEET_BUILT, MEET_OPENER } from "../src/lib/meet.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const design = (type) =>
  "```json\n" +
  JSON.stringify({
    type,
    title: "Parent SKU stock",
    message: "This gives every design a real stock number.",
    ...(type === "blueprint"
      ? {
          blueprint: {
            summary: "Each design is tagged once with its blank.",
            plans: [
              {
                changeType: "FIELD_ADD",
                targetModuleId: "6b52353d-f54f-4123-a81b-c0f682ca9e21",
                newSchema: { columns: [{ field: "parent_sku", label: "Parent SKU", type: "text" }] },
                explanation: "Adds Parent SKU to Stock.",
              },
            ],
          },
        }
      : {
          plans: [
            {
              changeType: "AUTOMATION_ADD",
              automation: { name: "Push stock", trigger: { type: "record_created" }, actions: [] },
              explanation: "Pushes the blank's count to its designs.",
            },
          ],
        }),
  }) +
  "\n```";

console.log("an older design is replayed as what was said and changed");
{
  const short = JSON.parse(pastReply(design("blueprint")));
  check(
    "its words and summary stay",
    short.message.startsWith("This gives") && short.summary.startsWith("Each design")
  );
  check("each change as a line", short.changes[0] === "FIELD_ADD: Adds Parent SKU to Stock.");
  check("and no schema, field or rule body", !JSON.stringify(short).includes("newSchema"));
  check("plans too", JSON.parse(pastReply(design("plans"))).changes[0].startsWith("AUTOMATION_ADD"));
  const answer = '{"type":"answer","kind":"store","message":"72 left."}';
  check("an answer is replayed as it was", pastReply(answer) === answer);
  check(
    "and words that only look like JSON too",
    pastReply('"type": "plans" and then {') === '"type": "plans" and then {'
  );
  check("and an apply's line", pastReply("Add fields to Stock · New section") === "Add fields to Stock · New section");
}

console.log("\nthe thread as the model is told it");
{
  const rows = [
    {
      role: "user",
      content: "CONTEXT — …USER REQUEST:\nparent and child SKUs",
      ptype: null,
      said: "parent and child SKUs",
    },
    { role: "assistant", content: design("blueprint"), ptype: "blueprint", said: null },
    { role: "assistant", content: "Add fields to Stock", ptype: "build", said: null },
    { role: "user", content: "CONTEXT — …USER REQUEST:\nnow push it", ptype: null, said: "now push it" },
    { role: "assistant", content: design("plans"), ptype: "plans", said: null },
  ];
  const h = historyOf(rows);
  check("the owner's own words, never the context sent with them", h[0].content === "parent and child SKUs");
  check("an older design, short", !h[1].content.includes("newSchema") && h[1].content.includes("changes"));
  check("the last reply whole: they may be answering it", h[4].content === rows[4].content);
  const stopped = historyOf([
    ...rows,
    { role: "user", content: "and RTO?", ptype: null, said: "and RTO?" },
    { role: "assistant", content: "", ptype: "unanswered", said: null },
  ]);
  check("a question never answered is said as one", stopped.at(-1).content === NOT_ANSWERED);
}

console.log("\nthe first meeting's way out");
{
  const row = (role, ptype, kind = null, offered = null) => ({ role, ptype, kind, offered });
  const talked = meetStateOf([row("user", null, "meet"), row("assistant", "answer", "conversation")]);
  check("a hello is no help yet", !talked.helped && !talked.offered);
  const built = meetStateOf([row("assistant", "blueprint"), row("assistant", "build")]);
  check("a build they agreed to is help", built.helped && !built.offered);
  check("so is an answer from their store's numbers", meetStateOf([row("assistant", "answer", "store")]).helped);
  const asked = meetStateOf([row("assistant", "build"), row("assistant", "answer", "conversation", "true")]);
  check("an answer that asked is remembered, last of all", asked.offered && asked.lastOffered);
  const moved = meetStateOf([
    row("assistant", "answer", "conversation", "true"),
    row("assistant", "answer", "conversation"),
  ]);
  check("and once more said, it is no longer the last", moved.offered && !moved.lastOffered);
  check("the line after a build asks", meetTurn(true, talked, MEET_BUILT).offerDue);
  // Discovery (15 Oct): helping is no reason to end it; eight answers is a choice offered once.
  check("helped, after one answer: no push to leave", !meetTurn(true, built, "and what about RTO?").offerDue);
  const eight = meetStateOf([
    row("user", null, "meet"),
    ...Array.from({ length: 8 }, () => [row("user", null, "user"), row("assistant", "answer", "conversation")]).flat(),
  ]);
  check("their own answers are counted, the opener aside", eight.exchanges === 8);
  check("after about eight of them, the choice is offered", meetTurn(true, eight, "and the courier side?").offerDue);
  check("asked once: not again", !meetTurn(true, { ...eight, offered: true }, "tell me more").offerDue);
  check("the opener never asks", !meetTurn(true, eight, MEET_OPENER).offerDue);
  check(
    "asking to go opens their store at once, in any words",
    ["take me to the dashboard", "skip", "dashboard dikhao", "go to my store", "let me in"].every(
      (m) => meetTurn(true, talked, m).opens
    )
  );
  check(
    "but a wish to build one is not asking to go",
    ["make me a dashboard for returns", "I want a store report", "what's on my dashboard?"].every(
      (m) => !meetTurn(true, talked, m).opens
    )
  );
  check("their yes to it opens the store", meetTurn(true, asked, "haan").opens);
  check("in any of their words", meetTurn(true, asked, "yes please").opens);
  check("but not a yes to something else", !meetTurn(true, built, "haan").opens);
  check("nor a new question", !meetTurn(true, asked, "what about returns?").opens);
  check(
    "and nothing outside the first meeting",
    !meetTurn(false, asked, "haan").opens && !meetTurn(false, built, MEET_BUILT).offerDue
  );
}

console.log("\na column's meaning beside its name");
{
  check("kept as one line", clipAbout("  What is left\nof the blank. ") === "What is left of the blank.");
  const long = clipAbout("word ".repeat(100));
  check(`cut at a word to ${ABOUT_MAX}`, long.length <= ABOUT_MAX && long.endsWith("…") && !long.includes("wor…"));
  check("nothing is none", clipAbout("   ") === undefined);
  const plan = (about) => ({
    changeType: "NEW_MODULE",
    targetModuleId: null,
    newModule: { name: "blanks", nav_label: "Blanks", icon: "box", parent_id: null, source_table: null },
    newSchema: {
      columns: [
        { field: "sku", label: "SKU", type: "text" },
        { field: "remaining", label: "Blank remaining", type: "number", about },
      ],
    },
    features: null,
    newRecords: [{ sku: "POX-1", remaining: 4 }],
    explanation: "A list of blank cases and what is left of each.",
  });
  const p = plan("x".repeat(400));
  const v = validatePlan(p, [], null, null);
  check("a long one is taken, cut to fit, not sent back", !v.errors?.some((e) => /about/.test(e)));
  check("and kept cut", p.newSchema.columns[1].about.length <= ABOUT_MAX);
  const bad = validatePlan(plan(42), [], null, null);
  check(
    "one that is not words is sent back",
    bad.errors?.some((e) => /"about"/.test(e))
  );
}

console.log("\nthe thread cached at its last turn, on Luke's calls only");
{
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "claude-test";
  delete process.env.ANTHROPIC_API_URL;
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: '{"type":"answer","kind":"conversation","message":"ok"}' }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const turns = [
    { role: "user", content: "track bikes" },
    { role: "assistant", content: "which stages?" },
    { role: "user", content: "intake, done" },
  ];
  try {
    await callModel({ system: ["the contract", "this project"], turns, cacheTurns: true });
    await callModel({ system: ["the contract", "this project"], turns });
  } finally {
    globalThis.fetch = realFetch;
  }
  const marks = (body) =>
    body.messages.flatMap((m, i) => (m.content ?? []).filter((c) => c.cache_control).map(() => i));
  check("the contract is cached, as before", !!sent[0].system[0].cache_control && !sent[0].system[1].cache_control);
  check("the thread is cached at its last turn", JSON.stringify(marks(sent[0])) === "[2]");
  check("a one-off call caches no turn", marks(sent[1]).length === 0);
  const [a, b] = sent.map(
    (body) => fingerprint("anthropic", "https://api.anthropic.com/v1/messages", JSON.stringify(body)).key
  );
  check("and a recording is found whichever it was", a === b);
  const body = { max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  const url = "https://api.anthropic.com/v1/messages";
  const withTools = fingerprint("anthropic", url, JSON.stringify({ ...body, tool_choice: { type: "auto" } }));
  const without = fingerprint("anthropic", url, JSON.stringify(body));
  check(
    "a call that gained tools still finds what was recorded before it had any",
    withTools.plain === without.parts.conversation
  );
}

console.log(fails.length === 0 ? "\na turn sends what it needs, once" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
