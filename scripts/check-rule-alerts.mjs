// A rule that tells (0164): what the validator takes, what the card
// says, and what the alert reads as.
//
// "Tell me when a COD order over ₹5,000 comes in" is a rule Luke writes
// from the owner's words, with the action { type: "alert" }: on a row
// the store brings in, a row of theirs added or changed, or a schedule.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-rule-alerts.mjs

import { parseReply } from "../src/lib/ai.ts";
import { describeAutomation } from "../src/lib/describe.ts";
import { describeAlert } from "../src/lib/alerts.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const ORDERS = "33333333-3333-4333-8333-333333333333";
const SUPPLIERS = "44444444-4444-4444-8444-444444444444";
const modules = [
  { id: ORDERS, project_id: "p", name: "orders", nav_label: "Orders", icon: "table", source_table: "orders" },
  { id: SUPPLIERS, project_id: "p", name: "suppliers", nav_label: "Suppliers", icon: "table", source_table: null },
];
const own = {
  columns: [
    { field: "name", label: "Name", type: "text" },
    { field: "qty", label: "Qty", type: "number" },
  ],
};
const rule = (on, trigger, actions) =>
  parseReply(
    JSON.stringify({
      type: "plans",
      message: "A rule.",
      plans: [
        {
          changeType: "AUTOMATION_ADD",
          targetModuleId: on,
          automation: { name: "Tell me", definition: { trigger, actions } },
          explanation: "Tells you when it happens.",
        },
      ],
    }),
    modules,
    on === ORDERS ? { columns: [] } : own,
    null
  );
const bigCod = {
  type: "store_row_added",
  when: {
    op: "and",
    args: [
      { op: ">", args: [{ field: "total" }, { const: 5000 }] },
      { op: "contains", args: [{ field: "gateway" }, { const: "Cash on Delivery" }] },
    ],
  },
};
const tell = { type: "alert", title: "Big COD order", show: ["order_number", "total"], severity: "critical" };
const errorsOf = (r) => (r.ok ? [] : r.errors).join(" ");

console.log("the validator");
const taken = rule(ORDERS, bigCod, [tell]);
check("a big COD order, told the moment the store brings it in", taken.ok);
if (!taken.ok) console.log("     →", taken.errors);
check(
  "a row of theirs added, told",
  rule(SUPPLIERS, { type: "record_created", when: { op: "<", args: [{ field: "qty" }, { const: 5 }] } }, [
    { type: "alert", title: "Running out", show: ["name", "qty"] },
  ]).ok
);
check(
  "something gone quiet, on a schedule",
  rule(
    ORDERS,
    {
      type: "schedule",
      every: "daily",
      when: { op: "=", args: [{ field: "financial_status" }, { const: "PENDING" }] },
    },
    [{ type: "alert", title: "Still not paid", show: ["order_number"] }]
  ).ok
);
check(
  "a field it cannot show is refused",
  errorsOf(rule(ORDERS, bigCod, [{ ...tell, show: ["colour"] }])).includes('"show"')
);
check(
  "at most four fields",
  errorsOf(
    rule(ORDERS, bigCod, [{ ...tell, show: ["order_number", "total", "gateway", "currency", "tags"] }])
  ).includes("up to four")
);
check("it needs a title", errorsOf(rule(ORDERS, bigCod, [{ ...tell, title: " " }])).includes('"title"'));
check(
  "attention or critical, nothing else",
  errorsOf(rule(ORDERS, bigCod, [{ ...tell, severity: "urgent" }])).includes('"severity"')
);
check(
  "a store's new row tells or runs code, not both and not a write",
  errorsOf(
    rule(ORDERS, bigCod, [tell, { type: "set_fields", target: { self: true }, set: { note: { const: "x" } } }])
  ).includes("all run_code, or all alert")
);
check(
  "a row the store brings in is only on a section over the store",
  errorsOf(rule(SUPPLIERS, { type: "store_row_added" }, [{ type: "alert", title: "New" }])).includes(
    "section over the store"
  )
);

console.log("\nthe card");
const said = describeAutomation({ name: "Tell me", definition: { trigger: bigCod, actions: [tell] } }, modules);
check("says when", said[0]?.startsWith("When the store brings in a row where"));
check(
  "and what it tells, in the bell",
  said[1] === "→ tell you in the bell: “Big COD order”, with order_number, total"
);

console.log("\nthe alert");
const one = describeAlert({
  kind: "rule",
  facts: {
    title: "Big COD order",
    rule: "Tell me",
    values: [
      { field: "order_number", value: "#1042" },
      { field: "total", value: "6200.00" },
    ],
  },
});
check("its title is theirs", one.title === "Big COD order");
check("its line says which one", one.detail === "#1042 · 6200.00");
check(
  "and Luke can be asked about it",
  one.ask === "My alert “Big COD order” went off (#1042, 6200.00). What should I do about it?"
);
check("with no facts it still reads", describeAlert({ kind: "rule", facts: {} }).title === "Your alert");

console.log(fails.length ? `\n${fails.length} FAILED` : "\na rule tells, in the owner's words");
process.exit(fails.length ? 1 : 0);
