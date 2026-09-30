// What a design may ask of a rule that says no (0143), and how it reads.
//
// The database refuses a save when a before_save rule's "when" holds
// (check-guards races it). This is the gate in front of that: a rule that
// could never be judged — a store list that is not one, a key the list
// does not have, a refusal with nothing to say — is sent back with what
// to write instead, before anybody approves it; and the Rules screen says
// what an approved one refuses, in words.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-guard-design.mjs

import { validatePlan } from "../src/lib/ai.ts";
import { describeAutomation } from "../src/lib/describe.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const HOLDS = "11111111-1111-4111-8111-111111111111";
const modules = [
  {
    id: HOLDS,
    project_id: "p",
    parent_id: null,
    name: "holds",
    nav_label: "Holds",
    icon: "box",
    route: "/holds",
    sort_order: 1,
    source_table: null,
    created_at: "2026-09-30",
  },
];
const schema = {
  columns: [
    { field: "item", label: "Item", type: "text" },
    { field: "place", label: "Place", type: "text" },
    { field: "qty", label: "Qty", type: "number" },
    { field: "status", label: "Status", type: "badge" },
    { field: "slot", label: "Slot", type: "text" },
  ],
};
const guard = (definition, name = "No more held than can be sold") =>
  validatePlan(
    {
      changeType: "AUTOMATION_ADD",
      targetModuleId: HOLDS,
      automation: { name, definition },
      explanation: "Stops a hold that would pass what can be sold.",
    },
    modules,
    schema,
    null
  );
const errorsOf = (v) => (v.ok ? [] : v.errors);

const stockLeft = (overrides = {}) => ({
  op: "store_value",
  args: [
    { const: overrides.list ?? "inventory_levels" },
    { const: overrides.field ?? "available" },
    { const: overrides.key ?? "inventory_item_id" },
    { field: "item" },
    { const: "location_id" },
    { field: "place" },
  ],
});
const heldBefore = {
  op: "sum_matching",
  args: [
    { field: "qty" },
    { field: "item" },
    { field: "place" },
    { op: "!=", args: [{ field: "status" }, { const: "Released" }] },
  ],
};
const whenOver = (left = stockLeft()) => ({
  op: ">",
  args: [{ op: "+", args: [heldBefore, { field: "qty" }] }, left],
});
const refuse = { type: "refuse", message: "Not enough left to hold that many." };

console.log("what is taken");
const hold = guard({ trigger: { type: "before_save", when: whenOver() }, actions: [refuse] });
check("a hold that must not pass what can be sold", hold.ok);
if (!hold.ok) console.log(`     errors were: ${hold.errors.join(" | ")}`);
const slot = guard(
  {
    trigger: {
      type: "before_save",
      when: { op: ">=", args: [{ op: "count_matching", args: [{ field: "slot" }] }, { const: 1 }] },
    },
    actions: [{ type: "refuse", message: "That slot is already taken." }],
  },
  "One booking a slot"
);
check("a slot that can be booked once", slot.ok);

console.log("\nwhat is sent back, and with what to write instead");
const notAList = errorsOf(
  guard({ trigger: { type: "before_save", when: whenOver(stockLeft({ list: "warehouse" })) }, actions: [refuse] })
);
check(
  "a store list that is not one",
  notAList.some((e) => /first names one of the store's lists/.test(e) && /inventory_levels/.test(e))
);
const notAField = errorsOf(
  guard({ trigger: { type: "before_save", when: whenOver(stockLeft({ field: "stock" })) }, actions: [refuse] })
);
check(
  "a field the list does not have",
  notAField.some((e) => /reads a field inventory_levels rows have/.test(e) && /available/.test(e))
);
const notAKey = errorsOf(
  guard({ trigger: { type: "before_save", when: whenOver(stockLeft({ key: "product_name" })) }, actions: [refuse] })
);
check(
  "a key the list does not have, naming its real keys",
  notAKey.some((e) => /not one; its keys are id, inventory_item_id, location_id/.test(e))
);
const noWhen = errorsOf(guard({ trigger: { type: "before_save" }, actions: [refuse] }));
check(
  "a rule that says no with nothing to judge",
  noWhen.some((e) => /needs a "when"/.test(e))
);
const doesMore = errorsOf(
  guard({
    trigger: { type: "before_save", when: whenOver() },
    actions: [refuse, { type: "set_fields", target: { self: true }, set: { status: { const: "Held" } } }],
  })
);
check(
  "a rule that says no and does something else too",
  doesMore.some((e) => /does one thing/.test(e))
);
const silent = errorsOf(
  guard({ trigger: { type: "before_save", when: whenOver() }, actions: [{ type: "refuse", message: " " }] })
);
check(
  "a refusal with nothing to say",
  silent.some((e) => /says what to do instead/.test(e))
);
const afterwards = errorsOf(guard({ trigger: { type: "record_created" }, actions: [refuse] }));
check(
  "a refusal on a rule that runs after the save",
  afterwards.some((e) => /Only a before_save rule can refuse/.test(e))
);
const sweep = errorsOf(
  guard({
    trigger: {
      type: "before_save",
      when: {
        op: ">",
        args: [
          {
            op: "sum_matching",
            args: [{ field: "qty" }, { op: "!=", args: [{ field: "status" }, { const: "Released" }] }],
          },
          { const: 5 },
        ],
      },
    },
    actions: [refuse],
  })
);
check(
  "a sum over the whole section, with nothing to match on",
  sweep.some((e) => /at least one field to match siblings on/.test(e))
);

console.log("\nhow an approved one reads");
const said = describeAutomation(
  {
    name: "No more held than can be sold",
    definition: { trigger: { type: "before_save", when: whenOver() }, actions: [refuse] },
  },
  modules
).join(" ");
check("it says it acts before the save", said.startsWith("Before a row is saved, refuse it if"));
check(
  "what it adds up and what it compares with",
  /the qty of other rows with the same item and place where status is not Released, added up/.test(said) &&
    /the store's available in inventory levels for inventory_item_id item, location_id place/.test(said)
);
check("and what it says when it refuses", /refuse, saying “Not enough left to hold that many\.”/.test(said));

console.log(fails.length === 0 ? "\na rule that says no is written so it can be judged" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
