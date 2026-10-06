// What an account is shown of the store's lists (0192), narrowed in one
// place: the columns every caller names, a section's own columns kept,
// what reads a column left out set aside, and the rows Luke and their AI
// read cut to it, while the app's rows stay whole. Pure: the choice is put
// in force here as the app and a request would.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-columns.mjs

import {
  narrowRow,
  readShownFrom,
  readStoreRows,
  searchFieldsOf,
  storeSectionColumns,
  storeTableSchema,
  withoutHidden,
  STORE_TABLES,
} from "../src/lib/store-read.ts";
import { narrowResult, narrowedLists, withStoreShown } from "../src/lib/store-columns.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const fields = (cols) => cols.map((c) => c.field);
const all = fields(STORE_TABLES.orders.columns);
const shown = { orders: ["order_number", "placed_at", "total", "status"] };

console.log("every column, when nothing is narrowed");
check("a list as it is", fields(storeTableSchema("orders").columns).join() === all.join());
check("the customers' search as it is", searchFieldsOf("customers").includes("phone"));

console.log("\nLuke and their AI, in a request's scope");
await withStoreShown(shown, async () => {
  check("the same columns named", fields(storeTableSchema("orders").columns).length === 4);
  check(
    "a row they read is cut",
    JSON.stringify(narrowRow("orders", { id: "o1", order_number: "#1", customer_phone: "98" })) ===
      '{"id":"o1","order_number":"#1"}'
  );
  const order = narrowResult("orders", {
    order_number: "#1",
    customer_name: "Asha",
    lines: [{ title: "Shirt", customer_name: "Asha" }],
  });
  check("a lookup's answer is cut throughout", !JSON.stringify(order).includes("Asha"));
  check("and its lines kept", order.lines[0].title === "Shirt");
  check("said in words", narrowedLists()[0] === `orders (${all.length - 4} of its columns not shown)`);
  // A read across an await keeps it: the stand-in client answers after a beat.
  const db = {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        then: (ok) =>
          new Promise((r) => setTimeout(r, 5)).then(() =>
            ok({ data: [{ id: "o1", order_number: "#1", customer_phone: "98" }], count: 1, error: null })
          ),
      };
      return q;
    },
  };
  const { rows } = await readStoreRows(db, "s1", "orders", 10);
  check(
    "rows read inside it come back cut",
    rows[0].data.customer_phone === undefined && rows[0].data.order_number === "#1"
  );
});
check("and outside it, nothing is narrowed", fields(storeTableSchema("orders").columns).length === all.length);

console.log("\nthe app's choice in force");
const inApp = { shown, strip: false };
readShownFrom(() => inApp);
check(
  "only what is shown",
  fields(storeTableSchema("orders").columns).join() === "order_number,placed_at,total,status"
);
check("another list whole", fields(storeTableSchema("customers").columns).includes("phone"));
const section = storeSectionColumns("orders", [
  { field: "customer_phone", label: "Phone", type: "text" },
  { field: "packed", label: "Packed", type: "boolean" },
  { field: "late", label: "Late", type: "boolean", compute: { op: "not", args: [{ field: "status" }] } },
]);
check(
  "a section keeps their own fields and what it works out",
  ["packed", "late"].every((f) => fields(section).includes(f))
);
check("and drops the store's they are not shown", !fields(section).includes("customer_phone"));
check(
  "the app's rows stay whole",
  narrowRow("orders", { order_number: "#1", customer_phone: "98" }).customer_phone === "98"
);
check("not searched by what is not shown", !searchFieldsOf("orders").includes("customer_phone"));

console.log("\nwhat reads a column not shown is set aside");
const hidden = new Set(all.filter((f) => !shown.orders.includes(f)));
const f = withoutHidden(
  {
    filters: [
      { field: "status", label: "Status", options: [] },
      { field: "gateway", label: "Paid by", options: [] },
    ],
    defaultSort: { field: "customer_name", dir: "asc" },
    period: { field: "placed_at", label: "Placed" },
    stats: [
      { label: "Revenue", op: "sum", value: { field: "total" } },
      { label: "COD", op: "count", where: { op: "=", args: [{ field: "gateway" }, { const: "COD" }] } },
      { label: "By city", op: "count", by: "ship_city" },
    ],
    search: { enabled: true, fields: ["order_number", "customer_name"] },
  },
  hidden
);
check("a filter over it", f.filters.map((x) => x.field).join() === "status");
check("a sort by it", f.defaultSort === undefined);
check("the dates stay when shown", f.period?.field === "placed_at");
check("a stat reading it, or split by it", f.stats.map((s) => s.label).join() === "Revenue");
check("a search field", f.search.fields.join() === "order_number");
check("nothing narrowed, nothing changed", withoutHidden({ filters: [] }, null).filters.length === 0);

console.log(fails.length ? `\n${fails.length} FAILED` : "\nan account sees the columns it is shown, everywhere");
process.exit(fails.length ? 1 : 0);
