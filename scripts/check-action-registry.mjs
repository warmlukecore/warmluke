// Every change Warmluke can make, held to the same rules.
//
// The point of a registry is that the fifth entry costs what the
// first did. That only holds if something walks it: otherwise entry
// five arrives with no undo, a read scope, a mutation that forgets
// to ask for userErrors, and nothing says so until a merchant's shop
// is the thing that notices.
//
// So this iterates STORE_ACTIONS rather than naming actions. Adding
// one means adding a line of sample data below — the check refuses
// to pass an action it has no example for, which is the cheapest way
// to make "add an entry" also mean "say what it does".
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-action-registry.mjs

import { ACTIONS, ACTION_SCOPES, MOST_TARGETS, STORE_ACTIONS, actionSpec } from "../src/lib/store-actions.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

/** One believable call per action. A new action with none fails below. */
const SAMPLES = {
  add_tags: {
    targets: [{ id: "gid://shopify/Order/1" }, { id: "gid://shopify/Order/2" }],
    params: { tags: ["rush"] },
  },
  remove_tags: {
    targets: [{ id: "gid://shopify/Order/1" }],
    params: { tags: ["rush"] },
  },
  set_order_note: {
    targets: [{ id: "gid://shopify/Order/1" }],
    params: { note: "Customer asked for delivery after 6pm" },
  },
  set_stock: {
    targets: [{ id: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", quantity: 40 }],
    params: {},
  },
};

console.log("every action has an example to be checked against");
for (const name of ACTIONS) check(`${name}`, !!SAMPLES[name]);
check("and no example names an action nobody declared", Object.keys(SAMPLES).every((k) => !!actionSpec(k)));

for (const name of ACTIONS) {
  const spec = STORE_ACTIONS[name];
  const sample = SAMPLES[name];
  if (!sample) continue;
  console.log(`\n${name}`);

  check("it is called something", typeof spec.label === "string" && spec.label.length > 2);
  check("it belongs to a connector", spec.connector === "shopify");
  check("it says how sure the merchant must be", spec.confirm === "list" || spec.confirm === "typed");

  // A read scope here is the mistake worth catching: it would pass
  // every test in a read-only app and do nothing in a real one.
  check("it asks only for write scopes", spec.scopes.length > 0 && spec.scopes.every((s) => s.startsWith("write_")));

  const said = spec.say(sample.targets, sample.params);
  check("it can be said in a sentence", typeof said === "string" && said.length > 10);
  check("and the sentence counts what it touches", /\b\d+\b|\bone\b/.test(said));

  check("nothing to do is refused", typeof spec.check([], sample.params) === "string");
  check("and a real one is allowed", spec.check(sample.targets, sample.params) === null);

  check("the mutation is a mutation", /^\s*mutation\s/.test(spec.mutation));
  // Without userErrors Shopify's refusals come back as a success
  // with nothing in it, and the action is recorded as done.
  check("and it asks for userErrors", /userErrors\s*{[^}]*message/.test(spec.mutation));

  const vars = spec.variables(sample.targets[0], sample.params);
  check("one call names the thing it changes", JSON.stringify(vars).includes(sample.targets[0].id));

  check("a refusal is found in the answer", spec.errors({ data: { x: { userErrors: [{ message: "no" }] } } }).length === 1);
  check("and a clean answer has none", spec.errors({ data: { x: { node: { id: "1" } } } }).length === 0);

  if (spec.undo) {
    const back = spec.undo(sample.targets, sample.params);
    check("its undo names a real action", !!actionSpec(back.action));
    check("and is not itself", back.action !== name);
    const other = actionSpec(back.action);
    check("and that one undoes it in turn", other?.undo?.(back.targets, back.params)?.action === name);
  } else {
    check("no undo, and it says why", typeof spec.undoNote === "string" && spec.undoNote.length > 20);
  }
}

console.log("\nand the registry adds up");
check("every scope is a write scope", ACTION_SCOPES.every((s) => s.startsWith("write_")));
check("and each is listed once", new Set(ACTION_SCOPES).size === ACTION_SCOPES.length);
check("an unknown action has no spec", actionSpec("delete_everything") === null);
check("and there is a ceiling on how much one change touches", MOST_TARGETS > 0 && MOST_TARGETS <= 500);

console.log(fails.length === 0 ? "\nthe fifth entry will cost what the first did" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
