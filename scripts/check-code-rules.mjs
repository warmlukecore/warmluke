// A rule's own code (automation action "run_code"): what is taken, and
// what comes back.
//
// Code that exports its function is taken; code that does not, or is
// past the size a rule should be, is not. A code rule rides on a row
// being added or changed, never a schedule (the app runs it after its
// own write), reads only sections of the project, and its "when" is
// what the app can evaluate. What the code hands back is read as
// writes and rows, and anything else in it is dropped.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-code-rules.mjs

import { CODE_MAX, codeProblem, parseResult } from "../src/lib/code-run.ts";
import { parseReply } from "../src/lib/ai.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const code = "export default function run({ row }) { return { set: [{ id: row.id, fields: { charge: 40 } }] }; }";

console.log("the code");
check("a function it exports is taken", codeProblem(code) === null);
check("an async one too", codeProblem("export default async function run() { return {}; }") === null);
check(
  "code that exports nothing is refused, and says how",
  /export default function run/.test(codeProblem("function run() {}") ?? "")
);
check(
  "and so is code past the size of a rule",
  /keep it under/.test(codeProblem(`export default function r(){}${"x".repeat(CODE_MAX)}`) ?? "")
);

console.log("\nwhat comes back");
const out = parseResult({
  set: [
    { id: "a", fields: { charge: 40 } },
    { id: "b", fields: { x: 1 }, section: "#rates" },
    { id: 3, fields: {} },
    { fields: {} },
  ],
  add: [{ fields: { note: "n" } }, { note: "no fields" }],
  secret: "dropped",
});
check(
  "writes with an id and fields are kept, with the section they name",
  out.set.length === 2 && out.set[1].section === "#rates"
);
check("and rows to add with fields", out.add.length === 1);
check("anything else is dropped", !("secret" in out));
check("and nothing at all is no result", parseResult(null) === null && parseResult("x") === null);

console.log("\nthe rule, as the validator reads it");
const modules = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "p",
    name: "parcels",
    nav_label: "Parcels",
    icon: "table",
    source_table: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    project_id: "p",
    name: "rates",
    nav_label: "Rates",
    icon: "table",
    source_table: null,
  },
];
const schema = {
  columns: [
    { field: "weight", label: "Weight (g)", type: "number" },
    { field: "charge", label: "Charge", type: "currency" },
  ],
};
const rule = (trigger, action) =>
  parseReply(
    JSON.stringify({
      type: "plans",
      message: "A rule.",
      plans: [
        {
          changeType: "AUTOMATION_ADD",
          targetModuleId: modules[0].id,
          automation: { name: "charge by slab", definition: { trigger, actions: [action] } },
          explanation: "Works out the courier charge.",
        },
      ],
    }),
    modules,
    schema,
    null
  );
const changedWeight = { type: "record_updated", when: { op: "changed", args: [{ field: "weight" }] } };
const taken = rule(changedWeight, { type: "run_code", reads: ["#rates"], code });
check("a code rule on a changed weight, reading the rate card, is taken", taken.ok);
if (!taken.ok) console.log("     →", taken.errors);
const scheduled = rule({ type: "schedule", every: "daily" }, { type: "run_code", code });
check(
  "but not on a schedule: it runs after the owner's own write",
  !scheduled.ok && scheduled.errors.some((e) => /record_created" or "record_updated/.test(e))
);
const nowhere = rule(changedWeight, { type: "run_code", reads: ["#nowhere"], code });
check("and it reads only sections of this project", !nowhere.ok && nowhere.errors.some((e) => /"reads"/.test(e)));
const serverOnly = rule(
  {
    type: "record_updated",
    when: { op: "=", args: [{ op: "count_matching", args: [{ field: "weight" }] }, { const: 0 }] },
  },
  { type: "run_code", code }
);
check("and its when is what the app can evaluate", !serverOnly.ok);

console.log(
  fails.length === 0
    ? "\na rule's own code is taken when it can run, and hands back only writes"
    : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
