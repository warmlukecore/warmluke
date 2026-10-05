// The plan step: what Luke understood, read back and handed on.
//
// The model's reply is words in a JSON shape; this holds the reader to
// it (fenced, half-empty, or not JSON at all) and the block the design
// call is given to what was understood. Pure: no model, no database.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-plan.mjs

import { intentBlock, isGoAhead, parseIntent, plainReply, plainSay } from "../src/lib/plan.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

console.log("a reply read as an intent");
const full = parseIntent(
  JSON.stringify({
    goal: "Pack orders by scanning, and know which are still left",
    rows: "the store's orders — the work happens to each order as it is packed",
    work: ["scan the order number", "the order is ticked as packed, with the time"],
    facts: ["a Packed tick", "when it was packed"],
    rules: [],
    screens: ["a scan bar over the orders list", "a filter for orders still to pack"],
    unsure: ["should a second scan of the same order be refused?"],
  })
);
check("the goal, the rows and every list come through", !!full && full.work.length === 2 && full.unsure.length === 1);
check(
  "in a code fence too",
  parseIntent('```json\n{"goal":"Track returns","rows":"new rows"}\n```')?.goal === "Track returns"
);
const thin = parseIntent('{"goal":"Track returns"}');
check("a goal alone is still a plan, its lists empty", !!thin && thin.rows === "" && thin.work.length === 0);
check("no goal, no plan", parseIntent('{"rows":"orders","work":["scan"]}') === null);
check("not JSON, no plan", parseIntent("I think they want a packing list.") === null);
check("a list of the wrong kind is read as empty", parseIntent('{"goal":"g","work":"scan it"}')?.work.length === 0);
check(
  "lists are cut, not trusted",
  parseIntent(JSON.stringify({ goal: "g", unsure: Array.from({ length: 9 }, (_, i) => `q${i}`) }))?.unsure.length === 4
);

console.log("\nthe block the design call reads");
const block = intentBlock(full);
check("opens as what Luke understood, after a blank line", block.startsWith("\n\nWHAT LUKE UNDERSTOOD"));
check("names the goal and the rows", /Goal: Pack orders/.test(block) && /Rows: the store's orders/.test(block));
check("lists the work, one line each", /Work:\n- scan the order number\n- the order is ticked/.test(block));
check("skips an empty list", !/Rules:/.test(block));
check("carries what is unsure, for a question", /Unsure:\n- should a second scan/.test(block));
check("a thin plan is a short block", intentBlock(thin).split("\n").length === 4);

// The plan as the owner reads it: no column's key left in it (4 Oct eval).
const labels = new Map([
  ["orders_count", "Orders"],
  ["total_spent", "Spent"],
]);
check(
  "a column's key in the plan becomes its label",
  plainSay("jiska orders_count 2 ya zyada, total_spent ke hisaab se", labels) ===
    "jiska Orders 2 ya zyada, Spent ke hisaab se"
);
check("any other key becomes plain words", plainSay("ek is_rto tick", labels) === "ek is rto tick");
check(
  "words and numbers are left as they are",
  plainSay("Ek behtar idea: 3 baar call", labels) === "Ek behtar idea: 3 baar call"
);
check(
  "an email, a domain and a path are left whole",
  plainSay("mail john_doe@gmail.com about my_shop.myshopify.com and /api/luke_skills", labels) ===
    "mail john_doe@gmail.com about my_shop.myshopify.com and /api/luke_skills"
);
check(
  "a key ending a sentence still becomes words",
  plainSay("A Stock section over your inventory_levels, checked daily.", labels) ===
    "A Stock section over your inventory levels, checked daily."
);

// The rest of a card as the owner reads it ("an 'internal_status' field", 4 Oct).
{
  const card = {
    type: "blueprint",
    message: "Returns par nazar.",
    blueprint: {
      summary: "Har return ke saath ek 'internal_status' field.",
      plans: [{ newSchema: { columns: [{ field: "internal_status", label: "Return status", type: "dropdown" }] } }],
      workflow: [{ step: "staff badle internal_status", who: "packing team" }],
      next: [{ label: "total_spent bhi dikhao", prompt: "show total_spent too" }],
    },
  };
  plainReply(card, labels);
  check("a card's summary names its own new column by label", card.blueprint.summary.includes("'Return status'"));
  check(
    "and so do its steps and next steps",
    /Return status/.test(card.blueprint.workflow[0].step) && card.blueprint.next[0].label === "Spent bhi dikhao"
  );
  check("what a next step sends keeps its key", card.blueprint.next[0].prompt === "show total_spent too");
  const ask = {
    type: "clarify",
    message: "x",
    questions: [{ id: "q", question: "orders_count kitna?", why: "is_rto ke liye", suggestions: ["total_spent"] }],
  };
  plainReply(ask, labels);
  check(
    "a question, its why and its suggestions too",
    ask.questions[0].question === "Orders kitna?" &&
      ask.questions[0].why === "is rto ke liye" &&
      ask.questions[0].suggestions[0] === "Spent"
  );
}

// A yes is a few words: a long message is not one, and is answered at once (CodeQL, 5 Oct).
{
  const long = `${"!".repeat(50_000)}x`;
  const t0 = performance.now();
  check("a long message is not a yes", !isGoAhead(long));
  check("and is answered at once", performance.now() - t0 < 50);
  check("a short yes still is", isGoAhead("haan bana do!"));
}

console.log(fails.length === 0 ? "\nthe plan step reads back what was understood" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
