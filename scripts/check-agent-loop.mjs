// Luke as an agent (lib/agent.ts, LUKE_AGENT=on), with the model stood in.
//
// No network and no key: fetch answers as Anthropic does, a scripted turn at
// a time, and every request is kept to read back. Holds that the loop's
// guide is the design contract's own words, split by its own headings, and
// the contract Luke works under is a fraction of the old one without its
// fence; that a change the design check refuses comes back to Luke as a tool
// result in the check's words and is never added; that a good one is; that
// the draft is tried on rows; that the turn ends in the reply the engine
// always read (a design, questions, a plan said in words that "Build it"
// agrees to, or an answer); that a repair starts from the design it had;
// and that a loop out of steps hands back what it built.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-agent-loop.mjs
import { agentContract, agentReply, draftOf, guideTopics, ownerJargon, runAgent } from "../src/lib/agent.ts";
import { buildSystemPrompt, foldOf, parseReply } from "../src/lib/ai.ts";
import { withEarlier } from "../src/lib/turn-run.ts";
import { proposalOf } from "../src/lib/plan.ts";
import { jsonSchema, tool } from "ai";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// The provider, stood in for: scripted answers in order, every request kept.
const script = [];
const sent = [];
globalThis.fetch = async (_input, init) => {
  sent.push(init?.body ? JSON.parse(String(init.body)) : null);
  const next = script.shift() ?? { text: "" };
  const content = next.tool
    ? [{ type: "tool_use", id: `toolu_${sent.length}`, name: next.tool, input: next.input ?? {} }]
    : [{ type: "text", text: next.text }];
  return new Response(
    JSON.stringify({
      id: `msg_${sent.length}`,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content,
      stop_reason: next.tool ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ANTHROPIC_MODEL = "claude-test";
delete process.env.ANTHROPIC_API_URL;
delete process.env.MODEL_TAPE;

console.log("\nthe guide is the contract's own words");
{
  const topics = guideTopics();
  const want = {
    plan: "Each plan must have exactly this shape",
    store_sections: 'NEW_MODULE with "source_table"',
    features: "FEATURE_UPDATE",
    rules: "AUTOMATION_ADD",
    code_rules: "CODE RULE",
    screens: "CUSTOM VIEW",
    views: "CHOOSING THE VIEW",
    sections: "NESTING",
    questions: "WHICH SHAPE TO USE",
    writing: "WRITING FOR THE OWNER",
    on_screen: "ON THEIR SCREEN",
    hard_rules: "HARD RULES",
    simpler: "BUILD THE SIMPLE WAY FIRST",
  };
  for (const [name, phrase] of Object.entries(want)) {
    check(`"${name}" holds ${phrase}`, topics[name]?.text.includes(phrase) && topics[name].text.length > 200);
  }
  const [old] = buildSystemPrompt([], "x");
  const contract = agentContract();
  check(
    `Luke works under ${Math.round(contract.length / 1000)}k characters, not ${Math.round(old.length / 1000)}k`,
    contract.length < old.length / 2
  );
  check("with no fence around what exists", !contract.includes("this list is exhaustive"));
  check(
    "but the building blocks, how he works, and the guide",
    /THE BUILDING BLOCKS/.test(contract) && /HOW YOU WORK/.test(contract) && /GUIDE —/.test(contract)
  );
  check("and the old road is still the old road", old.includes("this list is exhaustive"));
}

// A design check stood in for: a change of type BAD is refused, anything else stands.
const validate = (plans) => {
  const bad = plans.findIndex((p) => p.changeType === "BAD");
  return bad >= 0
    ? { ok: false, errors: [`Plan ${bad + 1}: "BAD" is not a kind of change. Read guide plan.`] }
    : { ok: true, parts: plans.map((p) => `Change ${p.changeType}`), plans };
};
const tried = [];
const test = async (plans) => {
  tried.push(plans.length);
  return { rules: [{ rule: "Flag late", section: "Orders", matched: 34, of: 2058 }] };
};
const told = [];
const reads = {
  read_section: tool({
    description: "Read a section.",
    inputSchema: jsonSchema({ type: "object", properties: { section: { type: "string" } } }),
    execute: async () => ({ section: "Stock", total: 2058, rows: [] }),
  }),
};
// The turns below build on a yes the owner already gave, unless a case says otherwise.
const run = (
  start = [],
  turns = [{ role: "user", content: "Flag orders not shipped in 2 days" }],
  mayBuildNew = true
) =>
  runAgent({ context: "PROJECT: test", turns, reads, start, validate, test, tell: (e) => told.push(e), mayBuildNew });
const asText = (body) => JSON.stringify(body?.messages ?? []);
const good = { changeType: "AUTOMATION_ADD", targetModuleId: "m1", automation: { name: "Flag late" } };

console.log("\na turn, built a change at a time");
{
  script.push(
    { tool: "read_section", input: { section: "Stock" } },
    { tool: "guide", input: { topics: ["rules"] } },
    { tool: "draft_change", input: { change: { changeType: "BAD" } } },
    { tool: "draft_change", input: { change: good } },
    { tool: "test_draft", input: {} },
    {
      tool: "finish",
      input: {
        title: "Late orders",
        message: "This would flag 34 of your 2,058 orders today.",
        next: [{ label: "Tell me too", prompt: "Also alert me" }],
      },
    }
  );
  const out = await run();
  const reply = JSON.parse(out.raw);
  check(
    "ends in a design for their yes",
    reply.type === "plans" && reply.plans.length === 1 && reply.plans[0].changeType === "AUTOMATION_ADD"
  );
  check(
    "with Luke's own words and next steps",
    /34 of your 2,058/.test(reply.message) && reply.next[0].label === "Tell me too"
  );
  check(
    "under the agent's contract, cached, with the building tools beside the reads",
    (() => {
      const first = sent[0];
      const names = (first.tools ?? []).map((t) => t.name);
      return (
        /HOW YOU WORK/.test(first.system?.[0]?.text ?? "") &&
        ["read_section", "guide", "draft_change", "test_draft", "finish", "ask_owner"].every((n) => names.includes(n))
      );
    })()
  );
  check("the guide answered in the contract's words", asText(sent[2]).includes("AUTOMATION_ADD"));
  check(
    "a refused change came back to Luke in the check's words",
    asText(sent[3]).includes("is not a kind of change") && asText(sent[3]).includes("Nothing changed in the design")
  );
  check("and was never added", out.refused.length === 1 && reply.plans.every((p) => p.changeType !== "BAD"));
  check(
    "the good one was, and said as checked",
    told.some((e) => e.step === "checked" && e.problems === 0 && e.parts?.[0] === "Change AUTOMATION_ADD")
  );
  check("the draft was tried on rows, and Luke read what it found", tried[0] === 1 && asText(sent[5]).includes("2058"));
  check("six steps, no seventh call", sent.length === 6);
}

console.log("\nthe other ways a turn ends");
{
  sent.length = 0;
  script.push({
    tool: "ask_owner",
    input: {
      message: "Two things first.",
      questions: [{ id: "who", question: "Who packs?", suggestions: ["Me", "Staff"] }],
    },
  });
  const asked = JSON.parse((await run()).raw);
  check("questions are a clarify", asked.type === "clarify" && asked.questions[0].id === "who");

  script.push({
    tool: "finish",
    input: { title: "Parent stock", message: "Here's how it would work… Want me to build it?", proposal: true },
  });
  const said = (await run()).raw;
  const plan = proposalOf([{ role: "assistant", content: said }]);
  check(
    "a plan said in words is one their yes agrees to",
    JSON.parse(said).kind === "proposal" && plan?.goal === "Parent stock" && /Want me to build it/.test(plan?.say ?? "")
  );
  // Every proposal the loop made failed the app's own reply check as an
  // unknown kind, so the turn failed after three repairs (smoke eval, 12 Oct).
  const parsedPlan = parseReply(said, [], null, null);
  check(
    "and the app's own reply check takes it, with what was understood",
    parsedPlan.ok && parsedPlan.reply.kind === "proposal" && parsedPlan.reply.understood?.goal === "Parent stock"
  );

  script.push({ text: "Sab theek hai, 12 orders pending hain." });
  const answer = JSON.parse((await run()).raw);
  check("plain words are an answer", answer.type === "answer" && /12 orders/.test(answer.message));

  script.push({
    tool: "finish",
    input: { message: "Showing only COD.", kind: "conversation", show: { filters: { gateway: "COD" } } },
  });
  const shown = JSON.parse((await run()).raw);
  check("and what it does on their screen rides with it", shown.show?.filters?.gateway === "COD");
}

console.log("\na repair, and a loop out of steps");
{
  sent.length = 0;
  script.push({ tool: "finish", input: { message: "Fixed the rule's name." } });
  const mended = JSON.parse((await run([good])).raw);
  check(
    "a repair starts from the design it had",
    mended.type === "plans" && mended.plans[0].automation.name === "Flag late"
  );
  check(
    "draftOf reads a blueprint's plans back",
    draftOf(JSON.stringify({ type: "blueprint", blueprint: { plans: [good] } })).length === 1
  );

  process.env.LUKE_AGENT_STEPS = "2";
  script.push({ tool: "draft_change", input: { change: good } }, { tool: "guide", input: { topics: ["views"] } });
  const cut = JSON.parse((await run()).raw);
  check(
    "out of steps with a design: the design so far, said as that",
    cut.type === "plans" && /design so far/.test(cut.message)
  );
  script.push({ tool: "guide", input: { topics: ["views"] } }, { tool: "guide", input: { topics: ["plan"] } });
  check("out of steps with nothing: nothing to show", (await run()).raw === null);
  delete process.env.LUKE_AGENT_STEPS;
  check(
    "agentReply with nothing at all is nothing",
    agentReply({ draft: [], problems: [], refused: [], finished: null, asked: null }, "") === null
  );
}

console.log("\nnew work waits for their yes (smoke eval, 12 Oct)");
{
  sent.length = 0;
  const field = { changeType: "FIELD_ADD", targetModuleId: "m1", newSchema: { columns: [] } };
  script.push(
    { tool: "draft_change", input: { change: good } },
    { tool: "draft_change", input: { change: field } },
    { tool: "finish", input: { message: "Here's how it would work. Want me to build it?", proposal: true } }
  );
  const out = await run([], undefined, false);
  check(
    "a new rule before their yes is refused, said why, and not added",
    asText(sent[1]).includes("have not agreed to it yet") && asText(sent[1]).includes("proposal: true")
  );
  check("a small exact change still goes in", JSON.parse(out.raw).plans?.[0]?.changeType === "FIELD_ADD");
}

console.log("\nthe owner reads their words, not ours (smoke eval, 12 Oct)");
{
  check(
    "ownerJargon finds our words and a field's key as code",
    JSON.stringify(ownerJargon("Adds a boolean and a set_fields rule on `call_state`.")) ===
      JSON.stringify(["boolean", "set_fields", "`call_state`"])
  );
  check("and leaves plain words alone", ownerJargon("A tick for called, set on each COD order.").length === 0);

  sent.length = 0;
  script.push(
    { tool: "finish", input: { message: "I added a boolean field and a set_fields rule." } },
    { tool: "finish", input: { message: "I added a Called tick, and a rule that ticks it." } }
  );
  const plain = JSON.parse((await run()).raw);
  check(
    "a finish in our words goes back to Luke with what to say instead",
    asText(sent[1]).includes("the owner would read boolean, set_fields")
  );
  check("and the turn ends on the one in theirs", sent.length === 2 && /Called tick/.test(plain.message));

  sent.length = 0;
  script.push(
    { tool: "finish", input: { message: "A boolean one." } },
    { tool: "finish", input: { message: "A boolean two." } },
    { tool: "finish", input: { message: "A boolean three." } }
  );
  const last = JSON.parse((await run()).raw);
  check("sent back twice at most, so a turn always ends", sent.length === 3 && /three/.test(last.message));
}

console.log("\nwhat is cut is said (no silent limits, 12 Oct)");
{
  const long = withEarlier(
    [
      { role: "assistant", content: "Older reply" },
      { role: "user", content: "Now this" },
    ],
    13
  );
  check(
    "a thread longer than read says how much is not shown",
    long[0].role === "user" && /first 13 messages are not here/.test(long[0].content) && long.length === 3
  );
  const merged = withEarlier([{ role: "user", content: "Hi" }], 2);
  check(
    "in the first words of theirs, when the thread starts with them",
    merged.length === 1 && merged[0].content.endsWith("Hi") && /first 2 messages/.test(merged[0].content)
  );
  check(
    "and a thread read whole is told nothing",
    withEarlier([{ role: "user", content: "Hi" }], 0)[0].content === "Hi"
  );
  const big = foldOf(Array.from({ length: 4000 }, (_, i) => ({ order: i, note: "x".repeat(20) })));
  check(
    "lookups cut for the last call say where and how much",
    /\[cut here: 60,000 of [\d,]+ characters shown/.test(big)
  );
  check("and lookups that fit are sent as they were", foldOf([{ a: 1 }]) === '[{"a":1}]');
  const store = {
    shop_domain: "s.myshopify.com",
    timezone: "Asia/Kolkata",
    currency: "INR",
    importing: false,
    counts: {},
    snapshot: {
      last_synced_at: null,
      recent: [],
      low: [{ product: "Case", variant: null, location: "Main", available: 0 }],
      lowCount: { low: 718, out: 311 },
      top_customers: [],
      best_sellers: [],
    },
  };
  const [, context] = buildSystemPrompt([], "x", "en-IN", "INR", store);
  check(
    "the stock snapshot says how many in all, and how many are out",
    /Running low \(under 10\): 718 in all, 311 already out of stock; the 1 lowest/.test(context)
  );
}

console.log(
  fails.length === 0
    ? "\nLuke builds a change at a time, and finishes in the reply the app reads"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
