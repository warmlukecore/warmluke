// What the assistant is told about a connected store, and what the
// approval card warns about when a section would duplicate it.
//
// No account and no network: both are pure functions of a plan and some
// counts, which is the whole reason they were written that way.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-context.mjs

import { buildSystemPrompt } from "../src/lib/ai.ts";
import { storeOverlap } from "../src/lib/describe.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const store = (over = {}) => ({
  shop_domain: "acme.myshopify.com",
  timezone: "America/New_York",
  currency: "USD",
  importing: false,
  counts: { products: 21, customers: 6, orders: 4, inventory_levels: 35 },
  ...over,
});

const prompt = (s, projectCurrency = "USD") =>
  buildSystemPrompt([], "Acme", "en-US", projectCurrency, s)[1];

console.log("the contract block must stay identical for every project");
// The system prompt is two blocks so the big one can be cached. If the
// store ever leaked into the first block, every project would be a
// different prefix and the cache would stop paying for itself.
const [contractA] = buildSystemPrompt([], "Acme", "en-US", "USD", store());
const [contractB] = buildSystemPrompt([], "Other", "en-IN", "INR", null);
check("the cached block does not change with the store", contractA === contractB);

console.log("\na project with no store is untouched");
const bare = prompt(null);
check("nothing about a store is mentioned", !/CONNECTED STORE/.test(bare));
check("and it still describes the project", /PROJECT: "Acme"/.test(bare));

console.log("\na connected store is described honestly");
const full = prompt(store());
check("the shop is named", full.includes("acme.myshopify.com"));
check("the counts are given", /orders 4/.test(full) && /products 21/.test(full));
check(
  "it says the data is read-only, not a section they built",
  /read-only copy/.test(full) && /not a section they built/.test(full)
);
check("empty tables are left out rather than reported as zero", !/order_line_items 0/.test(full));

console.log("\na half-finished import is not quoted as final");
const mid = prompt(store({ importing: true }));
check("it says the counts are partial", /still importing/.test(mid));
check("a finished import says no such thing", !/still importing/.test(full));

console.log("\nnothing imported yet is not the same as no store");
const empty = prompt(store({ counts: {} }));
check("it says nothing has arrived", /Nothing has imported yet/.test(empty));
// The trap: telling the model to "design on top of it" when there is no
// data produces an app built on an empty table.
check("and it does not say to design on top of it", !/Design on top of it/.test(empty));

console.log("\nthe store's money is not the project's money");
// The seeded store sells in USD inside a project set to INR. Demo
// amounts in the wrong currency look right and are not.
const mixed = prompt(store(), "INR");
check("the mismatch is called out", /sells in USD but this project is set to INR/.test(mixed));
check("a matching currency says nothing", !/but this project is set to/.test(full));

console.log("\nthe approval card warns when a section duplicates the store");
const facts = {
  shop_domain: "acme.myshopify.com",
  currency: "USD",
  counts: { orders: 4, customers: 6, products: 21, inventory_levels: 35 },
};
const newModule = (label) => ({
  changeType: "NEW_MODULE",
  newModule: { name: label.toLowerCase(), nav_label: label },
});

check(
  "a new Orders section is flagged",
  storeOverlap(newModule("Orders"), facts)[0]?.includes("already has 4 orders")
);
check(
  "Sales counts as orders, because that is what they call it",
  storeOverlap(newModule("Sales"), facts).length === 1
);
check(
  "Stock is matched to inventory levels",
  storeOverlap(newModule("Stock"), facts)[0]?.includes("35 stock levels")
);
check("Customers is flagged", storeOverlap(newModule("Customer list"), facts).length === 1);
check(
  "the warning says the two lists will not match",
  storeOverlap(newModule("Orders"), facts)[0]?.includes("will not match")
);

console.log("\nand stays quiet when it should");
check(
  "a section about something else is not flagged",
  storeOverlap(newModule("Packing slips"), facts).length === 0
);
check("no store, no warning", storeOverlap(newModule("Orders"), null).length === 0);
// A store with no orders imported has nothing to duplicate, so warning
// about it would be the app inventing a conflict.
check(
  "an empty orders table produces no warning",
  storeOverlap(newModule("Orders"), { ...facts, counts: { orders: 0 } }).length === 0
);
check(
  "changing an existing section is not a duplicate",
  storeOverlap({ changeType: "FIELD_ADD", targetModuleId: "x" }, facts).length === 0
);
check(
  "a nameless plan is not guessed at",
  storeOverlap({ changeType: "NEW_MODULE", newModule: {} }, facts).length === 0
);
// "Reordering" must not read as "orders".
check(
  "a word that merely contains the letters is not matched",
  storeOverlap(newModule("Reordering"), facts).length === 0
);

console.log(fails.length === 0 ? "\nthe assistant is told the truth" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
