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
  SHAPES,
  keepHidden,
  keepHiddenColumns,
  readsHidden,
  STORE_METRICS,
  STORE_METRIC_READS,
  STORE_TABLES,
} from "../src/lib/store-read.ts";
import { narrowResult, narrowedLists, withStoreShown } from "../src/lib/store-columns.ts";
import { storeTool } from "../src/lib/store-tools.ts";
import { mergeFeatures } from "../src/lib/types.ts";
import { asksFromStore } from "../src/lib/suggest.ts";

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
  check(
    "said in words, each column by its name in the app",
    narrowedLists()[0]?.startsWith("orders (not shown: Customer, Phone, ") &&
      !narrowedLists()[0].includes("customer_phone")
  );
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

// What a search asks the database for, read off a stand-in client.
const asked = async (table, q) => {
  let clause = "";
  const db = {
    from: () => {
      const b = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: () => b,
        or: (c) => ((clause = c), b),
        then: (ok) => Promise.resolve(ok({ data: [], count: 0, error: null })),
      };
      return b;
    },
  };
  await readStoreRows(db, "s1", table, 10, q);
  return clause;
};
await withStoreShown({ customers: ["name", "email"] }, async () => {
  check(
    "a phone typed finds no customer by a phone not shown",
    !(await asked("customers", "98765 43210")).includes("phone")
  );
  check("and still finds an order by one shown", (await asked("orders", "98765 43210")).includes("phone_digits"));
  // Each tool says which list its rows are of; search_store, the one it was asked for.
  // A total never counts by what the account is not shown, and is never asked of the database.
  const metrics = storeTool("store_metrics");
  let reached = 0;
  const ctx = {
    db: { rpc: async () => ((reached += 1), { data: { value: 1 }, error: null }) },
    store: { id: "s1", timezone: "Asia/Kolkata" },
  };
  await withStoreShown({ orders: ["order_number", "total", "status"] }, async () => {
    const byCity = await metrics.run({ measure: "orders", by: "city" }, ctx);
    const byPay = await metrics.run({ measure: "revenue", filters: { gateway: "COD" } }, ctx);
    const inWindow = await metrics.run({ measure: "orders", from: "2026-09-01" }, ctx);
    check(
      "a total by a column not shown is refused, and says so",
      /ship_city/.test(byCity.error) && /gateway/.test(byPay.error) && /placed_at/.test(inWindow.error) && reached === 0
    );
    await metrics.run({ measure: "revenue", by: "status" }, ctx);
    check("a total by what is shown is counted", reached === 1);
  });
  const known = new Set([
    ...Object.keys(STORE_METRICS.measures),
    ...Object.keys(STORE_METRICS.dimensions),
    ...STORE_METRICS.filters,
    "window",
  ]);
  check(
    "what each total reads is a measure, a dimension or a filter, of a column orders has",
    Object.entries(STORE_METRIC_READS).every(
      ([k, f]) => known.has(k) && STORE_TABLES.orders.columns.some((c) => c.field === f)
    )
  );
  const tool = storeTool("search_store");
  check(
    "a lookup is cut by the list it read",
    tool.shape({ table: "customers" })?.nested?.rows?.list === "customers" && tool.shape({ table: "nope" }) === null
  );
});

console.log("\nan answer shaped by hand, cut by where each part comes from");
await withStoreShown(
  {
    orders: ["order_number", "total", "customer_name"],
    customers: ["name", "email"],
  },
  async () => {
    // As searchOrders and orderDetail shape an order: the customer is a customer's row.
    const hit = narrowResult(SHAPES.order, {
      order_number: "#1006",
      placed_at: "2026-09-28",
      total: 1424,
      financial_status: "PENDING",
      customer: { name: "Kabir Singh", phone: "+919810000005", email: "k@example.com" },
      items: [{ title: "Shirt", sku: "S-1", quantity: 1, price: 1424 }],
    });
    check(
      "the customer's phone, by the customers list",
      hit.customer.phone === undefined && hit.customer.name === "Kabir Singh"
    );
    check("how it stands, as the orders' status", hit.financial_status === undefined && hit.total === 1424);
    check("when it was placed", hit.placed_at === undefined);
    check("its lines, by their own list, whole", hit.items[0].sku === "S-1");
    // As the turn's snapshot names an order: number, placed.
    const recent = narrowResult(SHAPES.order, [{ number: "#1006", placed: "2026-09-28", total: 1424, status: "PAID" }]);
    check(
      "a snapshot's order, by the columns its keys are",
      JSON.stringify(recent) === '[{"number":"#1006","total":1424}]'
    );
    const leaders = narrowResult(SHAPES.leaders, {
      top_customers: [{ name: "Asha", orders: 3, spent: 900 }],
      best_sellers: [{ title: "Shirt", units: 4, revenue: 100 }],
    });
    check(
      "the top customers' counts, as the columns they are",
      JSON.stringify(leaders.top_customers) === '[{"name":"Asha"}]' && leaders.best_sellers[0].units === 4
    );
    const wrapped = narrowResult(storeTool("search_orders").shape({}), {
      count: 1,
      total: 9,
      orders: [{ total: 5, financial_status: "PAID" }],
    });
    check(
      "a wrapper's own count is no column",
      wrapped.total === 9 && wrapped.orders[0].financial_status === undefined
    );
  }
);

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

console.log("\nhidden, edited round, shown again: nothing lost");
{
  const H = new Set(["gateway", "customer_phone"]);
  const cod = { op: "=", args: [{ field: "gateway" }, { const: "COD" }] };
  const saved = {
    filters: [
      { field: "status", label: "Status", options: [] },
      { field: "gateway", label: "Paid by", options: [] },
    ],
    stats: [
      { label: "Gross", op: "sum", value: { field: "total" } },
      { label: "COD", op: "count", where: cod },
    ],
    defaultSort: { field: "gateway", dir: "asc" },
    actions: [
      { label: "Packed", set: { packed: { const: true } } },
      { label: "Confirm COD", set: { called: { const: true } }, when: cod },
    ],
    view: { type: "board", groupBy: "gateway" },
    tabs: [{ label: "By city", view: { type: "board", groupBy: "ship_city" } }],
    scanMode: { lookupField: "order_number", action: { set: { packed: { const: true } } } },
  };
  check(
    "what reads a hidden column is found: a field, a groupBy, a written screen's code",
    readsHidden(saved.stats[1], H) &&
      readsHidden(saved.view, H) &&
      readsHidden(
        { type: "custom", title: "COD", html: "<script>rows.filter((r) => r.gateway === 'COD')</script>" },
        H
      ) &&
      !readsHidden(saved.stats[0], H)
  );
  // The walk's catch (6 Oct): Gross, formatted as currency, vanished when the Currency column was hidden.
  check(
    "a word that only matches a column's name is not that column",
    !readsHidden({ label: "Gross", op: "sum", value: { field: "total" }, format: "currency" }, new Set(["currency"])) &&
      !readsHidden({ field: "status", label: "Status", options: ["gateway"] }, H)
  );
  const screen = withoutHidden(saved, H);
  check(
    "on screen: no filter, card, sort or board over it; the buttons and the scan keep working",
    screen.filters.length === 1 &&
      screen.stats.length === 1 &&
      screen.defaultSort === undefined &&
      screen.view.type === "table" &&
      screen.actions.length === 2 &&
      !!screen.scanMode
  );
  const brief = withoutHidden(saved, H, true);
  check("in Luke's brief, not a button that reads it either", brief.actions.length === 1);

  // The owner removes the only filter they see; Luke adds a card and a button, sending what he sees.
  const customize = keepHidden(saved, { filters: null, defaultSort: null }, H);
  const luke = keepHidden(
    saved,
    {
      stats: [...screen.stats, { label: "Orders", op: "count" }],
      actions: brief.actions.concat({ label: "Called", set: { called: { const: true } } }),
    },
    H
  );
  const after = mergeFeatures(mergeFeatures(saved, customize), luke);
  check(
    "the filter they could not see stays; the one they took off goes",
    JSON.stringify(after.filters.map((f) => f.field)) === '["gateway"]'
  );
  check(
    "the card they could not see stays beside the new one",
    after.stats.map((x) => x.label).join() === "Gross,Orders,COD"
  );
  check(
    "the button they could not see stays",
    after.actions.map((x) => x.label).join() === "Packed,Called,Confirm COD"
  );
  check(
    "the sort, the board and the scan, as saved",
    after.defaultSort.field === "gateway" && after.view.groupBy === "gateway" && !!after.scanMode
  );
  check("shown again, all of it is there", JSON.stringify(withoutHidden(after, null)) === JSON.stringify(after));

  const cols = [
    { field: "order_number", label: "Order", type: "text" },
    { field: "customer_phone", label: "Mobile", type: "text", named: true },
    { field: "is_cod", label: "COD?", type: "boolean", compute: cod },
    { field: "total", label: "Total", type: "currency" },
  ];
  const next = keepHiddenColumns(cols, [{ ...cols[0], label: "Order no" }, cols[3]], H);
  check(
    "columns saved while hidden: theirs renamed, the hidden ones back in their place, with their names",
    next.map((c) => `${c.field}:${c.label}`).join() ===
      "order_number:Order no,customer_phone:Mobile,is_cod:COD?,total:Total"
  );
}

console.log("\nwhat the store offers to build, and its alerts, follow it");
await withStoreShown({ orders: ["order_number", "placed_at", "total", "status"] }, async () => {
  const counted = {
    orders30: 20,
    cod30: 10,
    failedDeliveries: 0,
    refunds60: 0,
    lowStock: 3,
    repeatCustomers: 0,
    lateUnshipped: 0,
    abandoned30: 0,
  };
  const asks = asksFromStore(counted, []);
  check(
    "no offer from a column not shown (how it was paid)",
    !asks.some((a) => /COD/i.test(a.label)) && asks.some((a) => /5 or fewer/.test(a.label))
  );
});

console.log(fails.length ? `\n${fails.length} FAILED` : "\nan account sees the columns it is shown, everywhere");
process.exit(fails.length ? 1 : 0);
