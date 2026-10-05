// A button that waits for the owner (lib/row-approval.ts, 0183, #6, 5 Oct):
// what a button does to a row is worked out from the row, as the screen
// does it, and only where it shows; a teammate's hand edit that would make
// an approval button's change is named by that button, while one that
// makes another button's change, or none, or one already made, is not; a
// design marks a button for the owner's yes with true alone, and its card
// says so. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-row-approval.mjs

import { parseReply } from "../src/lib/ai.ts";
import { describeFeaturesFull } from "../src/lib/describe.ts";
import { actionNamed, actionOn, approvalNeededFor } from "../src/lib/row-approval.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const is = (field, value) => ({ op: "=", args: [{ field }, { const: value }] });
const columns = [
  { field: "customer", label: "Customer", type: "text" },
  { field: "status", label: "Status", type: "badge" },
  { field: "refund", label: "Refund", type: "currency" },
  { field: "amount", label: "Amount", type: "currency" },
];
const features = {
  actions: [
    { label: "Received", set: { status: { const: "Received" } }, when: is("status", "Requested") },
    {
      label: "Refund",
      approval: true,
      set: { status: { const: "Refunded" }, refund: { field: "amount" } },
      when: is("status", "Received"),
    },
  ],
};
const received = { customer: "Asha", status: "Received", amount: 900, refund: "" };

console.log("what a button does to a row");
{
  const refund = actionNamed(features, "Refund");
  const done = actionOn(refund, columns, received);
  check("worked out from the row, as the screen does", done.status === "Refunded" && done.refund === 900);
  check("only where it shows", actionOn(refund, columns, { ...received, status: "Requested" }) === null);
  check(
    "found by its label",
    actionNamed(features, "Received")?.label === "Received" && actionNamed(features, "Nope") === null
  );
}

console.log("\na teammate's edit by hand");
{
  check(
    "making the Refund button's change: named by it",
    approvalNeededFor(features, columns, received, { status: "Refunded" }) === "Refund"
  );
  check("however it is spelled", approvalNeededFor(features, columns, received, { status: " refunded " }) === "Refund");
  check("through its other field too", approvalNeededFor(features, columns, received, { refund: 900 }) === "Refund");
  check(
    "another button's change is not",
    approvalNeededFor(features, columns, { ...received, status: "Requested" }, { status: "Received" }) === null
  );
  check(
    "an edit that changes something else is not",
    approvalNeededFor(features, columns, received, { customer: "Asha K" }) === null
  );
  check(
    "a row the button does not show on is not",
    approvalNeededFor(features, columns, { ...received, status: "Requested" }, { status: "Refunded" }) === null
  );
  check(
    "a change already made is not made again",
    approvalNeededFor(features, columns, { ...received, status: "Refunded", refund: 900 }, { status: "Refunded" }) ===
      null
  );
  check(
    "no button that waits, nothing to name",
    approvalNeededFor({ actions: [features.actions[0]] }, columns, received, { status: "Refunded" }) === null
  );
}

console.log("\nthe design, and its card");
{
  const modules = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      project_id: "p",
      name: "returns",
      nav_label: "Returns",
      icon: "table",
      source_table: null,
    },
  ];
  const plan = (approval) =>
    parseReply(
      JSON.stringify({
        type: "plans",
        message: "Buttons.",
        plans: [
          {
            changeType: "FEATURE_UPDATE",
            targetModuleId: modules[0].id,
            features: { actions: [{ ...features.actions[1], approval }] },
            explanation: "A refund needs the owner's yes.",
          },
        ],
      }),
      modules,
      { columns },
      null
    );
  const taken = plan(true);
  check("a button marked for the owner's yes is taken", taken.ok);
  if (!taken.ok) console.log("     →", taken.errors);
  const odd = plan("yes");
  check("marked with true alone", !odd.ok && odd.errors.some((e) => /"approval" is true/.test(e)));
  check(
    "its card says a teammate's press waits",
    describeFeaturesFull(features, modules).some((l) =>
      /Button “Refund”.*a teammate's press waits for your yes/.test(l)
    )
  );
}

console.log(fails.length === 0 ? "\na button that waits for the owner waits, by hand too" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
