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

import { seededCopies, storeOverlap } from "../src/lib/describe.ts";

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
const section = (nav_label, extra = {}) => ({
  changeType: "NEW_MODULE",
  targetModuleId: null,
  newModule: {
    name: nav_label.toLowerCase().replace(/\s+/g, "-"),
    nav_label,
    icon: "table",
    source_table: null,
    ...extra,
  },
  newSchema: { columns: [{ field: "sku", label: "SKU", type: "text" }] },
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
  check(
    "a copy of the refunds, seeded",
    seededCopies([{ ...section("Refund tracker"), newRecords: rows }], store).length === 1
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

console.log(fails.length === 0 ? "\nthe section may stand; the made-up rows may not" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
