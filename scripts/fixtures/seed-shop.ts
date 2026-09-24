// A small shop, shaped as Shopify sends it, saved the way an import saves it.
//
// The checks that read a store need one, and the check database has
// none: those checks said "nothing to check" and passed. Rows written
// straight into the tables would pass them too while proving nothing
// about the import, and the import is where a field goes missing: a
// flatten that forgets a column renders blank cells, with no error.
// So these are nodes in Shopify's own shape, typed against the ones
// the savers take, and they go through each resource's own `save` in
// the order an import runs, twice, because the import makes a second
// pass for links that arrived out of order (a return before its order).
//
// `Record<Resource, …>` below: a resource added to the registry does not
// type-check until it has rows here too.
//
// Built by arithmetic from the day it is seeded, so every seeding of the
// same day is the same shop. Nothing here is anybody's real data, and no
// Shopify ever answers for it: its token opens nothing.
//
// Its address and owner: SEED_SHOP and SEED_EMAIL in scripts/owner-session.mjs.
// Callers: scripts/seed-check-project.mjs.

import type { SupabaseClient } from "@supabase/supabase-js";
import { RESOURCES, SHOPIFY_RESOURCES, type Resource } from "@/lib/shopify-resources";
import type {
  GqlCart, GqlCollection, GqlCustomer, GqlDiscount, GqlDraftOrder, GqlFulfilledOrder, GqlLocation,
  GqlOrder, GqlPayout, GqlProduct, GqlRefundedOrder, GqlReturningOrder, GqlStock,
} from "@/lib/shopify-import";
import { SEED_SHOP } from "../owner-session.mjs";

export const SEED_CURRENCY = "INR";
export const SEED_TIMEZONE = "Asia/Kolkata";

const gid = (kind: string, n: number) => `gid://shopify/${kind}/${n}`;
const inr = (n: number) => ({ shopMoney: { amount: n.toFixed(2), currencyCode: SEED_CURRENCY } });
const amt = (n: number) => ({ shopMoney: { amount: n.toFixed(2) } });

const PRODUCTS = [
  { title: "Cotton Kurta", type: "Apparel", vendor: "Chanderi Looms", tags: ["summer"], status: "ACTIVE",
    variants: [{ title: "S", price: 899, cost: 420, stock: 14 }, { title: "M", price: 899, cost: 420, stock: 3 }] },
  { title: "Silk Saree", type: "Apparel", vendor: "Kanchi Weaves", tags: ["festive", "silk"], status: "ACTIVE",
    variants: [{ title: "Default Title", price: 2499, cost: 1300, stock: 0 }] },
  { title: "Leather Sandals", type: "Footwear", vendor: "Kolhapur Craft", tags: [], status: "ACTIVE",
    variants: [{ title: "7", price: 1299, cost: 610, stock: 22 }, { title: "8", price: 1299, cost: 610, stock: 9 }] },
  { title: "Brass Diya Set", type: "Home", vendor: "Moradabad Metal", tags: ["festive"], status: "ACTIVE",
    variants: [{ title: "Default Title", price: 499, cost: 180, stock: 40 }] },
  { title: "Jute Tote Bag", type: "Accessories", vendor: "Bengal Jute Co", tags: ["eco"], status: "ACTIVE",
    variants: [{ title: "Default Title", price: 349, cost: 120, stock: 6 }] },
  { title: "Winter Shawl", type: "Apparel", vendor: "Kullu Wool", tags: ["winter"], status: "DRAFT",
    variants: [{ title: "Default Title", price: 1599, cost: 800, stock: 12 }] },
];
const VARIANTS = PRODUCTS.flatMap((p, pi) =>
  p.variants.map((v, vi) => ({ ...v, product: pi, id: gid("ProductVariant", 81001 + pi * 10 + vi), sku: `SS-${101 + pi * 10 + vi}` }))
);
const productId = (pi: number) => gid("Product", 80001 + pi);

const CUSTOMERS = [
  { name: "Aarav Sharma", email: "aarav.sharma@example.com", phone: "+919810000001", city: "Delhi", zip: "110001", tags: ["vip"] },
  { name: "Priya Nair", email: "priya.nair@example.com", phone: "+919810000002", city: "Kochi", zip: "682001", tags: [] },
  { name: "Rohan Gupta", email: "rohan.gupta@example.com", phone: null, city: "Mumbai", zip: "400001", tags: ["wholesale"] },
  { name: "Sneha Iyer", email: "sneha.iyer@example.com", phone: "+919810000004", city: "Bengaluru", zip: "560001", tags: [] },
  { name: "Kabir Singh", email: null, phone: "+919810000005", city: "Jaipur", zip: "302001", tags: [] },
];
const customerId = (ci: number) => gid("Customer", 83001 + ci);

const LOCATIONS = [
  { name: "Main warehouse", city: "Delhi", province: "Delhi", code: "DL", zip: "110020", online: true },
  { name: "Mumbai store", city: "Mumbai", province: "Maharashtra", code: "MH", zip: "400050", online: false },
];
const locationId = (li: number) => gid("Location", 88001 + li);

type Pay = "PAID" | "PENDING" | "REFUNDED" | "PARTIALLY_REFUNDED";
/** Ten orders over four weeks: which days back, who, what (variant index, quantity), and how it went. */
const ORDERS: Array<{
  daysBack: number; customer: number | null; lines: Array<[variant: number, qty: number]>; pay: Pay;
  gateway: string; shipped: "DELIVERED" | "IN_TRANSIT" | null; cancelled?: true; code?: string;
}> = [
  { daysBack: 27, customer: 0, lines: [[3, 1], [5, 2]], pay: "PAID", gateway: "razorpay", shipped: "DELIVERED" },
  { daysBack: 23, customer: 1, lines: [[0, 2]], pay: "REFUNDED", gateway: "razorpay", shipped: "DELIVERED" },
  { daysBack: 19, customer: 2, lines: [[5, 1], [6, 1]], pay: "PAID", gateway: "razorpay", shipped: "DELIVERED", code: "DIWALI10" },
  { daysBack: 15, customer: 0, lines: [[2, 1]], pay: "PAID", gateway: "razorpay", shipped: null, cancelled: true },
  { daysBack: 11, customer: 3, lines: [[5, 4], [6, 1]], pay: "PARTIALLY_REFUNDED", gateway: "razorpay", shipped: "DELIVERED" },
  { daysBack: 8, customer: 4, lines: [[3, 1]], pay: "PENDING", gateway: "Cash on Delivery (COD)", shipped: "IN_TRANSIT" },
  { daysBack: 5, customer: 1, lines: [[7, 2]], pay: "PAID", gateway: "razorpay", shipped: "IN_TRANSIT" },
  { daysBack: 3, customer: 2, lines: [[0, 1], [5, 1]], pay: "PENDING", gateway: "Cash on Delivery (COD)", shipped: null },
  { daysBack: 1, customer: null, lines: [[6, 3]], pay: "PAID", gateway: "razorpay", shipped: null },
  { daysBack: 0, customer: 0, lines: [[1, 1], [6, 2]], pay: "PAID", gateway: "razorpay", shipped: null, code: "DIWALI10" },
];
const orderId = (oi: number) => gid("Order", 84001 + oi);
const lineId = (oi: number, li: number) => gid("LineItem", 85001 + oi * 10 + li);
const SHIPPING = 60;
const TAX = 0.05;

/** Every resource's nodes, as Shopify would send them on `now`'s day. */
export function seedNodes(now = Date.now()): Record<Resource, unknown[]> {
  // Midday in India, so a day back is always the calendar day before.
  const noon = Math.floor(now / 86_400_000) * 86_400_000 + 6.5 * 3_600_000;
  const at = (daysBack: number, hours = 0) => new Date(noon - daysBack * 86_400_000 + hours * 3_600_000).toISOString();

  const totals = ORDERS.map((o) => {
    const subtotal = o.lines.reduce((s, [v, q]) => s + VARIANTS[v].price * q, 0);
    const discount = o.code ? Math.round(subtotal * 0.1) : 0;
    const tax = Math.round((subtotal - discount) * TAX);
    return { subtotal, discount, tax, total: subtotal - discount + tax + SHIPPING };
  });
  const refunded = (oi: number) =>
    ORDERS[oi].pay === "REFUNDED" ? totals[oi].total : ORDERS[oi].pay === "PARTIALLY_REFUNDED" ? VARIANTS[ORDERS[oi].lines[0][0]].price : 0;

  const products: GqlProduct[] = PRODUCTS.map((p, pi) => ({
    id: productId(pi), title: p.title, handle: p.title.toLowerCase().replace(/ /g, "-"), status: p.status,
    productType: p.type, vendor: p.vendor, tags: p.tags, updatedAt: at(30),
    variants: {
      nodes: VARIANTS.filter((v) => v.product === pi).map((v, k) => ({
        id: v.id, title: v.title, sku: v.sku, barcode: `890${String(1000 + pi * 10 + k).padStart(10, "0")}`,
        price: v.price.toFixed(2), updatedAt: at(30),
        inventoryItem: { id: gid("InventoryItem", 82001 + pi * 10 + k), tracked: true, unitCost: { amount: v.cost.toFixed(2) } },
      })),
    },
  }));

  const collections: GqlCollection[] = [
    { id: gid("Collection", 89001), title: "Festive picks", handle: "festive-picks", sortOrder: "MANUAL", updatedAt: at(30),
      productsCount: { count: 2 }, products: { nodes: [{ id: productId(1) }, { id: productId(3) }] } },
  ];

  const customers: GqlCustomer[] = CUSTOMERS.map((c, ci) => {
    const mine = ORDERS.map((o, oi) => ({ o, oi })).filter(({ o }) => o.customer === ci && !o.cancelled);
    return {
      id: customerId(ci), displayName: c.name, email: c.email, phone: c.phone, tags: c.tags, updatedAt: at(0),
      numberOfOrders: String(mine.length),
      amountSpent: { amount: mine.reduce((s, { oi }) => s + totals[oi].total - refunded(oi), 0).toFixed(2), currencyCode: SEED_CURRENCY },
      defaultAddress: { city: c.city, zip: c.zip },
    };
  });

  const orders: GqlOrder[] = ORDERS.map((o, oi) => {
    const t = totals[oi];
    const back = refunded(oi);
    const c = o.customer === null ? null : CUSTOMERS[o.customer];
    return {
      id: orderId(oi), name: `#${1001 + oi}`, createdAt: at(o.daysBack), updatedAt: at(o.daysBack, 2),
      cancelledAt: o.cancelled ? at(o.daysBack, 1) : null, tags: o.pay === "PENDING" ? ["cod"] : [],
      displayFinancialStatus: o.pay,
      displayFulfillmentStatus: o.shipped ? "FULFILLED" : "UNFULFILLED",
      totalPriceSet: inr(t.total), currentTotalPriceSet: inr(o.cancelled ? 0 : t.total - back),
      currentSubtotalPriceSet: amt(t.subtotal), currentTotalTaxSet: amt(t.tax),
      currentTotalDiscountsSet: amt(t.discount), totalShippingPriceSet: amt(SHIPPING),
      customer: o.customer === null ? null : { id: customerId(o.customer) },
      paymentGatewayNames: [o.gateway], discountCodes: o.code ? [o.code] : [],
      shippingAddress: { city: c?.city ?? "Pune", provinceCode: c ? "DL" : "MH", countryCode: "IN" },
      lineItems: {
        nodes: o.lines.map(([v, qty], li) => ({
          id: lineId(oi, li), title: PRODUCTS[VARIANTS[v].product].title,
          variantTitle: VARIANTS[v].title === "Default Title" ? null : VARIANTS[v].title,
          quantity: qty, sku: VARIANTS[v].sku, variant: { id: VARIANTS[v].id }, product: { id: productId(VARIANTS[v].product) },
          originalUnitPriceSet: amt(VARIANTS[v].price),
        })),
      },
      refunds: back ? [{ id: gid("Refund", 86001 + oi), createdAt: at(o.daysBack - 2), totalRefundedSet: amt(back) }] : [],
      transactions: [
        { id: gid("OrderTransaction", 87001 + oi * 10), kind: "SALE", status: o.pay === "PENDING" ? "PENDING" : "SUCCESS",
          gateway: o.gateway, processedAt: at(o.daysBack), test: false, amountSet: inr(t.total) },
        ...(back
          ? [{ id: gid("OrderTransaction", 87001 + oi * 10 + 1), kind: "REFUND", status: "SUCCESS", gateway: o.gateway,
              processedAt: at(o.daysBack - 2), test: false, amountSet: inr(back) }]
          : []),
        ...(oi === 0
          ? [{ id: gid("OrderTransaction", 87001 + 9), kind: "AUTHORIZATION", status: "SUCCESS", gateway: "bogus",
              processedAt: at(o.daysBack), test: true, amountSet: inr(1) }]
          : []),
      ],
    };
  });

  const refunds: GqlRefundedOrder[] = orders.map((o, oi) => ({
    id: o.id,
    refunds: o.refunds.map((r) => ({
      ...r, refundLineItems: { nodes: [{ quantity: ORDERS[oi].pay === "REFUNDED" ? ORDERS[oi].lines[0][1] : 1 }] },
    })),
  }));

  const fulfillments: GqlFulfilledOrder[] = ORDERS.map((o, oi) => ({
    id: orderId(oi),
    fulfillments: o.shipped
      ? [{
          id: gid("Fulfillment", 88501 + oi), status: "SUCCESS", displayStatus: o.shipped,
          createdAt: at(o.daysBack, 20), updatedAt: at(Math.max(o.daysBack - 3, 0), 4),
          deliveredAt: o.shipped === "DELIVERED" ? at(o.daysBack - 3) : null,
          trackingInfo: [{ company: "Delhivery", number: `DLV${900001 + oi}`, url: `https://www.delhivery.com/track/package/DLV${900001 + oi}` }],
        }]
      : [],
  }));

  const line = (oi: number, li: number) => {
    const v = VARIANTS[ORDERS[oi].lines[li][0]];
    return { id: lineId(oi, li), title: PRODUCTS[v.product].title, sku: v.sku, variant: { id: v.id }, product: { id: productId(v.product) } };
  };
  const returns: GqlReturningOrder[] = [
    { id: orderId(0), returns: { nodes: [{
      id: gid("Return", 89501), name: "#1001-R1", status: "CLOSED", totalQuantity: 1, createdAt: at(22), closedAt: at(18),
      returnLineItems: { nodes: [{
        id: gid("ReturnLineItem", 89601), quantity: 1, refundedQuantity: 1, returnReasonNote: "Pinches at the heel",
        returnReasonDefinition: { handle: "size-too-small", name: "Size was too small" },
        fulfillmentLineItem: { lineItem: line(0, 0) },
      }] },
    }] } },
    { id: orderId(4), returns: { nodes: [{
      id: gid("Return", 89502), name: "#1005-R1", status: "OPEN", totalQuantity: 1, createdAt: at(4), closedAt: null,
      returnLineItems: { nodes: [{
        id: gid("ReturnLineItem", 89602), quantity: 1, refundedQuantity: 0, returnReasonNote: null,
        returnReasonDefinition: { handle: "not-as-described", name: "Not as described" },
        fulfillmentLineItem: { lineItem: line(4, 0) },
      }] },
    }] } },
  ];

  const locations: GqlLocation[] = LOCATIONS.map((l, li) => ({
    id: locationId(li), name: l.name, isActive: true, fulfillsOnlineOrders: l.online,
    address: { address1: `${12 + li} Market Road`, city: l.city, province: l.province, provinceCode: l.code,
      country: "India", countryCode: "IN", zip: l.zip },
  }));

  const inventory: GqlStock[] = VARIANTS.map((v, vi) => ({
    id: v.id,
    inventoryItem: { inventoryLevels: { nodes: [
      { location: { id: locationId(0), name: LOCATIONS[0].name },
        quantities: [{ name: "available", quantity: v.stock }, { name: "on_hand", quantity: v.stock + (vi % 3) },
          { name: "committed", quantity: vi % 3 }, { name: "incoming", quantity: v.stock === 0 ? 10 : 0 }] },
      ...(vi % 2 === 0
        ? [{ location: { id: locationId(1), name: LOCATIONS[1].name },
            quantities: [{ name: "available", quantity: 2 }, { name: "on_hand", quantity: 2 },
              { name: "committed", quantity: 0 }, { name: "incoming", quantity: 0 }] }]
        : []),
    ] } },
  }));

  const diya = VARIANTS[5];
  const drafts: GqlDraftOrder[] = [
    { id: gid("DraftOrder", 90001), name: "#D1", status: "OPEN", email: CUSTOMERS[3].email, tags: ["wholesale"],
      createdAt: at(2), updatedAt: at(2, 1), completedAt: null, invoiceUrl: `https://${SEED_SHOP}/invoices/d1`,
      totalPriceSet: inr(3 * 449 + SHIPPING), subtotalPriceSet: amt(3 * 449), totalTaxSet: amt(0), totalShippingPriceSet: amt(SHIPPING),
      customer: { id: customerId(3), displayName: CUSTOMERS[3].name, email: CUSTOMERS[3].email }, order: null,
      lineItems: { nodes: [{ id: gid("DraftOrderLineItem", 90101), title: "Brass Diya Set", sku: diya.sku, quantity: 3,
        variant: { id: diya.id }, product: { id: productId(diya.product) },
        originalUnitPriceSet: amt(diya.price), discountedUnitPriceSet: amt(449) }] } },
    { id: gid("DraftOrder", 90002), name: "#D2", status: "COMPLETED", email: CUSTOMERS[0].email, tags: [],
      createdAt: at(28), updatedAt: at(27), completedAt: at(27), invoiceUrl: null,
      totalPriceSet: inr(totals[0].total), subtotalPriceSet: amt(totals[0].subtotal), totalTaxSet: amt(totals[0].tax),
      totalShippingPriceSet: amt(SHIPPING), customer: { id: customerId(0), displayName: CUSTOMERS[0].name, email: CUSTOMERS[0].email },
      order: { id: orderId(0) },
      lineItems: { nodes: ORDERS[0].lines.map(([v, qty], li) => ({
        id: gid("DraftOrderLineItem", 90102 + li), title: PRODUCTS[VARIANTS[v].product].title, sku: VARIANTS[v].sku, quantity: qty,
        variant: { id: VARIANTS[v].id }, product: { id: productId(VARIANTS[v].product) },
        originalUnitPriceSet: amt(VARIANTS[v].price), discountedUnitPriceSet: amt(VARIANTS[v].price) })) } },
  ];

  const discounts: GqlDiscount[] = [
    { id: gid("DiscountCodeNode", 91001), discount: { __typename: "DiscountCodeBasic", title: "Diwali 10% off", status: "ACTIVE",
      summary: "10% off entire order", startsAt: at(30), endsAt: at(-20), createdAt: at(30), usageLimit: 500,
      appliesOncePerCustomer: true, asyncUsageCount: 2, codes: { nodes: [{ code: "DIWALI10" }] },
      customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 } } } },
    { id: gid("DiscountAutomaticNode", 91002), discount: { __typename: "DiscountAutomaticBasic", title: "₹100 off over ₹1,999",
      status: "EXPIRED", summary: "₹100 off orders over ₹1,999", startsAt: at(60), endsAt: at(31), createdAt: at(60), usageLimit: null,
      appliesOncePerCustomer: false, asyncUsageCount: 7, codes: null,
      customerGets: { value: { __typename: "DiscountAmount", amount: { amount: "100.00", currencyCode: SEED_CURRENCY } } } } },
  ];

  const carts: GqlCart[] = [
    { id: gid("AbandonedCheckout", 92001), abandonedCheckoutUrl: `https://${SEED_SHOP}/checkouts/c1/recover`,
      createdAt: at(1, 3), updatedAt: at(1, 4), totalPriceSet: inr(2499 + SHIPPING),
      customer: { id: customerId(1), displayName: CUSTOMERS[1].name, email: CUSTOMERS[1].email },
      lineItems: { nodes: [{ title: "Silk Saree", quantity: 1 }] } },
    { id: gid("AbandonedCheckout", 92002), abandonedCheckoutUrl: null, createdAt: at(6), updatedAt: null,
      totalPriceSet: inr(2 * 349 + SHIPPING), customer: null, lineItems: { nodes: [{ title: "Jute Tote Bag", quantity: 2 }] } },
  ];

  const sum = (n: number) => ({ amount: n.toFixed(2) });
  const payouts: GqlPayout[] = [
    { id: gid("ShopifyPaymentsPayout", 93001), status: "PAID", transactionType: "DEPOSIT", issuedAt: at(14),
      net: { amount: "4210.00", currencyCode: SEED_CURRENCY },
      summary: { chargesGross: sum(4390), chargesFee: sum(180), refundsFeeGross: sum(0), refundsFee: sum(0),
        adjustmentsGross: sum(0), adjustmentsFee: sum(0), reservedFundsGross: sum(0), reservedFundsFee: sum(0),
        retriedPayoutsGross: sum(0), retriedPayoutsFee: sum(0), advanceGross: sum(0), advanceFees: sum(0) } },
    { id: gid("ShopifyPaymentsPayout", 93002), status: "SCHEDULED", transactionType: "DEPOSIT", issuedAt: at(-1),
      net: { amount: "3105.50", currencyCode: SEED_CURRENCY }, summary: null },
  ];

  return { products, collections, customers, carts, drafts, discounts, returns, payouts, orders, locations, inventory, refunds, fulfillments };
}

/** Saves the shop into `storeId` through each resource's own saver, as an import would. */
export async function seedShop(db: SupabaseClient, storeId: string, now = Date.now()): Promise<void> {
  const nodes = seedNodes(now);
  for (let pass = 0; pass < 2; pass++) {
    for (const r of RESOURCES) await SHOPIFY_RESOURCES[r].save(db, storeId, nodes[r]);
  }
}
