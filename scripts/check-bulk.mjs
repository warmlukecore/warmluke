// Reading a file Shopify wrote, a slice at a time.
//
// The bulk importer's subtle part is not the query — it is that a
// million-row file is read in pieces, and a piece almost never ends on
// a line boundary. Get that wrong and you either lose a row at every
// boundary or parse half a line as if it were whole, and both look
// like a successful import of slightly the wrong data.
//
// Children are flattened out of their parents and tied back by
// __parentId, so this also checks they are reassembled onto the right
// one — including the case where Shopify hangs stock levels off the
// inventory item rather than the variant.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-bulk.mjs

import { createServer } from "node:http";
import { ingestSlice } from "../src/lib/shopify-bulk.ts";
import { SHOPIFY_RESOURCES } from "../src/lib/shopify-resources.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

/** Serves one body, honouring Range the way object storage does. */
function serve(body, cap = Infinity) {
  const buf = Buffer.from(body);
  const server = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range ?? "");
    if (!m) {
      res.writeHead(200, { "Content-Length": buf.length });
      return res.end(buf);
    }
    const from = Number(m[1]);
    if (from >= buf.length) {
      res.writeHead(416, { "Content-Range": `bytes */${buf.length}` });
      return res.end();
    }
    const asked = m[2] ? Number(m[2]) : buf.length - 1;
    const to = Math.min(asked, from + cap - 1, buf.length - 1);
    const slice = buf.subarray(from, to + 1);
    res.writeHead(206, {
      "Content-Range": `bytes ${from}-${to}/${buf.length}`,
      "Content-Length": slice.length,
    });
    res.end(slice);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/results.jsonl`,
        stop: () => new Promise((r) => server.close(r)),
      })
    )
  );
}

/**
 * A database that writes nothing and remembers everything.
 *
 * Thenable and chainable in the shapes the savers use, so they run
 * unmodified — the point is to check what they are handed, not to
 * re-test the writes themselves.
 */
function recorder(seed = {}) {
  const written = { ...seed };
  // A plain select resolves to whatever that table already holds, so
  // a saver looking up the variants it wrote a moment ago finds them
  // — which is how the real one behaves and what the reassembly
  // depends on.
  const make = (table, rows = written[table] ?? []) => {
    const result = { data: rows.map((r, i) => ({ ...r, id: `${table}-${i}` })), error: null };
    const chain = {
      upsert(list) {
        (written[table] ??= []).push(...list);
        return make(table, list);
      },
      insert(list) {
        (written[table] ??= []).push(...list);
        return make(table, list);
      },
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      delete: () => chain,
      then: (fn) => Promise.resolve(result).then(fn),
    };
    return chain;
  };
  return { db: { from: (t) => make(t) }, written };
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Reads the whole file the way the route does: slice after slice. */
async function readAll(db, resource, url) {
  let offset = 0;
  let imported = 0;
  for (let i = 0; i < 400; i++) {
    const step = await ingestSlice(db, "store-1", resource, url, offset);
    imported += step.imported;
    offset = step.nextOffset;
    if (step.done) return { imported, calls: i + 1 };
  }
  throw new Error("never finished");
}

// Twelve products, each with two variants: enough lines that a small
// slice lands mid-line repeatedly.
const products = [];
for (let i = 1; i <= 12; i++) {
  products.push({
    id: `gid://shopify/Product/${i}`,
    title: `Product ${i}`,
    handle: `product-${i}`,
    status: "ACTIVE",
    tags: ["a"],
    updatedAt: "2026-01-01T00:00:00Z",
  });
  for (const v of [1, 2]) {
    products.push({
      id: `gid://shopify/ProductVariant/${i}${v}`,
      title: `V${v}`,
      sku: `SKU-${i}-${v}`,
      barcode: null,
      price: "9.99",
      updatedAt: "2026-01-01T00:00:00Z",
      __parentId: `gid://shopify/Product/${i}`,
    });
  }
}

console.log("a file read in one go");
{
  const file = await serve(jsonl(products));
  const { db, written } = recorder();
  const { imported } = await readAll(db, "products", file.url);
  check("every product is written", imported === 12 && written.products.length === 12);
  check("with its variants attached", written.variants.length === 24);
  check(
    "each variant under the product it names",
    written.variants.every((v) => String(v.product_id ?? "").startsWith("products-"))
  );
  await file.stop();
}

console.log("\nand the same file read in slices");
{
  // The real slice is 2MB and this file is far smaller, so the
  // boundary case is forced by a server that never returns more than
  // 200 bytes at a time — exactly what a short read looks like.
  const file = await serve(jsonl(products), 200);
  const { db, written } = recorder();
  const { imported, calls } = await readAll(db, "products", file.url);
  check("it took several reads", calls > 3);
  check("and still wrote every product exactly once", imported === 12 && written.products.length === 12);
  check("and every variant exactly once", written.variants.length === 24);
  check(
    "with nothing torn in half",
    written.products.every((p) => /^Product \d+$/.test(p.title))
  );
  await file.stop();
}

console.log("\nstock levels find their variant either way round");
{
  const rows = [
    { id: "gid://shopify/ProductVariant/1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } },
    // Hung off the inventory item, which is how Shopify flattens it.
    {
      quantities: [{ quantity: 7 }],
      location: { name: "Shop" },
      __parentId: "gid://shopify/InventoryItem/1",
    },
    // And off the variant, for the shape where it does not.
    {
      quantities: [{ quantity: 3 }],
      location: { name: "Warehouse" },
      __parentId: "gid://shopify/ProductVariant/1",
    },
  ];
  const file = await serve(jsonl(rows));
  // The variant itself is imported by the products pass; stock is a
  // later pass that finds it already there.
  const { db, written } = recorder({
    variants: [{ external_id: "gid://shopify/ProductVariant/1" }],
  });
  await readAll(db, "inventory", file.url);
  const levels = written.inventory_levels ?? [];
  check("both levels land", levels.length === 2);
  check(
    "at the right locations",
    levels
      .map((l) => l.location_name)
      .sort()
      .join(",") === "Shop,Warehouse"
  );
  await file.stop();
}

console.log("\nan order keeps its lines and its refunds apart");
{
  const rows = [
    {
      id: "gid://shopify/Order/1",
      name: "#1001",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      cancelledAt: null,
      tags: [],
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      totalPriceSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } },
      customer: null,
      paymentGatewayNames: ["Cash on Delivery (COD)", "gift_card"],
      discountCodes: ["WELCOME10"],
      shippingAddress: { city: "Pune", provinceCode: "MH", countryCode: "IN" },
      // Inline, because refunds is a plain list and not a connection:
      // the export writes it inside the order and never as separate
      // __parentId lines. The reader used to blank this and wait for
      // lines that were never coming, so every refund was lost —
      // which this fixture hid by modelling the wrong shape.
      refunds: [
        {
          id: "gid://shopify/Refund/1",
          createdAt: "2026-01-02T00:00:00Z",
          totalRefundedSet: { shopMoney: { amount: "25.00" } },
        },
      ],
    },
    {
      id: "gid://shopify/LineItem/1",
      title: "A thing",
      variantTitle: "Blue",
      quantity: 2,
      sku: "X",
      originalUnitPriceSet: { shopMoney: { amount: "25.00" } },
      __parentId: "gid://shopify/Order/1",
    },
  ];
  const file = await serve(jsonl(rows));
  const { db, written } = recorder();
  await readAll(db, "orders", file.url);
  check("the order is written", (written.orders ?? []).length === 1);
  check("what paid is the first gateway", written.orders[0].gateway === "Cash on Delivery (COD)");
  check("and where it went", written.orders[0].ship_city === "Pune" && written.orders[0].ship_state === "MH");
  check("and the code used", written.orders[0].discount_codes[0] === "WELCOME10");
  check("its line is a line", (written.order_line_items ?? []).length === 1);
  check("the line kept its variant", written.order_line_items[0].variant_title === "Blue");
  check("and its refund is a refund", (written.refunds ?? []).length === 1);
  check("the refund kept its amount", written.refunds[0].amount === 25);
  check("and left the units alone for the refunds pass", !("quantity" in written.refunds[0]));
  await file.stop();
}

console.log("\nshipments come by their own file, inline in their orders");
{
  const rows = [
    {
      id: "gid://shopify/Order/1",
      fulfillments: [
        {
          id: "gid://shopify/Fulfillment/1",
          status: "SUCCESS",
          displayStatus: "IN_TRANSIT",
          createdAt: "2026-01-03T00:00:00Z",
          updatedAt: "2026-01-04T00:00:00Z",
          deliveredAt: null,
          // Two parcels, one shipment.
          trackingInfo: [
            { company: "Delhivery", number: "DL1", url: "https://t/DL1" },
            { company: "Delhivery", number: "DL2", url: null },
          ],
        },
      ],
    },
  ];
  const file = await serve(jsonl(rows));
  const { db, written } = recorder({ orders: [{ external_id: "gid://shopify/Order/1" }] });
  await readAll(db, "fulfillments", file.url);
  check(
    "the shipment lands on its order",
    (written.fulfillments ?? []).length === 1 && written.fulfillments[0].order_id === "orders-0"
  );
  check("with its courier", written.fulfillments[0].carrier === "Delhivery");
  check("every parcel's number", written.fulfillments[0].tracking_number === "DL1, DL2");
  check("and where it stands", written.fulfillments[0].shipment_status === "IN_TRANSIT");
  await file.stop();
}

console.log("\nhow many units went back comes by its own page");
{
  // A refund's line items are a connection inside a list, and Shopify
  // refuses that in a bulk query outright. So refunds are a resource
  // of their own with no bulk road, paged over the refunded orders.
  check("refunds have no bulk road", SHOPIFY_RESOURCES.refunds.bulk === null);
  check("and page only the orders with one", /financial_status:refunded/.test(SHOPIFY_RESOURCES.refunds.page));
  // The orders pass has been: the refund's order is already here.
  const { db, written } = recorder({ orders: [{ external_id: "gid://shopify/Order/1" }] });
  await SHOPIFY_RESOURCES.refunds.save(db, "store-1", [
    {
      id: "gid://shopify/Order/1",
      refunds: [
        {
          id: "gid://shopify/Refund/1",
          createdAt: "2026-01-02T00:00:00Z",
          totalRefundedSet: { shopMoney: { amount: "25.00" } },
          refundLineItems: { nodes: [{ quantity: 2 }, { quantity: 1 }] },
        },
      ],
    },
    // Never imported: nothing to hang its refund on, so it waits.
    {
      id: "gid://shopify/Order/9",
      refunds: [
        {
          id: "gid://shopify/Refund/9",
          createdAt: "2026-01-02T00:00:00Z",
          totalRefundedSet: null,
          refundLineItems: { nodes: [{ quantity: 4 }] },
        },
      ],
    },
  ]);
  check(
    "the refund lands on its order",
    (written.refunds ?? []).length === 1 && written.refunds[0].order_id === "orders-0"
  );
  check("with the units summed", written.refunds[0].quantity === 3);
  check("and the amount", written.refunds[0].amount === 25);
}

// ── A page that lost children ───────────────────────────────────
// The paged route asks for a hundred variants, a hundred order lines,
// ten stock locations — and Shopify stops there without saying so. The
// bulk route has no such limits, so a page that came back at the limit
// sends the whole resource that way rather than finishing a walk that
// is already missing rows.
{
  const { childrenWereCut } = await import("../src/lib/shopify-resources.ts");
  const product = (variants) => ({
    id: "gid://shopify/Product/1",
    variants: { nodes: Array.from({ length: variants }, (_, i) => ({ id: `v${i}` })) },
  });

  check("a product with room to spare is left alone", !childrenWereCut("products", [product(99)]));
  check("one that filled the page is not", childrenWereCut("products", [product(100)]));
  check(
    "and one full product among many is enough",
    childrenWereCut("products", [product(2), product(100), product(3)])
  );

  const order = (lines, refunds = 0, refundLines = 0) => ({
    lineItems: { nodes: Array.from({ length: lines }, (_, i) => ({ id: `l${i}` })) },
    refunds: Array.from({ length: refunds }, (_, i) => ({
      id: `r${i}`,
      refundLineItems: { nodes: Array.from({ length: refundLines }, (_, j) => ({ id: `rl${j}` })) },
    })),
  });
  check("an ordinary order is left alone", !childrenWereCut("orders", [order(5, 1)]));
  check("a hundred lines is not", childrenWereCut("orders", [order(100)]));
  // Refunds are a plain list with its own smaller limit, and were the
  // one child that could never be asked for a pageInfo.
  check("and twenty refunds is not", childrenWereCut("orders", [order(3, 20)]));
  check("a refund of a few units is left alone", !childrenWereCut("refunds", [order(0, 1, 4)]));
  check("one of two hundred and fifty lines is not", childrenWereCut("refunds", [order(0, 1, 250)]));
  check("nor an order with fifty refunds", childrenWereCut("refunds", [order(0, 50)]));
  const shipped = (n) => ({ fulfillments: Array.from({ length: n }, (_, i) => ({ id: `f${i}` })) });
  check("an order with two shipments is left alone", !childrenWereCut("fulfillments", [shipped(2)]));
  check("one with twenty-five is not", childrenWereCut("fulfillments", [shipped(25)]));

  const stocked = (places) => ({
    inventoryItem: {
      inventoryLevels: { nodes: Array.from({ length: places }, (_, i) => ({ id: `s${i}` })) },
    },
  });
  check("a variant in three shops is left alone", !childrenWereCut("inventory", [stocked(3)]));
  check("one in ten is not", childrenWereCut("inventory", [stocked(10)]));

  check("customers carry no children to lose", !childrenWereCut("customers", [{ id: "c1" }]));
}

console.log(fails.length === 0 ? "\nthe file is read whole" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
