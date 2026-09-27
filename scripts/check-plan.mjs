// The plan step: what Luke understood, read back and handed on.
//
// The model's reply is words in a JSON shape; this holds the reader to
// it (fenced, half-empty, or not JSON at all) and the block the design
// call is given to what was understood. Pure: no model, no database.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-plan.mjs

import { intentBlock, parseIntent } from "../src/lib/plan.ts";

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

console.log(fails.length === 0 ? "\nthe plan step reads back what was understood" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
