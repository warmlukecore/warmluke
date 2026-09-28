// A hand-kept copy of a store list may stand; rows made up for it may not.
//
// A connected assistant, asked for "a SKU section for my orders", built
// a section beside the order items and seeded it with four invented
// rows. storeOverlap only warns — a hand list next to the Shopify one
// is the merchant's call — so the rows went in and sat next to the
// real orders looking like data. This is the gate that stops the rows
// and leaves the choice: the section without rows passes, the section
// over the store's own list passes, the section with invented rows
// does not.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-seeded-copies.mjs

import { retypedCopies, reuseQuestion, sectionTwin, seededCopies, storeOverlap } from "../src/lib/describe.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const store = {
  shop_domain: "shop.myshopify.com",
  currency: "INR",
  counts: { orders: 40, order_line_items: 90, refunds: 2, variants: 12 },
};
const section = (nav_label, extra = {}, columns = [{ field: "sku", label: "SKU", type: "text" }]) => ({
  changeType: "NEW_MODULE",
  targetModuleId: null,
  newModule: {
    name: nav_label.toLowerCase().replace(/\s+/g, "-"),
    nav_label,
    icon: "table",
    source_table: null,
    ...extra,
  },
  newSchema: { columns },
  explanation: "x",
});
const rows = [{ sku: "BA141-BLK" }, { sku: "CASE-M" }];

console.log("what is refused");
{
  const [why] = seededCopies([{ ...section("Order SKU Log"), newRecords: rows }], store);
  check("a copy of a store list seeded with made-up rows", !!why && /rows you made up/.test(why));
  check("says which list it copies and what to do instead", /order/i.test(why) && /source_table/.test(why));

  const seededLater = seededCopies(
    [section("Order SKU Log"), { changeType: "RECORD_SEED", targetModuleId: "#order-sku-log", newRecords: rows }],
    store
  );
  check("the same rows seeded by a later plan in the batch", seededLater.length === 1);
  const refundCols = [
    { field: "order_number", label: "Order", type: "text" },
    { field: "amount", label: "Amount", type: "currency" },
  ];
  check(
    "a copy of the refunds, seeded",
    seededCopies(
      [{ ...section("Refund tracker", {}, refundCols), newRecords: [{ order_number: "#1001", amount: 400 }] }],
      store
    ).length === 1
  );
  // Named like a store list, holding nothing of it: the owner's own data.
  const card = [
    { field: "upto_g", label: "Up to (g)", type: "number" },
    { field: "charge", label: "Charge", type: "currency" },
  ];
  check(
    "but a rate card that only shares a word with the shipments is theirs to fill",
    seededCopies([{ ...section("Courier Rates", {}, card), newRecords: [{ upto_g: 500, charge: 40 }] }], {
      ...store,
      counts: { ...store.counts, fulfillments: 6 },
    }).length === 0
  );
  check(
    "a copy of the variants, seeded",
    seededCopies([{ ...section("Barcode list"), newRecords: rows }], store).length === 1
  );
}

console.log("\nwhat still passes");
{
  check(
    "the same section with no rows — the merchant's hand list",
    seededCopies([section("Order SKU Log")], store).length === 0
  );
  check("but it is still warned about", storeOverlap(section("Order SKU Log"), store).length === 1);
  check(
    "the section over the store's list, rows or not",
    seededCopies([{ ...section("Order items", { source_table: "order_line_items" }) }], store).length === 0
  );
  check(
    "a section about something the store does not hold, seeded",
    seededCopies([{ ...section("Suppliers"), newRecords: rows }], store).length === 0
  );
  check(
    "a copy of a list the store has none of yet",
    seededCopies([{ ...section("Refund log"), newRecords: rows }], { ...store, counts: { orders: 40 } }).length === 0
  );
  check("no store at all", seededCopies([{ ...section("Order SKU Log"), newRecords: rows }], null).length === 0);
}

// A list of its own that types in what a store list already holds: its
// key and more. Sent back once, with the list to build over and fields
// of theirs beside it; a design that comes back unchanged is theirs.
console.log("\na second list of what the store already has");
{
  const own = (nav_label, columns) => ({ ...section(nav_label), newSchema: { columns } });
  const text = (field) => ({ field, label: field, type: "text" });
  const [why] = retypedCopies([own("Packing", [text("order_number"), text("customer_name"), text("packed")])], store);
  check("is sent back naming the list to build over", !!why && /orders/.test(why) && /source_table/.test(why));
  check("and says when a list of its own is still right", !!why && /does not have/.test(why));
  check(
    "three of a list's columns without its key are a copy too",
    retypedCopies([own("Deliveries", [text("customer_name"), text("customer_phone"), text("ship_city")])], store)
      .length === 1
  );
  check(
    "one shared column is not",
    retypedCopies([own("Stickers", [text("sku"), text("colour")])], store).length === 0
  );
  check(
    "nor a worked-out one",
    retypedCopies(
      [
        own("Packing", [
          text("note"),
          { field: "order_number", label: "Order", type: "text", compute: { const: "x" } },
          { field: "customer_name", label: "Customer", type: "text", compute: { const: "x" } },
        ]),
      ],
      store
    ).length === 0
  );
  check(
    "nor a section over the store itself",
    retypedCopies(
      [
        {
          ...section("Packing", { source_table: "orders" }),
          newSchema: { columns: [text("order_number"), text("customer_name")] },
        },
      ],
      store
    ).length === 0
  );
  check(
    "nor with no store at all",
    retypedCopies([own("Packing", [text("order_number"), text("customer_name")])], null).length === 0
  );
}

// Where new work goes when a section of theirs already works on its
// rows: a question for the owner, in one tap, asked once a thread.
console.log("\nwork on rows a section of theirs already works on");
{
  const text = (field) => ({ field, label: field, type: "text" });
  const mod = (id, nav_label, source_table = null) => ({ id, name: nav_label.toLowerCase(), nav_label, source_table });
  const packing = mod("m-pack", "Packing", "orders");
  const shelf = mod("m-shelf", "Shelf log");
  const cols = { "m-shelf": [text("sku"), text("bin"), text("qty"), { ...text("worth"), compute: { const: 1 } }] };
  const columnsOf = (id) => cols[id];
  const never = () => false;
  const over = (nav_label, source_table) => ({ ...section(nav_label, { source_table }), newSchema: { columns: [] } });
  const returns = over("Returns check", "orders");
  check("a second section over the same store list has a twin", sectionTwin(returns, [packing], columnsOf) === packing);
  check(
    "one over another list has none",
    sectionTwin(over("Stock", "inventory_levels"), [packing], columnsOf) === null
  );
  const own = (nav_label, columns) => ({ ...section(nav_label), newSchema: { columns } });
  check(
    "a list of its own with three of another's fields has a twin",
    sectionTwin(own("Bin moves", [text("sku"), text("bin"), text("qty"), text("moved_on")]), [shelf], columnsOf) ===
      shelf
  );
  check(
    "two of a small list's three do",
    sectionTwin(own("Bin moves", [text("sku"), text("bin"), text("moved_on")]), [shelf], columnsOf) === shelf
  );
  check(
    "two of many, or a worked-out one, do not",
    sectionTwin(
      own("Bin moves", [text("sku"), text("worth"), text("a"), text("b"), text("c"), text("d")]),
      [shelf],
      columnsOf
    ) === null
  );
  const q = reuseQuestion([returns], [packing], columnsOf, store, never);
  check("it is asked as one question", q?.type === "clarify" && q.questions.length === 1);
  check(
    "naming the section and the rows",
    /Packing/.test(q?.questions[0].question ?? "") && /orders/.test(q?.questions[0].question ?? "")
  );
  const [yes, no] = q?.questions[0].suggestions ?? [];
  check(
    "with yes and no, each saying what it gives",
    (yes ?? "").startsWith("Yes: add it to Packing") &&
      (no ?? "").startsWith("No: ") &&
      (no ?? "").includes("Packing stays")
  );
  check(
    "and its own pick, with why",
    q?.questions[0].recommended === yes && (q?.questions[0].why ?? "").startsWith("My pick")
  );
  check(
    "and not again once it was",
    reuseQuestion([returns], [packing], columnsOf, store, (k) => k === "reuse-m-pack") === null
  );
  const copy = reuseQuestion(
    [own("Packing list", [text("order_number"), text("customer_name")])],
    [],
    columnsOf,
    store,
    never
  );
  check(
    "a hand-typed copy of a store list is asked about too",
    /second list of your orders/.test(copy?.questions[0].question ?? "")
  );
  check(
    "with building it on the store's list as the pick",
    (copy?.questions[0].recommended ?? "").startsWith("Yes: build it on my orders")
  );
  check(
    "nothing overlapping, nothing asked",
    reuseQuestion([own("Staff", [text("name"), text("role")])], [packing], columnsOf, store, never) === null
  );
}

console.log(fails.length === 0 ? "\nthe section may stand; the made-up rows may not" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
