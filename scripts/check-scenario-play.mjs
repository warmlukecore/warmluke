// The owner's own work played on a design (lib/scenarios.ts, 5 Oct): a
// row added through the form picks a linked row and fills from it, a
// choice is one of the field's own, a filter lists the row or not, a
// button shows and settles it, the design's rules run on what is saved,
// a counter moves. Each step that cannot be done says why, as the owner
// would meet it. Pure: no database, no model.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-scenario-play.mjs

import { describeForScenarios, parseScenarios, playDay, playScenario, rulesFor } from "../src/lib/scenarios.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const orders = {
  name: "Orders",
  store: true,
  columns: [
    { field: "order_number", label: "Order", type: "text" },
    { field: "customer_name", label: "Customer", type: "text" },
  ],
  rows: [
    { id: "o-1", order_number: "#1042", customer_name: "Asha" },
    { id: "o-2", order_number: "#1043", customer_name: "Ravi" },
  ],
};
const targetOf = (l) => (l === "m-orders" ? orders : null);
const returns = {
  plan: 0,
  name: "Returns",
  columns: [
    { field: "order", label: "Order", type: "link", linkTo: "m-orders" },
    { field: "customer_name", label: "Customer", type: "text" },
    { field: "reason", label: "Reason", type: "dropdown" },
    { field: "status", label: "Status", type: "badge" },
    { field: "amount", label: "Amount", type: "currency" },
  ],
  features: {
    filters: [
      { field: "reason", label: "Reason", options: ["Size", "Damaged"] },
      { field: "status", label: "Status", options: ["Requested", "Received"] },
    ],
    actions: [
      {
        label: "Received",
        set: { status: { const: "Received" } },
        when: { op: "!=", args: [{ field: "status" }, { const: "Received" }] },
      },
    ],
    stats: [
      {
        label: "Open returns",
        op: "count",
        where: { op: "=", args: [{ field: "status" }, { const: "Requested" }] },
      },
    ],
  },
  rows: [
    { customer_name: "Meera", reason: "Size", status: "Requested" },
    { customer_name: "Kabir", reason: "Damaged", status: "Received" },
  ],
  storeFields: new Set(),
  fresh: new Set(),
};
const play = (steps, rules = []) => playScenario(returns, { title: "t", section: "Returns", steps }, targetOf, rules);
const why = (steps, rules) => play(steps, rules).why ?? "";

console.log("the owner's work, done as they would");
{
  const r = play([
    { add: { pick: { Order: "any" }, set: { Reason: "Damaged", Status: "Requested" } } },
    { expect: { Customer: "filled" } },
    { filter: { Reason: "Damaged" }, shows: true },
    { filter: { Reason: "Size" }, shows: false },
    { counter: "Open returns", goes: "up" },
    { press: "Received" },
    { expect: { Status: "Received" } },
    // Read against the step just before it: receiving it takes it off the open ones.
    { counter: "Open returns", goes: "down" },
  ]);
  check("a return logged, found, received and counted goes through", r.ok);
  check(
    "a row already there is found and worked on",
    play([{ find: { Customer: "Meera" } }, { press: "Received" }, { counter: "Open returns", goes: "down" }]).ok
  );
  check(
    "with no row in hand, a filter lists the rows there are",
    play([{ filter: { Reason: "Damaged" }, shows: true }]).ok &&
      !play([{ filter: { Status: "Refunded" }, shows: true }]).ok
  );
  check(
    "a row that is not there cannot be found",
    /No Returns row has Customer "Nobody"/.test(why([{ find: { Customer: "Nobody" } }]))
  );
  check(
    "picking by words picks that row",
    play([{ add: { pick: { Order: "1043" } } }, { expect: { Customer: "Ravi" } }]).ok
  );
}

console.log("\nwhat cannot be done is said as the owner would meet it");
{
  check(
    "a reason that is not one of the choices",
    /"Wrong item" is not one of Reason's choices \(Size, Damaged\)/.test(
      why([{ add: { set: { Reason: "Wrong item" } } }])
    )
  );
  check("a button the design does not have", /no "Refunded" button/.test(why([{ add: {} }, { press: "Refunded" }])));
  check(
    "a button that does not show on the row",
    /"Received" button does not show/.test(why([{ add: { set: { Status: "Received" } } }, { press: "Received" }]))
  );
  check(
    "a filter there is none of",
    /no City filter/.test(why([{ add: {} }, { filter: { City: "Pune" }, shows: true }]))
  );
  check(
    "a choice the filter does not offer",
    /Reason filter has no "Lost"/.test(why([{ add: {} }, { filter: { Reason: "Lost" }, shows: true }]))
  );
  check(
    "a counter that does not move as the owner expects",
    /"Open returns" counter stays the same, not up/.test(
      why([{ add: { set: { Status: "Received" } } }, { counter: "Open returns", goes: "up" }])
    )
  );
  check("a field that is not there", /no field "Courier"/.test(why([{ add: { set: { Courier: "Delhivery" } } }])));
  check("money typed as words", /Amount takes a number/.test(why([{ add: { set: { Amount: "nine hundred" } } }])));
  check("a scan the section does not have", /Returns has no scan/.test(why([{ add: {} }, { scan: "the row" }])));
  check(
    "a link with nothing to pick",
    /Order has nothing to pick/.test(
      playScenario(
        returns,
        { title: "t", section: "Returns", steps: [{ add: { pick: { Order: "any" } } }] },
        () => ({ ...orders, rows: [] }),
        []
      ).why ?? ""
    )
  );
  check("looking at a row before there is one", /no row yet/.test(why([{ expect: { Status: "Requested" } }])));
}

console.log("\nthe design's rules run on what is saved");
{
  const rule = (target, name, value) => ({
    changeType: "AUTOMATION_ADD",
    targetModuleId: target,
    automation: {
      name,
      definition: {
        trigger: { type: "record_created" },
        actions: [{ type: "set_fields", target: { self: true }, set: { status: { const: value } } }],
      },
    },
  });
  const rules = rulesFor(
    [rule("#returns", "New returns start Requested", "Requested"), rule("m-other", "Not this section", "Lost")],
    (ref) => ref === "#returns"
  );
  check("only this section's rules are run", rules.length === 1);
  check("a rule on new rows sets the status", play([{ add: {} }, { expect: { Status: "Requested" } }], rules).ok);
  check("without it, the row is blank", !play([{ add: {} }, { expect: { Status: "Requested" } }]).ok);
}

console.log("\na field changed in the row's form");
{
  check(
    "changed, and counted",
    play([
      { add: { set: { Status: "Requested" } } },
      { edit: { Status: "Received" } },
      { expect: { Status: "Received" } },
      { counter: "Open returns", goes: "down" },
    ]).ok
  );
  check(
    "to a value that is not a choice: said so",
    /"Lost" is not one of Status's choices/.test(why([{ add: {} }, { edit: { Status: "Lost" } }]))
  );
}

console.log("\na button there is none of, where a status of that name is");
{
  const r = play([
    { add: { set: { Status: "Requested" } } },
    { press: "Received" },
    { press: "Requested" },
    { expect: { Status: "Requested" } },
  ]);
  check("done the long way, by changing the status in the row", r.ok === true);
  check(
    "and said as a note",
    /no "Requested" button: it is done by changing Status to Requested in the row/.test(r.notes?.[0] ?? "")
  );
}

console.log("\na scenario's own mistake is not held against the design");
{
  check("a row it assumed that is not there: not tried", play([{ find: { Customer: "Nobody" } }]).ok === null);
  check(
    "a row it misread under a filter: not tried",
    play([{ add: { set: { Reason: "Size" } } }, { filter: { Reason: "Damaged" }, shows: true }]).ok === null
  );
  const transit = {
    ...returns,
    features: { filters: [{ field: "status", label: "Shipment", options: ["In Transit", "Delivered"] }] },
  };
  check(
    "a row that is the choice and still not listed is the break: the rows' spelling, not the filter's",
    playScenario(
      transit,
      { title: "t", section: "Returns", steps: [{ add: {} }, { filter: { Shipment: "In Transit" }, shows: true }] },
      targetOf,
      [{ name: "store says", on: "record_created", set: { status: { const: "IN_TRANSIT" } } }]
    ).ok === false
  );
}

console.log("\na day's work: one scenario after another, on the same rows");
{
  const day = playDay(
    [{ s: returns, rules: [] }],
    [
      {
        title: "logs a return",
        section: "Returns",
        steps: [{ add: { set: { Reason: "Damaged", Status: "Requested" } } }],
      },
      {
        title: "receives it",
        section: "Returns",
        steps: [{ find: { Reason: "Damaged", Status: "Requested" } }, { press: "Received" }],
      },
    ],
    targetOf
  );
  check(
    "the row one adds is there for the next",
    day.every((p) => p.ok)
  );
  check(
    "each says which part of the design it tried",
    day.every((p) => p.plan === 0)
  );
  check("the section's own rows are left as they were", returns.rows.length === 2);
}

console.log("\nwhat the model is told, and what it writes");
{
  const told = describeForScenarios(returns, targetOf, []);
  check("the section, its fields and their choices", told.includes("Reason (dropdown: Size, Damaged)"));
  check("what a link picks", told.includes("Order (picks a row of Orders)"));
  check(
    "its buttons and counters",
    told.includes("Buttons on each row: Received") && told.includes("Counters: Open returns")
  );
  const parsed = parseScenarios(
    '```json\n{"scenarios":[{"title":"a","section":"Returns","steps":[{"add":{}}]},{"title":"b"},{"title":"c","section":"Returns","steps":[]},{"title":"d","section":"R","steps":[]},{"title":"e","section":"R","steps":[]},{"title":"f","section":"R","steps":[]}]}\n```'
  );
  check("read through a fence, the malformed left out, four at most", parsed.length === 4 && parsed[0].title === "a");
  check("not JSON is none", parseScenarios("I think...").length === 0);
}

console.log(fails.length === 0 ? "\nthe owner's work is played on the design" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
