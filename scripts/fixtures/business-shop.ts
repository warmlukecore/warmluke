// A shop of another kind of business, for the Luke evals (evals/README.md).
//
// seed-shop.ts is one shop, held byte for byte by every check that reads
// a store. The evals need more kinds of business: phone cases, clothes in
// sizes, cosmetics, gadgets, snacks, wholesale. Each is a few lines of
// data in scripts/fixtures/shops/, turned here into the same Shopify-shaped
// nodes seed-shop makes, and saved through each resource's own saver, as
// an import would. Only the lists a business case reads are filled
// (products, customers, orders and what follows from them, stock, one
// location); the rest are empty. A shop may also bring what its connections
// would: a courier's shipments, an ad account's days, a restock time.
//
// Built by arithmetic from the day it is seeded, so every seeding of the
// same day is the same shop, and what a case expects is worked out from
// these same nodes (evals/expect.mjs). Nothing here is anybody's real data.
//
// Callers: scripts/eval-luke.mjs, scripts/check-eval-harness.mjs, scripts/check-eval-graders.mjs.

import type { SupabaseClient } from "@supabase/supabase-js";
import { RESOURCES, SHOPIFY_RESOURCES, type Resource } from "@/lib/shopify-resources";
import type {
  GqlCustomer,
  GqlFulfilledOrder,
  GqlLocation,
  GqlOrder,
  GqlProduct,
  GqlRefundedOrder,
  GqlReturningOrder,
  GqlStock,
} from "@/lib/shopify-import";
import { SEED_CURRENCY } from "./seed-shop";

export type Pay = "PAID" | "PENDING" | "REFUNDED" | "PARTIALLY_REFUNDED";

/** One shop, as a business case needs it. */
export type BusinessShop = {
  name: string;
  products: Array<{
    title: string;
    type: string;
    vendor: string;
    tags?: string[];
    status?: "ACTIVE" | "DRAFT";
    /** sku: set where a case needs it, as one SKU on two listings; else made from the shop's prefix. */
    variants: Array<{ title: string; price: number; cost: number; stock: number; sku?: string }>;
  }>;
  customers: Array<{
    name: string;
    email: string | null;
    phone: string | null;
    city: string;
    zip: string;
    tags?: string[];
  }>;
  /** lines: [variant index over every product's variants in order, quantity]. */
  orders: Array<{
    daysBack: number;
    customer: number | null;
    lines: Array<[variant: number, qty: number]>;
    pay: Pay;
    gateway: string;
    shipped: "DELIVERED" | "IN_TRANSIT" | null;
    cancelled?: true;
    code?: string;
    /** The campaign its last visit's ad link named (utm_campaign): how an ad campaign's own orders are found. */
    campaign?: string;
  }>;
  /**
   * A courier's shipments in batches sent the same day (courier_shipments,
   * 0204), not tied to orders: `rto` of the `n` came back, `moving` are not
   * settled yet, the rest were delivered. How RTO is read (0225).
   */
  shipments?: Array<{
    courier: string;
    payment: "COD" | "Prepaid";
    daysBack: number;
    n: number;
    rto: number;
    moving?: number;
  }>;
  /** An ad account's days from a dated export (the live account not connected): `perDay` spent for the last `days`. */
  ads?: Array<{ id: string; name: string; perDay: number; days: number }>;
  /** How long a restock takes, as the owner said it (projects.restock_days, 0222). */
  restockDays?: number;
  /** A return on one line of an order. */
  returns?: Array<{ order: number; line: number; reason: string; daysBack: number; open?: true }>;
};

const SHIPPING = 60;
const TAX = 0.05;
const gid = (kind: string, n: number) => `gid://shopify/${kind}/${n}`;
const inr = (n: number) => ({ shopMoney: { amount: n.toFixed(2), currencyCode: SEED_CURRENCY } });
const amt = (n: number) => ({ shopMoney: { amount: n.toFixed(2) } });

/** Every variant of the shop in order, with the product it is on and its SKU. */
export function variantsOf(shop: BusinessShop) {
  const prefix = shop.name.slice(0, 3).toUpperCase();
  return shop.products.flatMap((p, pi) =>
    p.variants.map((v, vi) => ({
      ...v,
      product: pi,
      id: gid("ProductVariant", 81001 + pi * 10 + vi),
      sku: v.sku ?? `${prefix}-${101 + pi * 10 + vi}`,
    }))
  );
}

/** An order's money, as seed-shop works it out: 10% off with a code, 5% tax, ₹60 shipping. */
export function totalsOf(shop: BusinessShop) {
  const variants = variantsOf(shop);
  return shop.orders.map((o) => {
    const subtotal = o.lines.reduce((s, [v, q]) => s + variants[v].price * q, 0);
    const discount = o.code ? Math.round(subtotal * 0.1) : 0;
    const tax = Math.round((subtotal - discount) * TAX);
    return { subtotal, discount, tax, total: subtotal - discount + tax + SHIPPING };
  });
}

/** Every resource's nodes, as Shopify would send them on `now`'s day. */
export function shopNodes(shop: BusinessShop, now = Date.now()): Record<Resource, unknown[]> {
  // Midday in India, so a day back is always the calendar day before (as seed-shop).
  const noon = Math.floor(now / 86_400_000) * 86_400_000 + 6.5 * 3_600_000;
  const at = (daysBack: number, hours = 0) => new Date(noon - daysBack * 86_400_000 + hours * 3_600_000).toISOString();
  const variants = variantsOf(shop);
  const totals = totalsOf(shop);
  const productId = (pi: number) => gid("Product", 80001 + pi);
  const customerId = (ci: number) => gid("Customer", 83001 + ci);
  const orderId = (oi: number) => gid("Order", 84001 + oi);
  const lineId = (oi: number, li: number) => gid("LineItem", 85001 + oi * 10 + li);
  const location = { id: gid("Location", 88001), name: "Main warehouse" };
  const refunded = (oi: number) =>
    shop.orders[oi].pay === "REFUNDED"
      ? totals[oi].total
      : shop.orders[oi].pay === "PARTIALLY_REFUNDED"
        ? variants[shop.orders[oi].lines[0][0]].price
        : 0;

  const products: GqlProduct[] = shop.products.map((p, pi) => ({
    id: productId(pi),
    title: p.title,
    handle: p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    status: p.status ?? "ACTIVE",
    productType: p.type,
    vendor: p.vendor,
    tags: p.tags ?? [],
    updatedAt: at(60),
    variants: {
      nodes: variants
        .filter((v) => v.product === pi)
        .map((v, k) => ({
          id: v.id,
          title: v.title,
          sku: v.sku,
          barcode: `890${String(5000 + pi * 10 + k).padStart(10, "0")}`,
          price: v.price.toFixed(2),
          updatedAt: at(60),
          inventoryItem: {
            id: gid("InventoryItem", 82001 + pi * 10 + k),
            tracked: true,
            unitCost: { amount: v.cost.toFixed(2) },
          },
        })),
    },
  }));

  const live = (oi: number) => !shop.orders[oi].cancelled;
  const customers: GqlCustomer[] = shop.customers.map((c, ci) => {
    const mine = shop.orders.map((o, oi) => ({ o, oi })).filter(({ o, oi }) => o.customer === ci && live(oi));
    return {
      id: customerId(ci),
      displayName: c.name,
      email: c.email,
      phone: c.phone,
      tags: c.tags ?? [],
      updatedAt: at(0),
      numberOfOrders: String(mine.length),
      amountSpent: {
        amount: mine.reduce((s, { oi }) => s + totals[oi].total - refunded(oi), 0).toFixed(2),
        currencyCode: SEED_CURRENCY,
      },
      defaultAddress: { city: c.city, zip: c.zip },
    };
  });

  const orders: GqlOrder[] = shop.orders.map((o, oi) => {
    const t = totals[oi];
    const back = refunded(oi);
    const c = o.customer === null ? null : shop.customers[o.customer];
    return {
      id: orderId(oi),
      name: `#${1001 + oi}`,
      createdAt: at(o.daysBack),
      updatedAt: at(o.daysBack, 2),
      cancelledAt: o.cancelled ? at(o.daysBack, 1) : null,
      tags: o.pay === "PENDING" && /cod|cash/i.test(o.gateway) ? ["cod"] : [],
      displayFinancialStatus: o.pay,
      displayFulfillmentStatus: o.shipped ? "FULFILLED" : "UNFULFILLED",
      totalPriceSet: inr(t.total),
      currentTotalPriceSet: inr(o.cancelled ? 0 : t.total - back),
      currentSubtotalPriceSet: amt(t.subtotal),
      currentTotalTaxSet: amt(t.tax),
      currentTotalDiscountsSet: amt(t.discount),
      totalShippingPriceSet: amt(SHIPPING),
      customer: o.customer === null ? null : { id: customerId(o.customer) },
      paymentGatewayNames: [o.gateway],
      discountCodes: o.code ? [o.code] : [],
      shippingAddress: { city: c?.city ?? "Pune", provinceCode: null, countryCode: "IN", phone: c?.phone ?? null },
      phone: c?.phone ?? null,
      sourceName: "web",
      customerJourneySummary: {
        lastVisit: o.campaign
          ? { source: "Facebook", utmParameters: { source: "facebook", medium: "paid", campaign: o.campaign } }
          : null,
      },
      lineItems: {
        nodes: o.lines.map(([v, qty], li) => ({
          id: lineId(oi, li),
          title: shop.products[variants[v].product].title,
          variantTitle: variants[v].title === "Default Title" ? null : variants[v].title,
          quantity: qty,
          sku: variants[v].sku,
          variant: { id: variants[v].id },
          product: { id: productId(variants[v].product) },
          originalUnitPriceSet: amt(variants[v].price),
        })),
      },
      refunds: back
        ? [{ id: gid("Refund", 86001 + oi), createdAt: at(Math.max(o.daysBack - 2, 0)), totalRefundedSet: amt(back) }]
        : [],
      transactions: [
        {
          id: gid("OrderTransaction", 87001 + oi * 10),
          kind: "SALE",
          status: o.pay === "PENDING" ? "PENDING" : "SUCCESS",
          gateway: o.gateway,
          processedAt: at(o.daysBack),
          test: false,
          amountSet: inr(t.total),
        },
      ],
    };
  });

  const refunds: GqlRefundedOrder[] = orders.map((o, oi) => ({
    id: o.id,
    refunds: o.refunds.map((r) => ({
      ...r,
      refundLineItems: {
        nodes: [{ quantity: shop.orders[oi].pay === "REFUNDED" ? shop.orders[oi].lines[0][1] : 1 }],
      },
    })),
  }));

  const fulfillments: GqlFulfilledOrder[] = shop.orders.map((o, oi) => ({
    id: orderId(oi),
    fulfillments: o.shipped
      ? [
          {
            id: gid("Fulfillment", 88501 + oi),
            status: "SUCCESS",
            displayStatus: o.shipped,
            createdAt: at(o.daysBack, 20),
            updatedAt: at(Math.max(o.daysBack - 2, 0), 4),
            deliveredAt: o.shipped === "DELIVERED" ? at(Math.max(o.daysBack - 2, 0)) : null,
            trackingInfo: [{ company: "Delhivery", number: `DLV${700001 + oi}`, url: null }],
          },
        ]
      : [],
  }));

  const returns: GqlReturningOrder[] = (shop.returns ?? []).map((r, ri) => {
    const v = variants[shop.orders[r.order].lines[r.line][0]];
    return {
      id: orderId(r.order),
      returns: {
        nodes: [
          {
            id: gid("Return", 89501 + ri),
            name: `#${1001 + r.order}-R1`,
            status: r.open ? "OPEN" : "CLOSED",
            totalQuantity: 1,
            createdAt: at(r.daysBack),
            closedAt: r.open ? null : at(Math.max(r.daysBack - 3, 0)),
            returnLineItems: {
              nodes: [
                {
                  id: gid("ReturnLineItem", 89601 + ri),
                  quantity: 1,
                  refundedQuantity: r.open ? 0 : 1,
                  returnReasonNote: null,
                  returnReasonDefinition: {
                    handle: r.reason.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                    name: r.reason,
                  },
                  fulfillmentLineItem: {
                    lineItem: {
                      id: lineId(r.order, r.line),
                      title: shop.products[v.product].title,
                      sku: v.sku,
                      variant: { id: v.id },
                      product: { id: productId(v.product) },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };
  });

  const locations: GqlLocation[] = [
    {
      id: location.id,
      name: location.name,
      isActive: true,
      fulfillsOnlineOrders: true,
      address: {
        address1: "12 Market Road",
        city: "Delhi",
        province: "Delhi",
        provinceCode: "DL",
        country: "India",
        countryCode: "IN",
        zip: "110020",
      },
    },
  ];

  // One location, nothing committed or on its way: what a case asks of stock is its count.
  const inventory: GqlStock[] = variants.map((v) => ({
    id: v.id,
    inventoryItem: {
      inventoryLevels: {
        nodes: [
          {
            location,
            quantities: [
              { name: "available", quantity: v.stock },
              { name: "on_hand", quantity: v.stock },
              { name: "committed", quantity: 0 },
              { name: "incoming", quantity: 0 },
            ],
          },
        ],
      },
    },
  }));

  return {
    products,
    collections: [],
    customers,
    carts: [],
    drafts: [],
    discounts: [],
    returns,
    payouts: [],
    orders,
    locations,
    inventory,
    refunds,
    fulfillments,
  };
}

/** Saves the shop into `storeId` through each resource's own saver, twice, as seed-shop does. */
export async function seedBusiness(db: SupabaseClient, storeId: string, shop: BusinessShop, now = Date.now()) {
  const nodes = shopNodes(shop, now);
  for (let pass = 0; pass < 2; pass++) {
    for (const r of RESOURCES) await SHOPIFY_RESOURCES[r].save(db, storeId, nodes[r]);
  }
  await seedConnections(db, storeId, shop, now);
}

/**
 * What a shop's connections bring, as their workers write it: a courier's
 * shipments and an ad account's days, each under a connection of its own,
 * and the restock time the owner gave. The ad account is marked a dated
 * export (the sprint's stand-in while a live account is not connected).
 */
async function seedConnections(db: SupabaseClient, storeId: string, shop: BusinessShop, now: number) {
  if (!shop.shipments?.length && !shop.ads?.length && !shop.restockDays) return;
  const { data: store } = await db.from("stores").select("project_id, projects(owner_id)").eq("id", storeId).single();
  const projectId = store!.project_id as string;
  const owner = (store!.projects as unknown as { owner_id: string }).owner_id;
  const noon = Math.floor(now / 86_400_000) * 86_400_000 + 6.5 * 3_600_000;
  const at = (daysBack: number) => new Date(noon - daysBack * 86_400_000).toISOString();
  const connect = async (provider: string, account_ref: string) => {
    const { data, error } = await db
      .from("store_connections")
      .insert({
        project_id: projectId,
        store_id: storeId,
        provider,
        account_ref,
        status: "connected",
        connected_by: owner,
      })
      .select("id")
      .single();
    if (error) throw new Error(`could not connect ${provider}: ${error.message}`);
    return data.id as string;
  };
  if (shop.restockDays) await db.from("projects").update({ restock_days: shop.restockDays }).eq("id", projectId);
  if (shop.shipments?.length) {
    const connection_id = await connect("shiprocket", "eval-courier");
    const rows = shop.shipments.flatMap((b) =>
      Array.from({ length: b.n }, (_, i) => ({
        project_id: projectId,
        store_id: storeId,
        connection_id,
        provider: "shiprocket",
        shipment_ref: `${b.courier}-${b.payment}-${b.daysBack}-${i}`,
        courier: b.courier,
        payment_mode: b.payment === "COD" ? "COD" : "prepaid",
        rto: i < b.rto,
        shipped_at: at(b.daysBack),
        delivered_at: i >= b.rto && i < b.n - (b.moving ?? 0) ? at(b.daysBack - 2) : null,
        status_at: at(Math.max(0, b.daysBack - 2)),
      }))
    );
    const { error } = await db.from("courier_shipments").insert(rows);
    if (error) throw new Error(`could not write the shipments: ${error.message}`);
  }
  if (shop.ads?.length) {
    const day = (daysBack: number) => new Date(noon - daysBack * 86_400_000).toISOString().slice(0, 10);
    const connection_id = await connect("meta_ads", `dated export, ${day(0)}`);
    const rows = shop.ads.flatMap((a) =>
      Array.from({ length: a.days }, (_, d) => ({
        project_id: projectId,
        store_id: storeId,
        connection_id,
        provider: "meta_ads",
        campaign_id: a.id,
        campaign_name: a.name,
        day: day(d),
        spend: a.perDay,
        currency: SEED_CURRENCY,
      }))
    );
    const { error } = await db.from("ad_spend").insert(rows);
    if (error) throw new Error(`could not write the ad days: ${error.message}`);
  }
}
