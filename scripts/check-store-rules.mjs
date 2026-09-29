// A rule on a section over the store: what it may read, what it may
// write, and when it may run.
//
// The store's row is laid under the merchant's fields when a rule is
// judged (0130), so a rule reads both; it writes only theirs, and it
// runs on a change to theirs or on a schedule over the list — never on
// a row being added, since none is. Pure: the validator alone.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-rules.mjs

import { parseReply } from "../src/lib/ai.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const PACKING = "b1f4a7d2-0000-4000-8000-0000000000aa";
const modules = [
  {
    id: PACKING,
    project_id: "p",
    parent_id: null,
    name: "packing",
    nav_label: "Packing",
    icon: "package",
    route: "/packing",
    sort_order: 1,
    source_table: "orders",
    created_at: "2026-01-01",
  },
];
// Their fields beside each order; the store's (order_number, gateway,
// financial_status, …) come from the registry, not from here.
const packingSchema = {
  columns: [
    { field: "packed", label: "Packed", type: "checkbox" },
    { field: "packed_on", label: "Packed on", type: "date" },
    { field: "flag", label: "Flag", type: "text" },
  ],
};
const schemas = (id) => (id === PACKING ? packingSchema : null);
const rule = (name, definition) => ({
  changeType: "AUTOMATION_ADD",
  targetModuleId: PACKING,
  automation: { name, definition },
  explanation: `A rule: ${name}.`,
});
const run = (plans) => parseReply(JSON.stringify({ plans }), modules, null, null, schemas);
const said = (got) => (got.errors ?? []).join(" | ");

console.log("what a rule on a store section may read");
const paidAndPacked = run([
  rule("stamp paid and packed", {
    trigger: {
      type: "record_updated",
      when: {
        op: "and",
        args: [
          { op: "=", args: [{ field: "financial_status" }, { const: "PAID" }] },
          { op: "=", args: [{ field: "packed" }, { const: true }] },
        ],
      },
    },
    actions: [{ type: "set_fields", target: { self: true }, set: { flag: { const: "ready" } } }],
  }),
]);
check("the store's field beside its own, on a change", paidAndPacked.ok);
if (!paidAndPacked.ok) console.log("     →", said(paidAndPacked));

const daily = run([
  rule("late COD", {
    trigger: {
      type: "schedule",
      every: "daily",
      when: {
        op: "and",
        args: [
          { op: "=", args: [{ field: "gateway" }, { const: "Cash on Delivery (COD)" }] },
          { op: "=", args: [{ field: "financial_status" }, { const: "PENDING" }] },
        ],
      },
    },
    actions: [{ type: "set_fields", target: { self: true }, set: { flag: { const: "late" } } }],
  }),
]);
check("and on a schedule over every row of the list", daily.ok);
if (!daily.ok) console.log("     →", said(daily));

const batch = run([
  {
    changeType: "NEW_MODULE",
    targetModuleId: null,
    newModule: { name: "cod-hisaab", nav_label: "COD Hisaab", icon: "wallet", source_table: "orders" },
    newSchema: { columns: [{ field: "received", label: "Received", type: "number" }] },
    features: {},
    explanation: "COD money, per order.",
  },
  {
    changeType: "AUTOMATION_ADD",
    targetModuleId: "#cod-hisaab",
    automation: {
      name: "short",
      definition: {
        trigger: {
          type: "record_updated",
          when: {
            op: "and",
            args: [
              { op: "<", args: [{ field: "received" }, { field: "total" }] },
              { op: "=", args: [{ field: "cancelled_at" }, { const: null }] },
            ],
          },
        },
        actions: [{ type: "set_fields", target: { self: true }, set: { received: { field: "received" } } }],
      },
    },
    explanation: "Reads the store's total beside what was received.",
  },
]);
check("a new section over the store, its rule reading the store's total and cancelled_at in the same batch", batch.ok);
if (!batch.ok) console.log("     →", said(batch));

console.log("\nwhat it may not");
const writesStore = run([
  rule("mark paid", {
    trigger: { type: "record_updated", when: { op: "=", args: [{ field: "packed" }, { const: true }] } },
    actions: [{ type: "set_fields", target: { self: true }, set: { financial_status: { const: "PAID" } } }],
  }),
]);
check(
  "writing the store's field is refused, and says the import would put it back",
  !writesStore.ok && /import would put it back/.test(said(writesStore))
);
const onAdded = run([
  rule("on new", {
    trigger: { type: "record_created" },
    actions: [{ type: "set_fields", target: { self: true }, set: { flag: { const: "new" } } }],
  }),
]);
check("a rule on a row being added is refused: none is", !onAdded.ok && /never sees a row added/.test(said(onAdded)));
const noSuch = run([
  rule("typo", {
    trigger: { type: "record_updated", when: { op: "=", args: [{ field: "financial_stauts" }, { const: "PAID" }] } },
    actions: [{ type: "set_fields", target: { self: true }, set: { flag: { const: "x" } } }],
  }),
]);
check(
  "a field that is neither theirs nor the store's is still a typo",
  !noSuch.ok && /doesn't exist in this section/.test(said(noSuch))
);

// A section over orders made in the same design: its filters and counts
// read the store's own fields as its rules do. Refused, they cost a whole
// Opus attempt on a filter by payment status (the packing eval, 2026-09-29).
console.log("\nwhat a new section over the store may filter and count on");
const overOrders = (features) =>
  parseReply(
    JSON.stringify({
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "packed-orders", nav_label: "Packed orders", icon: "package", source_table: "orders" },
          newSchema: { columns: [{ field: "packed", label: "Packed", type: "boolean" }] },
          features,
          explanation: "The store's orders, with a tick of theirs beside each.",
        },
      ],
    }),
    [],
    null,
    null,
    () => null
  );
const readsStore = overOrders({
  filters: [{ field: "financial_status", label: "Payment", options: ["PAID", "PENDING"] }],
  stats: [
    {
      op: "count",
      label: "Cancelled",
      where: { op: "not", args: [{ op: "is_empty", args: [{ field: "cancelled_at" }] }] },
    },
  ],
});
check("a filter by payment status and a count of cancelled orders are taken", readsStore.ok);
if (!readsStore.ok) console.log("     →", said(readsStore));
const buttonWritesStore = overOrders({
  actions: [{ label: "Mark paid", set: { financial_status: { const: "PAID" } } }],
});
check("and a button still may not write one", !buttonWritesStore.ok && /the store's/.test(said(buttonWritesStore)));

console.log(
  fails.length === 0 ? "\na rule over the store reads both and writes only theirs" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
