// Changing how a section looks without designing anything (lib/view-edit.ts,
// 5 Oct): renamed, hidden, moved, filtered and sorted, as the plans Luke
// would send, which the validator takes; a filter only where the rows give
// it choices; a status's choices kept when its filter comes off the bar;
// and a store column keeps where the owner put it and a name they gave
// it, not one of ours saved long ago. Pure: no database, no model.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-view-edit.mjs

import { editView, filterChoices, filterIsOff, viewEditPlans } from "../src/lib/view-edit.ts";
import { validatePlan } from "../src/lib/ai.ts";
import { STORE_TABLES, storeSectionColumns } from "../src/lib/store-read.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const RETURNS = {
  id: "11111111-1111-4111-8111-111111111111",
  project_id: "p",
  parent_id: null,
  name: "returns",
  nav_label: "Returns",
  icon: "table",
  route: "/modules/returns",
  sort_order: 1,
  source_table: null,
  created_at: "2026-10-05",
};
const schema = {
  columns: [
    { field: "order", label: "Order", type: "text" },
    { field: "customer", label: "Customer", type: "text" },
    { field: "status", label: "Status", type: "badge" },
    { field: "reason", label: "Reason", type: "dropdown" },
    { field: "amount", label: "Amount", type: "currency" },
    { field: "fragile", label: "Fragile", type: "boolean" },
    { field: "note", label: "Note", type: "longtext", hidden: true },
  ],
  features: {
    filters: [{ field: "status", label: "Status", options: ["Requested", "Received", "Refunded"] }],
    defaultSort: { field: "amount", dir: "desc" },
  },
};
const rows = {
  order: ["#1", "#2", "#3"],
  customer: Array.from({ length: 20 }, (_, i) => `Person ${i}`),
  status: ["Requested"],
  reason: ["Size", "Damaged", "Size"],
  amount: ["100", "200"],
};
const valuesOf = (f) => rows[f] ?? [];
const valid = (plans) =>
  plans.every((p) => validatePlan(structuredClone(p), [RETURNS], { columns: schema.columns }, schema.features).ok);

console.log("columns");
{
  const { plans, said } = viewEditPlans(
    RETURNS.id,
    schema,
    {
      columns: [
        { field: "customer", label: "Buyer" },
        { field: "order" },
        { field: "amount", hidden: true },
        { field: "note", hidden: false },
      ],
    },
    valuesOf
  );
  const cols = plans[0]?.newSchema?.columns ?? [];
  check("one UI_CHANGE, nothing else", plans.length === 1 && plans[0].changeType === "UI_CHANGE");
  check(
    "named in the order given",
    cols.map((c) => c.field).join() === "customer,order,amount,note,status,reason,fragile"
  );
  check("a column left out keeps its place after them", cols.at(-1).field === "fragile");
  check("renamed", cols[0].label === "Buyer");
  check("hidden, and still a column", cols.find((c) => c.field === "amount").hidden === true);
  check("put back on the table", !("hidden" in cols.find((c) => c.field === "note")));
  check("its type and the rest of it untouched", cols.find((c) => c.field === "status").type === "badge");
  check(
    "said in plain words",
    said.includes('renamed "Customer" to "Buyer"') && said.some((s) => s.startsWith("put the columns in the order"))
  );
  check("the validator takes it", valid(plans));
}

console.log("\nwhat cannot be done is said, and nothing is planned");
{
  const r = viewEditPlans(RETURNS.id, schema, { columns: [{ field: "nope" }] }, valuesOf);
  check("a column that is not there", r.plans.length === 0 && r.errors[0].includes('no column "nope"'));
  const all = schema.columns.map((c) => ({ field: c.field, hidden: true }));
  check(
    "every column off the table",
    viewEditPlans(RETURNS.id, schema, { columns: all }, valuesOf).errors.join().includes("At least one column")
  );
  check(
    "nothing changed: no plan",
    viewEditPlans(RETURNS.id, schema, { columns: [{ field: "order" }] }, valuesOf).plans.length === 0
  );
}

console.log("\nfilters, from what the rows hold");
{
  const col = (f) => schema.columns.find((c) => c.field === f);
  check("a tick is Yes / No by itself", filterChoices(col("fragile"), undefined, []).options?.join() === "Yes,No");
  check(
    "a choice column: what its rows hold",
    filterChoices(col("reason"), undefined, rows.reason).options?.join() === "Size,Damaged"
  );
  check("money is no filter", "why" in filterChoices(col("amount"), undefined, rows.amount));
  check("one value is no filter", "why" in filterChoices(col("status"), undefined, ["Requested"]));
  check(
    "a status keeps its own choices, and adds the rows'",
    filterChoices(col("status"), ["Requested", "Received"], ["Lost"]).options?.join() === "Requested,Received,Lost"
  );
  check("a word on every row is no filter", "why" in filterChoices(col("customer"), undefined, rows.customer));
  check("nor at three rows: an order number each", "why" in filterChoices(col("order"), undefined, ["#1", "#2", "#3"]));
  check(
    "a word that comes round again is",
    filterChoices(col("order"), undefined, ["Mumbai", "Pune", "Mumbai", "Pune", "Delhi", "Mumbai"]).options?.length ===
      3
  );
  check("one already a filter keeps its place", "options" in filterChoices(col("order"), ["A", "B"], ["#1"]));

  const { plans, said } = viewEditPlans(RETURNS.id, schema, { filters: ["reason", "fragile"] }, valuesOf);
  const fs = plans[0]?.features?.filters ?? [];
  check(
    "one FEATURE_UPDATE, naming only the filters",
    plans.length === 1 && Object.keys(plans[0].features).join() === "filters"
  );
  check("added in the order given", fs[0].field === "reason" && fs[1].field === "fragile");
  check("labelled as the column is", fs[0].label === "Reason");
  const status = fs.find((f) => f.field === "status");
  check(
    "a status's filter taken off the bar keeps its choices for the row form",
    filterIsOff(status) && status.options.length === 3
  );
  check("said", said.includes('added a filter by "Reason"') && said.includes('took the "Status" filter off'));
  check("the validator takes it", valid(plans));
  const back = editView({ ...schema, features: { filters: fs } }, { filters: ["status"] }, valuesOf).filters;
  const onBar = back.filter((f) => !filterIsOff(f));
  check(
    "put back on the bar, with its choices",
    onBar.length === 1 && onBar[0].field === "status" && onBar[0].options.length === 3
  );
  check(
    "and the reason's kept, off the bar; a tick's needs none",
    back.length === 2 && filterIsOff(back[1]) && back[1].field === "reason"
  );
  check(
    "a filter that cannot be is refused, with why",
    viewEditPlans(RETURNS.id, schema, { filters: ["order"] }, (f) => (f === "order" ? ["#1"] : []))
      .errors.join()
      .includes("two different values")
  );
  const renamed = editView(schema, { columns: [{ field: "status", label: "Stage" }] }, valuesOf).filters;
  check("renaming a column renames the filter that said its name", renamed[0].label === "Stage");
}

console.log("\nthe order rows open in");
{
  const { plans, said } = viewEditPlans(RETURNS.id, schema, { sort: { field: "customer", dir: "asc" } }, valuesOf);
  check(
    "a FEATURE_UPDATE of the sort alone",
    plans.length === 1 && JSON.stringify(plans[0].features) === '{"defaultSort":{"field":"customer","dir":"asc"}}'
  );
  check("said", said[0] === 'rows open in order of "Customer", lowest or earliest first');
  check("the validator takes it", valid(plans));
  const none = viewEditPlans(RETURNS.id, schema, { sort: null }, valuesOf).plans[0];
  check("none: the order they came in", none.features.defaultSort === null);
  check(
    "a column that is not there",
    viewEditPlans(RETURNS.id, schema, { sort: { field: "x", dir: "asc" } }, valuesOf).errors.length === 1
  );
}

console.log("\na store section keeps what the owner made of it");
{
  const ours = STORE_TABLES.orders.columns;
  const [a, b] = [ours[0], ours[1]];
  // As Customize saves it: every column, in the owner's order.
  const saved = [
    { ...b },
    { ...a, label: "Dispatch no.", named: true, hidden: true },
    ...ours.slice(2),
    { field: "packed", label: "Packed", type: "boolean" },
  ];
  const cols = storeSectionColumns("orders", saved);
  check("in the order saved", cols.map((c) => c.field).join() === saved.map((c) => c.field).join());
  check("a name they gave", cols[1].label === "Dispatch no." && cols[1].hidden === true);
  check("their own field where they put it", cols.at(-1).field === "packed");
  const onlyTheirs = storeSectionColumns("orders", [{ field: "packed", label: "Packed", type: "boolean" }]);
  check(
    "a design naming only their field: the store's columns first, theirs after",
    onlyTheirs.map((c) => c.field).join() === [...ours.map((c) => c.field), "packed"].join()
  );
  const gained = storeSectionColumns(
    "orders",
    saved.filter((c) => c.field !== ours[3].field)
  );
  check(
    "a column the store gained since lands after the one before it",
    gained.findIndex((c) => c.field === ours[3].field) === gained.findIndex((c) => c.field === ours[2].field) + 1
  );
  check(
    "a saved label that is ours from long ago is not kept",
    storeSectionColumns("orders", [{ ...a, label: "Old name" }])[0].label === a.label
  );
  check(
    "the type is always ours",
    storeSectionColumns("orders", [{ ...a, type: "longtext", label: "x", named: true }])[0].type === a.type
  );
  check(
    "nothing saved: ours, in our order",
    storeSectionColumns("orders", [])
      .map((c) => c.field)
      .join() === ours.map((c) => c.field).join()
  );
}

console.log(fails.length === 0 ? "\na section's look changes without a design" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
