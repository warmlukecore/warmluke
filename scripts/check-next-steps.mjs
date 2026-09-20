// What a design offers to do next is the model's, kept only where it
// is whole and not a trap.
//
// A build used to end in "Tell me what to change next." — the same
// words for every app. Now a blueprint may carry up to two follow-ups
// written from the owner's problem and the design itself, and the
// parser is the gate: an offer with no prompt, a third one, the same
// one twice, or one that names something the design could not do is
// dropped, and nothing is put in its place. None is a normal answer.
//
// No model is called. The gate is the thing that silently loosens.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-next-steps.mjs

import { asNextSteps, parseReply, WORKED_EXAMPLE } from "../src/lib/ai.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const blueprint = (extra) =>
  parseReply(
    JSON.stringify({
      type: "blueprint",
      message: "Here it is.",
      blueprint: {
        summary: "Stock, lowest first, with a count of what is running out.",
        plans: WORKED_EXAMPLE.plans,
        workflow: [{ step: "Check the count each morning", who: "The owner" }],
        ...extra,
      },
    }),
    [],
    null,
    null
  );

console.log("the gate on what comes next");
{
  const two = blueprint({
    next: [
      { label: "Warn me at 3", prompt: "Flag any stock line at or below 3 in red" },
      { label: "Reorder list", prompt: "Add a section for reorders with a supplier and a quantity" },
      { label: "A third", prompt: "Add a fourth thing" },
    ],
  });
  check("a blueprint keeps its follow-ups", two.ok && two.reply.blueprint.next?.length === 2);
  check("two at most, in the model's order", two.ok && two.reply.blueprint.next?.[0].label === "Warn me at 3");

  const none = blueprint({});
  check("none offered is none — not a default", none.ok && none.reply.blueprint.next === undefined);

  const blanks = blueprint({ next: [{ label: "", prompt: "x" }, { label: "Only a label" }, "a string", null] });
  check(
    "an offer without both halves is dropped, and nothing is put in its place",
    blanks.ok && blanks.reply.blueprint.next === undefined
  );

  const twice = blueprint({
    next: [
      { label: "One", prompt: "Flag stock at or below 3" },
      { label: "Same again", prompt: "flag stock at or below 3" },
    ],
  });
  check("the same prompt twice is once", twice.ok && twice.reply.blueprint.next?.length === 1);

  // The trap: offering as a next step the very thing the design said
  // it cannot do sends the owner into a refusal.
  const trap = blueprint({
    unmet: ["send the supplier a WhatsApp when stock runs out"],
    next: [
      { label: "Message supplier", prompt: "Send the supplier a WhatsApp when stock runs out" },
      { label: "Reorder list", prompt: "Add a reorders section" },
    ],
  });
  check(
    "an offer that is one of the unmet things is dropped",
    trap.ok && trap.reply.blueprint.next?.length === 1 && trap.reply.blueprint.next[0].label === "Reorder list"
  );

  const long = blueprint({ next: [{ label: "L".repeat(80), prompt: "p".repeat(500) }] });
  check("a prompt too long to be a message is dropped", long.ok && long.reply.blueprint.next === undefined);
}

console.log("\nand after the gap pass found more");
{
  // The engine re-filters against the final unmet list, which the gap
  // pass may have grown; the same function, so the same gate.
  const kept = asNextSteps(
    [
      { label: "Reorder list", prompt: "Add a reorders section" },
      { label: "Photos", prompt: "Let me attach a photo to each stock line" },
    ],
    ["attach a photo to each stock line"]
  );
  check("a follow-up the gap pass ruled out goes too", kept?.length === 1 && kept[0].label === "Reorder list");
  check(
    "and nothing left is undefined, not an empty list",
    asNextSteps([{ label: "Photos", prompt: "attach a photo" }], ["attach a photo"]) === undefined
  );
}

console.log("\na plain-plans reply");
{
  const plans = parseReply(
    JSON.stringify({
      type: "plans",
      message: "Done.",
      plans: WORKED_EXAMPLE.plans,
      next: [{ label: "Warn me", prompt: "Flag stock at or below 3" }],
    }),
    [],
    null,
    null
  );
  check("carries its follow-up the same way", plans.ok && plans.reply.type === "plans" && plans.reply.next?.length === 1);
}

console.log(
  fails.length === 0 ? "\nwhat comes next is the model's, and only where it is whole" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
