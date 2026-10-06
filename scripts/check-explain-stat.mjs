// How a stat is worked out, in the owner's words (lib/describe explainStat,
// 6 Oct: Tanish asked for an "i" saying how the numbers are calculated).
// Read off the stat as saved: what it counts or adds up, which rows, how a
// worked-out column it reads is worked out, and what narrows it on screen,
// by the names on their table; never a field's key, never a model. Luke's
// own descriptions keep the keys. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-explain-stat.mjs

import { exprText, explainStat } from "../src/lib/describe.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const columns = [
  { field: "total", label: "Total", type: "currency" },
  { field: "status", label: "Status", type: "badge" },
  { field: "fulfilment_status", label: "Fulfilment", type: "badge" },
  { field: "ship_city", label: "City", type: "text" },
  {
    field: "delivered_paid",
    label: "Delivered & paid",
    type: "boolean",
    compute: {
      op: "and",
      args: [
        { op: "=", args: [{ field: "fulfilment_status" }, { const: "FULFILLED" }] },
        { op: "=", args: [{ field: "status" }, { const: "PAID" }] },
      ],
    },
  },
];

console.log("a sum over some rows, in the dates chosen");
const net = explainStat(
  {
    label: "Net sales",
    op: "sum",
    value: { field: "total" },
    where: { op: "=", args: [{ field: "delivered_paid" }, { const: true }] },
  },
  columns,
  { period: "Placed 1 Sept 2026 – 30 Sept 2026" }
);
check("says what it adds up, by its label", net[0] === "Adds up Total");
check("which rows, a tick read as ticked", net.includes("Only the rows where Delivered & paid is ticked"));
check(
  "how the worked-out column it reads is worked out, by labels",
  net.some((l) => l.startsWith("Delivered & paid is worked out as Fulfilment is FULFILLED and Status is PAID"))
);
check(
  "and the dates it is over",
  net.at(-1) === "Over the rows in the dates chosen above (Placed 1 Sept 2026 – 30 Sept 2026)"
);
check("never a field's key", !net.join(" ").match(/fulfilment_status|delivered_paid|\btotal\b/));

console.log("\na count, split, and narrowed");
const byCity = explainStat({ label: "Orders by city", op: "count", by: "ship_city", limit: 3 }, columns, {
  narrowed: true,
});
check("counts the rows", byCity[0] === "Counts the rows");
check("split by the label, with how many shown", byCity.includes("Split by City: the top 3"));
check("over what the search and filters leave", byCity.at(-1) === "Over the rows the search and filters above leave");
check(
  "and over every row when nothing narrows it",
  explainStat({ label: "All", op: "count" }, columns).at(-1) === "Over every row in this section"
);

console.log("\nLuke's words unchanged");
check(
  "a description for Luke still names fields by key",
  exprText({ op: "=", args: [{ field: "status" }, { const: "PAID" }] }) === "status is PAID"
);

console.log(fails.length === 0 ? "\na stat says how it is worked out" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
