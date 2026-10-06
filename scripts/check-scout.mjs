// Scout (lib/scout, 0189): the store as it is, read before Luke designs.
// From a profile shaped as the database returns it: every field a design
// may name on a list with rows, by its exact name; how full each is; the
// values it holds when few; the lists that are empty here; and Luke's
// design and plan prompts carrying all of it, with the reviewers' simpler
// ways read before the design rather than after. Pure: no database.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-scout.mjs

import { buildPlanPrompt, buildSystemPrompt } from "../src/lib/ai.ts";
import { scoutLines, scoutSize } from "../src/lib/scout.ts";
import { SIMPLER_WAYS } from "../src/lib/simpler.ts";
import { STORE_TABLES, storeTableSchema } from "../src/lib/store-read.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const orders = {
  sampled: 2000,
  columns: {
    order_number: { type: "string", filled: 100, distinct: 2000, values: null },
    status: { type: "string", filled: 100, distinct: 3, values: { PAID: 1203, PENDING: 780, REFUNDED: 17 } },
    gateway: { type: "string", filled: 100, distinct: 2, values: { razorpay: 1400, "Cash on Delivery (COD)": 600 } },
    ship_city: { type: "string", filled: 61, distinct: 140, values: null },
    discount_codes: { type: "empty", filled: 0, distinct: 0, values: null },
  },
};
const profile = { [STORE_TABLES.orders.view]: orders };
const lines = scoutLines(profile, { orders: 2464 });
const line = lines.find((l) => l.startsWith("  orders ")) ?? "";

console.log("the brief");
check("a list with rows says how many, and how many were read", line.includes("2,464 rows, 2000 read"));
check(
  "every field a design may name, by its exact name",
  storeTableSchema("orders").columns.every((c) => line.includes(`${c.field} ${c.type}`))
);
check("a field filled on some rows says how many", line.includes("ship_city text 61% filled"));
check("one never filled says so", line.includes("discount_codes text (always empty here)"));
check(
  "few values come with how many rows hold each",
  line.includes("{PAID 1,203 · PENDING 780 · REFUNDED 17}") && line.includes("Cash on Delivery (COD) 600")
);
check("an id-like field lists no values", !/order_number text \{/.test(line));
check(
  "a field the profile never saw reads as empty, not as missing",
  line.includes("customer_phone phone (always empty here)")
);
check(
  "the lists with no rows are named once",
  lines.at(-1).startsWith("  Empty in this store:") && lines.at(-1).includes("refunds")
);
check("its size, for the turn's step", JSON.stringify(scoutSize(profile)) === JSON.stringify({ lists: 1, fields: 5 }));

console.log("\nLuke reads it");
const store = {
  shop_domain: "scout-check.myshopify.com",
  timezone: "Asia/Kolkata",
  currency: "INR",
  counts: { orders: 2464 },
  values: { "orders.financial_status": ["OLD WAY"] },
  profile,
};
const [contract, context] = buildSystemPrompt([], "Scout", "en-IN", "INR", store);
check(
  "the design prompt carries the brief",
  context.includes("THE STORE, FIELD BY FIELD") && context.includes(line.trim())
);
check("and not the older six columns' values beside it", !context.includes("OLD WAY"));
const [, planContext] = buildPlanPrompt([], "Scout", "en-IN", "INR", store);
check("the plan reads it too", planContext.includes(line.trim()));
const [, before] = buildSystemPrompt([], "Scout", "en-IN", "INR", { ...store, profile: null });
check(
  "a database before 0189 still gives the values it had",
  before.includes("OLD WAY") && !before.includes("FIELD BY FIELD")
);

console.log("\nthe simple way, first");
check(
  "the design contract names every simpler way the reviewer sends back for",
  contract.includes("BUILD THE SIMPLE WAY FIRST") && SIMPLER_WAYS.every((w) => contract.includes(w))
);

console.log(fails.length === 0 ? "\nLuke designs on the store as it is" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
