// Choosing a linked row fills the form from it, and narrows the next link
// to it (lib/links.ts, 5 Oct): an order chosen on a return fills its
// customer and phone, never what the owner typed, and the return's item is
// then one of that order's items. Worked out from the sections, never
// configured. Pure: no database, no model.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-link-fill.mjs

import { fillFromLinked, narrowFor } from "../src/lib/links.ts";
import { STORE_TABLES, storeParents } from "../src/lib/store-read.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const order = { field: "order", label: "Order", type: "link", linkTo: "m-orders" };
const columns = [
  order,
  { field: "customer_name", label: "Customer", type: "text" },
  { field: "phone", label: "Customer phone", type: "phone" },
  { field: "amount", label: "Total", type: "currency" },
  { field: "placed", label: "Placed", type: "date" },
  { field: "status", label: "Status", type: "badge" },
  { field: "reason", label: "Reason", type: "dropdown" },
  { field: "gateway", label: "Payment", type: "badge" },
  { field: "fragile", label: "Fragile", type: "boolean" },
  { field: "days", label: "Days", type: "number", compute: { op: "days_since", args: [{ field: "placed" }] } },
];
// The store's order columns, by key and label, as the linked section has them.
const source = STORE_TABLES.orders.columns;
const row = {
  id: "o-1042",
  data: {
    order_number: "#1042",
    customer_name: "Aarav Sharma",
    customer_phone: "+91 98100 00000",
    total: "1,569.00",
    placed_at: "2026-10-04T09:15:00Z",
    status: "Paid",
    gateway: "Cash on Delivery (COD)",
    fragile: "yes",
  },
};
const blank = Object.fromEntries(columns.map((c) => [c.field, ""]));
const options = (f) =>
  f === "gateway" ? ["Cash on Delivery (COD)", "Prepaid"] : f === "reason" ? ["Size", "Damaged"] : null;

console.log("what choosing a row fills");
{
  const { draft, filled } = fillFromLinked(columns, blank, order, row, source, {}, options);
  check("a field of the same key", draft.customer_name === "Aarav Sharma");
  check("a field of the same label (Customer phone)", draft.phone === "+91 98100 00000");
  check("a field of the same label, by its label (Total)", draft.amount === 1569);
  check("a date, as a date", draft.placed === "2026-10-04");
  check("a choice the field has", draft.gateway === "Cash on Delivery (COD)");
  check("never the link itself", draft.order === "");
  check("never a field a row keeps about itself (status)", draft.status === "");
  check("never a computed one", !("days" in filled));
  check("never a value that does not fit its type (a word for yes/no)", draft.fragile === "");
  check(
    "and it says what it filled",
    Object.keys(filled).sort().join() === "amount,customer_name,gateway,phone,placed"
  );
}

console.log("\nwhat the owner typed stays theirs");
{
  const typed = { ...blank, customer_name: "Walk-in" };
  const { draft } = fillFromLinked(columns, typed, order, row, source, {}, options);
  check("a value they typed is not written over", draft.customer_name === "Walk-in");
  check("the rest still fills", draft.phone === "+91 98100 00000");
}

console.log("\nchoosing again");
{
  const first = fillFromLinked(columns, blank, order, row, source, {}, options);
  const edited = { ...first.draft, phone: "+91 90000 11111" };
  const other = { id: "o-1043", data: { customer_name: "Priya Nair", total: 900 } };
  const second = fillFromLinked(columns, edited, order, other, source, first.filled, options);
  check("what the last pick filled is filled again", second.draft.customer_name === "Priya Nair");
  check("what the owner changed since is kept", second.draft.phone === "+91 90000 11111");
  check("what the last pick filled and this one has nothing for is cleared", second.draft.placed === "");
  check("the new row's own value fills in", second.draft.amount === 900);
}

console.log("\nthe store's lists know their parents");
check("an order's items, by order_id", JSON.stringify(storeParents("order_line_items")) === '{"order_id":"orders"}');
check("a product's variants, by product_id", storeParents("variants").product_id === "products");
check("orders have none", Object.keys(storeParents("orders")).length === 0);

console.log("\nthe next link is narrowed by the one chosen");
{
  const item = { field: "item", label: "Item", type: "link", linkTo: "m-items" };
  const form = [order, item];
  const targets = {
    "m-orders": { table: "orders", parents: storeParents("orders"), columns: STORE_TABLES.orders.columns },
    "m-items": {
      table: "order_line_items",
      parents: storeParents("order_line_items"),
      columns: STORE_TABLES.order_line_items.columns,
    },
    "m-customers": { table: null, parents: {}, columns: [{ field: "name", label: "Name", type: "text" }] },
    "m-visits": {
      table: null,
      parents: {},
      columns: [{ field: "who", label: "Customer", type: "link", linkTo: "m-customers" }],
    },
  };
  const targetOf = (id) => targets[id] ?? null;
  check("nothing chosen: every row", narrowFor(item, form, { order: "", item: "" }, targetOf) === null);
  const n = narrowFor(item, form, { order: "o-1042", item: "" }, targetOf);
  check("an order chosen: its items", n?.field === "order_id" && n?.value === "o-1042");
  check("the chosen link is not narrowed by itself", narrowFor(order, form, { order: "o-1042" }, targetOf) === null);
  const customer = { field: "customer", label: "Customer", type: "link", linkTo: "m-customers" };
  const visit = { field: "visit", label: "Visit", type: "link", linkTo: "m-visits" };
  const own = narrowFor(visit, [customer, visit], { customer: "c-7", visit: "" }, targetOf);
  check("a section of theirs, by its link to the chosen one", own?.field === "who" && own?.value === "c-7");
  check("a link to a section nobody knows: nothing", narrowFor(item, form, { order: "o-1" }, () => null) === null);
}

console.log(fails.length === 0 ? "\na chosen row fills the form and narrows the next" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
