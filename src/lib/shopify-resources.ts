// ─────────────────────────────────────────────────────────────
// The store's resources, declared once.
//
// Four names — products, customers, orders, inventory — used to be
// spelled out in six places: the list the import walks, the map of
// page importers, the count queries, the bulk queries, the child
// limits, the webhook topics, and the scopes asked for at install.
// A resource added to five of the six was imported and never kept
// fresh, or counted and never fetched, and nothing said so.
//
// This is the one place. Each resource says what it needs from
// Shopify (scopes), how it is counted, paged and bulk-exported, which
// children a page may lose to a limit, how a bulk file is put back
// into the shape the saver expects, which webhook topics keep it fresh
// afterwards, and which tables it writes. Everything else — the import
// route, the bulk path, the webhook subscription, the OAuth scopes,
// the drift report — reads it from here. Adding a resource is adding
// an entry and its saver.
//
// The fetching and saving of each resource stays in shopify-import.ts:
// that is code about one resource's shape. This file is the index.
// ─────────────────────────────────────────────────────────────

import { ACTION_SCOPES } from "@/lib/store-actions";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CARTS_QUERY,
  COLLECTIONS_QUERY,
  CUSTOMERS_QUERY,
  DISCOUNTS_QUERY,
  DRAFT_ORDERS_QUERY,
  ensureFreshToken,
  FULFILLED,
  FULFILLMENTS_QUERY,
  graphql,
  INVENTORY_QUERY,
  LOCATIONS_QUERY,
  ORDERS_QUERY,
  PAYOUTS_QUERY,
  PAGE,
  PRODUCTS_QUERY,
  REFUNDED,
  REFUNDS_QUERY,
  RETURNING,
  RETURNS_QUERY,
  saveCarts,
  saveCollections,
  saveCustomers,
  saveDiscounts,
  saveDraftOrders,
  saveFulfillments,
  saveInventory,
  saveLocations,
  saveOrders,
  savePayouts,
  saveProducts,
  saveRefunds,
  saveReturns,
  type GqlCart,
  type GqlCollection,
  type GqlCustomer,
  type GqlDiscount,
  type GqlDraftOrder,
  type GqlFulfilledOrder,
  type GqlLocation,
  type GqlOrder,
  type GqlPayout,
  type GqlProduct,
  type GqlRefundedOrder,
  type GqlReturningOrder,
  type GqlStock,
  type StoreToken,
} from "@/lib/shopify-import";

/** One line of a bulk export: a node, with its parent's id when it is a child. */
export type BulkLine = Record<string, unknown> & { id?: string; __parentId?: string };

/** A child list a page asks for with a limit, and where it sits on the node. */
export type ChildLimit = { path: readonly string[]; limit: number };

export type ResourceSpec = {
  /** What a merchant calls it, for progress lines. */
  label: string;
  /** The read scopes Shopify needs for it. Every one is asked for at install. */
  scopes: readonly string[];
  /** One cheap count query — decides between paging and a bulk export. */
  count: string;
  /** The paged query: takes $n and $after, returns pageInfo and nodes under `root`. */
  page: string;
  root: string;
  /**
   * The bulk export: the same fields as the page with no pagination
   * arguments, and how the flattened file is put back into the nodes
   * the saver expects. Null for a resource Shopify refuses to export
   * in bulk — a connection inside a list is one — which then pages
   * whatever its size.
   */
  bulk: { query: string; assemble: (lines: BulkLine[]) => unknown[] } | null;
  /**
   * Children a page may lose to its limit. A page holding exactly the
   * limit is treated as cut and the resource goes the bulk way, which
   * asks for children with no limit at all. With no bulk road to take,
   * the page is saved as it came — so such a resource asks for the
   * most Shopify allows.
   */
  children: readonly ChildLimit[];
  /** Writes a batch of nodes, from a page or a bulk file alike. */
  save: (db: SupabaseClient, storeId: string, nodes: unknown[]) => Promise<void>;
  /**
   * Webhook topics that keep it fresh between imports. Each has a
   * handler in abo_shopify_webhook. Empty when another resource's
   * topics already carry it.
   */
  webhooks: readonly string[];
  /** The tables it writes, the parent first. */
  tables: readonly string[];
  /**
   * Whether, after a full pass, the rows held in the parent table are
   * compared with what the pass brought back. Stock is not: its rows
   * are per location and the pass counts variants.
   */
  drift: boolean;
};

/** Parents only: a resource whose file carries no child lines. */
const parentsOnly = (lines: BulkLine[]) => lines.filter((l) => !l.__parentId);

/**
 * Parents with their children, in file order. Shopify writes a child
 * after its parent, and a slice never ends mid-family.
 */
function withChildren<T>(
  lines: BulkLine[],
  make: (parent: BulkLine) => T,
  push: (parent: T, child: BulkLine) => void
): T[] {
  const parents = new Map<string, T>();
  const order: string[] = [];
  for (const l of lines) {
    if (!l.__parentId) {
      parents.set(l.id!, make(l));
      order.push(l.id!);
    } else {
      const p = parents.get(l.__parentId);
      if (p) push(p, l);
    }
  }
  return order.map((id) => parents.get(id)!);
}

export const SHOPIFY_RESOURCES = {
  products: {
    label: "products",
    scopes: ["read_products"],
    count: "{ productsCount { count } }",
    page: PRODUCTS_QUERY,
    root: "products",
    bulk: {
      query: `{ products { edges { node {
    id title handle status productType vendor tags updatedAt
    variants { edges { node { id title sku barcode price updatedAt inventoryItem { id tracked unitCost { amount } } } } }
  } } } }`,
      assemble: (lines) =>
        withChildren<GqlProduct>(
          lines,
          (p) => ({ ...(p as unknown as GqlProduct), variants: { nodes: [] } }),
          (p, child) => p.variants.nodes.push(child as never)
        ),
    },
    children: [{ path: ["variants", "nodes"], limit: 100 }],
    save: (db, storeId, nodes) => saveProducts(db, storeId, nodes as GqlProduct[]),
    webhooks: ["PRODUCTS_CREATE", "PRODUCTS_UPDATE", "PRODUCTS_DELETE"],
    tables: ["products", "variants"],
    drift: true,
  },
  collections: {
    label: "collections",
    scopes: ["read_products"],
    count: "{ collectionsCount { count } }",
    page: COLLECTIONS_QUERY,
    root: "collections",
    bulk: {
      query: `{ collections { edges { node {
    id title handle sortOrder updatedAt
    productsCount { count }
    products { edges { node { id } } }
  } } } }`,
      assemble: (lines) =>
        withChildren<GqlCollection>(
          lines,
          (c) => ({ ...(c as unknown as GqlCollection), products: { nodes: [] } }),
          (c, child) => c.products.nodes.push(child as never)
        ),
    },
    // A collection with more than a hundred products loses the rest
    // on the paged road, and a half-read collection is worse than
    // none: "what is in the sale" would answer with a hundred of two
    // hundred and look complete.
    children: [{ path: ["products", "nodes"], limit: 100 }],
    save: (db, storeId, nodes) => saveCollections(db, storeId, nodes as GqlCollection[]),
    webhooks: ["COLLECTIONS_CREATE", "COLLECTIONS_UPDATE", "COLLECTIONS_DELETE"],
    tables: ["collections", "collection_products"],
    drift: true,
  },
  customers: {
    label: "customers",
    scopes: ["read_customers"],
    count: "{ customersCount { count } }",
    page: CUSTOMERS_QUERY,
    root: "customers",
    bulk: {
      query: `{ customers { edges { node {
    id displayName email phone numberOfOrders tags updatedAt
    amountSpent { amount currencyCode }
    defaultAddress { city zip }
  } } } }`,
      assemble: parentsOnly,
    },
    children: [],
    save: (db, storeId, nodes) => saveCustomers(db, storeId, nodes as GqlCustomer[]),
    webhooks: ["CUSTOMERS_CREATE", "CUSTOMERS_UPDATE", "CUSTOMERS_DELETE"],
    tables: ["customers"],
    drift: true,
  },
  carts: {
    label: "abandoned carts",
    // No new scope: read_orders covers a checkout that never became
    // one, which is why this arrives without anybody reconnecting.
    scopes: ["read_orders"],
    count: "{ abandonedCheckoutsCount { count } }",
    page: CARTS_QUERY,
    root: "abandonedCheckouts",
    // A connection inside a connection, like products and variants,
    // so the export flattens the items out and they come back as
    // children. Tested against the real shop rather than assumed:
    // refunds looked the same and Shopify refused it.
    bulk: {
      query: `{ abandonedCheckouts { edges { node {
    id abandonedCheckoutUrl createdAt updatedAt
    totalPriceSet { shopMoney { amount currencyCode } }
    customer { id displayName email }
    lineItems { edges { node { title quantity } } }
  } } } }`,
      assemble: (lines) =>
        withChildren<GqlCart>(
          lines,
          (c) => ({ ...(c as unknown as GqlCart), lineItems: { nodes: [] } }),
          (c, child) => c.lineItems.nodes.push(child as never)
        ),
    },
    children: [{ path: ["lineItems", "nodes"], limit: 20 }],
    save: (db, storeId, nodes) => saveCarts(db, storeId, nodes as GqlCart[]),
    webhooks: ["CHECKOUTS_CREATE", "CHECKOUTS_UPDATE", "CHECKOUTS_DELETE"],
    tables: ["abandoned_checkouts"],
    // Deliberately not compared. A cart stops being abandoned the
    // moment somebody finishes it, so Shopify's count falls while
    // ours stands until the next full pass — real, and not a loss.
    drift: false,
  },
  drafts: {
    label: "draft orders",
    scopes: ["read_draft_orders"],
    count: "{ draftOrdersCount { count } }",
    page: DRAFT_ORDERS_QUERY,
    root: "draftOrders",
    // A connection inside a connection, like products and variants,
    // so Shopify exports it. Tried against the real shop before this
    // was written down: refunds looked the same and were refused.
    bulk: {
      query: `{ draftOrders { edges { node {
    id name status email tags
    createdAt updatedAt completedAt invoiceUrl
    totalPriceSet { shopMoney { amount currencyCode } }
    subtotalPriceSet { shopMoney { amount } }
    totalTaxSet { shopMoney { amount } }
    totalShippingPriceSet { shopMoney { amount } }
    customer { id displayName email }
    order { id }
    lineItems { edges { node {
      id title sku quantity
      variant { id }
      product { id }
      originalUnitPriceSet { shopMoney { amount } }
      discountedUnitPriceSet { shopMoney { amount } }
    } } }
  } } } }`,
      assemble: (lines) =>
        withChildren<GqlDraftOrder>(
          lines,
          (d) => ({ ...(d as unknown as GqlDraftOrder), lineItems: { nodes: [] } }),
          (d, child) => d.lineItems.nodes.push(child as never)
        ),
    },
    children: [{ path: ["lineItems", "nodes"], limit: 50 }],
    save: (db, storeId, nodes) => saveDraftOrders(db, storeId, nodes as GqlDraftOrder[]),
    webhooks: ["DRAFT_ORDERS_CREATE", "DRAFT_ORDERS_UPDATE", "DRAFT_ORDERS_DELETE"],
    tables: ["draft_orders", "draft_order_line_items"],
    // Compared, unlike carts: a completed draft stays a draft order in
    // Shopify, so the count does not fall on its own and a drop really
    // does mean one was deleted there.
    drift: true,
  },
  discounts: {
    label: "discounts",
    scopes: ["read_discounts"],
    count: "{ discountNodesCount { count } }",
    page: DISCOUNTS_QUERY,
    root: "discountNodes",
    // The codes are a connection inside a connection, so Shopify
    // exports them as children — run for real against the shop, and
    // the file came back with one line per code under its campaign.
    // Which matters more here than elsewhere: a bulk-code campaign
    // has thousands, and the paged road below would keep twenty.
    bulk: {
      query: `{ discountNodes { edges { node {
    id
    discount {
      __typename
      ... on DiscountCodeBasic { title status summary startsAt endsAt usageLimit appliesOncePerCustomer asyncUsageCount createdAt codes { edges { node { code } } } customerGets { value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } } } } }
      ... on DiscountCodeBxgy { title status summary startsAt endsAt usageLimit asyncUsageCount createdAt codes { edges { node { code } } } }
      ... on DiscountCodeFreeShipping { title status summary startsAt endsAt usageLimit appliesOncePerCustomer asyncUsageCount createdAt codes { edges { node { code } } } }
      ... on DiscountCodeApp { title status startsAt endsAt usageLimit asyncUsageCount createdAt codes { edges { node { code } } } }
      ... on DiscountAutomaticBasic { title status summary startsAt endsAt createdAt customerGets { value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } } } } }
      ... on DiscountAutomaticBxgy { title status summary startsAt endsAt createdAt }
      ... on DiscountAutomaticFreeShipping { title status summary startsAt endsAt createdAt }
      ... on DiscountAutomaticApp { title status startsAt endsAt createdAt }
    }
  } } } }`,
      assemble: (lines) =>
        withChildren<GqlDiscount>(
          lines,
          (d) => {
            const node = d as unknown as GqlDiscount;
            // The codes hang off the discount, not off the node, so
            // the list the children go into has to exist before the
            // first child arrives — an automatic discount has none
            // and must still end up with an empty list, not undefined.
            return { ...node, discount: { ...node.discount, codes: { nodes: [] } } };
          },
          (d, child) => d.discount!.codes!.nodes.push(child as never)
        ),
    },
    children: [{ path: ["discount", "codes", "nodes"], limit: 20 }],
    save: (db, storeId, nodes) => saveDiscounts(db, storeId, nodes as GqlDiscount[]),
    webhooks: ["DISCOUNTS_CREATE", "DISCOUNTS_UPDATE", "DISCOUNTS_DELETE"],
    tables: ["discounts"],
    drift: true,
  },
  returns: {
    label: "returns",
    scopes: ["read_returns"],
    // Only the orders in a returning state, the same shape refunds
    // uses: a small slice of any store, cheap to page even where the
    // orders themselves went bulk.
    count: `{ ordersCount(query: "${RETURNING}") { count } }`,
    page: RETURNS_QUERY,
    root: "orders",
    // Accepted, unlike refunds — and the difference is worth naming.
    // Shopify refuses a connection inside a LIST field, which is
    // what refundLineItems is. returns is a connection, so its own
    // connection of lines exports fine. Run against the real shop
    // rather than reasoned about.
    bulk: {
      query: `{ orders(query: "${RETURNING}") { edges { node {
    id
    returns { edges { node {
      id name status totalQuantity createdAt closedAt
      returnLineItems { edges { node {
        id quantity refundedQuantity returnReasonNote
        returnReasonDefinition { handle name }
        ... on ReturnLineItem { fulfillmentLineItem { lineItem { id title sku variant { id } product { id } } } }
      } } }
    } } }
  } } } }`,
      // Three deep: an order, its returns, and their lines. The file
      // is flat, so a line arrives under the return it belongs to and
      // a return under its order, and both have to be put back.
      assemble: (lines) => {
        const orders = new Map<string, GqlReturningOrder>();
        const order: string[] = [];
        const returnOf = new Map<string, GqlReturningOrder["returns"]["nodes"][number]>();
        for (const l of lines) {
          if (!l.__parentId) {
            orders.set(l.id!, { ...(l as unknown as GqlReturningOrder), returns: { nodes: [] } });
            order.push(l.id!);
            continue;
          }
          const parentOrder = orders.get(l.__parentId);
          if (parentOrder) {
            const ret = {
              ...(l as unknown as GqlReturningOrder["returns"]["nodes"][number]),
              returnLineItems: { nodes: [] },
            };
            parentOrder.returns.nodes.push(ret);
            returnOf.set(l.id!, ret);
            continue;
          }
          returnOf.get(l.__parentId)?.returnLineItems.nodes.push(l as never);
        }
        return order.map((id) => orders.get(id)!);
      },
    },
    // Matching what the page asks for. Small because the query is
    // priced before it runs: see the note on RETURNS_QUERY.
    children: [
      { path: ["returns", "nodes"], limit: 5 },
      { path: ["returns", "nodes", "*", "returnLineItems", "nodes"], limit: 20 },
    ],
    save: (db, storeId, nodes) => saveReturns(db, storeId, nodes as GqlReturningOrder[]),
    // Eight topics, one meaning: the state of a return changed.
    webhooks: [
      "RETURNS_REQUEST",
      "RETURNS_APPROVE",
      "RETURNS_DECLINE",
      "RETURNS_CANCEL",
      "RETURNS_CLOSE",
      "RETURNS_REOPEN",
      "RETURNS_PROCESS",
      "RETURNS_UPDATE",
    ],
    tables: ["returns", "return_line_items"],
    // Not compared. The pass counts ORDERS in a returning state and
    // the table holds returns, so the two were never the same number
    // — the mistake stock already taught.
    drift: false,
  },
  payouts: {
    label: "payouts",
    scopes: ["read_shopify_payments_payouts"],
    // There is no payoutsCount in Shopify's schema. This asks the
    // cheapest valid question instead and the count comes back zero,
    // which is harmless: the count only ever chooses between paging
    // and bulk, and there is no bulk road here to choose.
    count: "{ shopifyPaymentsAccount { id } }",
    page: PAYOUTS_QUERY,
    // Two steps down. A shop with no Shopify Payments account has no
    // payouts connection at all, and importPage reads that as zero
    // rows rather than an error.
    root: "shopifyPaymentsAccount.payouts",
    // No bulk road: a bulk operation has to start from a top-level
    // connection, and this one hangs off an object.
    bulk: null,
    children: [],
    save: (db, storeId, nodes) => savePayouts(db, storeId, nodes as GqlPayout[]),
    // Shopify publishes no payout webhook — checked against its own
    // topic list, which has DISCOUNTS_*, RETURNS_* and DISPUTES_*
    // and nothing here. So these go stale between imports.
    webhooks: [],
    tables: ["payouts"],
    // Never compared: a payout is not something a merchant can
    // delete, so a drop could only ever be our own mistake, and the
    // count above is deliberately zero anyway.
    drift: false,
  },
  orders: {
    label: "orders",
    scopes: ["read_orders"],
    count: "{ ordersCount { count } }",
    page: ORDERS_QUERY,
    root: "orders",
    bulk: {
      query: `{ orders { edges { node {
    id name createdAt updatedAt cancelledAt tags
    displayFinancialStatus displayFulfillmentStatus
    totalPriceSet { shopMoney { amount currencyCode } }
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    currentSubtotalPriceSet { shopMoney { amount } }
    currentTotalTaxSet { shopMoney { amount } }
    currentTotalDiscountsSet { shopMoney { amount } }
    totalShippingPriceSet { shopMoney { amount } }
    customer { id }
    paymentGatewayNames
    discountCodes
    shippingAddress { city provinceCode countryCode }
    lineItems { edges { node {
      id title variantTitle quantity sku
      variant { id }
      product { id }
      originalUnitPriceSet { shopMoney { amount } }
    } } }
    refunds { id createdAt totalRefundedSet { shopMoney { amount } } }
    transactions { id kind status gateway processedAt test amountSet { shopMoney { amount currencyCode } } }
  } } } }`,
      // refunds is a plain list, not a connection, so the file carries
      // it inside the order itself and never as separate child lines.
      // Blanking it threw away every refund the export had handed over.
      // The file does not label which connection a child came from:
      // refunds carry an amount, line items carry a quantity.
      assemble: (lines) =>
        withChildren<GqlOrder>(
          lines,
          (o) => {
            const parent = o as unknown as GqlOrder;
            return { ...parent, lineItems: { nodes: [] }, refunds: parent.refunds ?? [] };
          },
          (o, child) => {
            if ("totalRefundedSet" in child) o.refunds.push(child as never);
            else o.lineItems.nodes.push(child as never);
          }
        ),
    },
    children: [
      { path: ["lineItems", "nodes"], limit: 100 },
      { path: ["refunds"], limit: 20 },
      // A plain list like refunds, so the export carries it inside
      // the order and the assembler needs to know nothing about it.
      { path: ["transactions"], limit: 30 },
    ],
    save: (db, storeId, nodes) => saveOrders(db, storeId, nodes as GqlOrder[]),
    webhooks: [
      "ORDERS_CREATE",
      "ORDERS_UPDATED",
      "ORDERS_CANCELLED",
      "ORDERS_PAID",
      "ORDERS_FULFILLED",
      // Money moves without the order changing: a cash-on-delivery
      // order is collected days later and the order itself says the
      // same thing before and after.
      "ORDER_TRANSACTIONS_CREATE",
    ],
    tables: ["orders", "order_line_items", "refunds", "order_transactions"],
    drift: true,
  },
  locations: {
    label: "locations",
    scopes: ["read_locations"],
    count: "{ locationsCount { count } }",
    page: LOCATIONS_QUERY,
    root: "locations",
    bulk: {
      // Same two flags as the paged query, and for the same reason.
      query: `{ locations(includeInactive: true, includeLegacy: true) { edges { node {
    id name isActive fulfillsOnlineOrders
    address { address1 city province provinceCode country countryCode zip }
  } } } }`,
      assemble: parentsOnly,
    },
    children: [],
    save: (db, storeId, nodes) => saveLocations(db, storeId, nodes as GqlLocation[]),
    webhooks: [
      "LOCATIONS_CREATE",
      "LOCATIONS_UPDATE",
      // Switching one off is the event a merchant cares about: its
      // stock stops being sellable and nothing else changes.
      "LOCATIONS_ACTIVATE",
      "LOCATIONS_DEACTIVATE",
      "LOCATIONS_DELETE",
    ],
    tables: ["locations"],
    drift: true,
  },
  inventory: {
    label: "stock levels",
    // The level names its location, which is the locations scope.
    scopes: ["read_inventory", "read_locations"],
    count: "{ productVariantsCount { count } }",
    page: INVENTORY_QUERY,
    root: "productVariants",
    bulk: {
      query: `{ productVariants { edges { node {
    id
    inventoryItem { id inventoryLevels { edges { node {
      quantities(names: ["available", "on_hand", "committed", "incoming"]) { name quantity }
      location { id name }
    } } } }
  } } } }`,
      // Levels hang off the variant or off its inventory item depending
      // on how Shopify flattened the file, so both are resolved.
      assemble: (lines) => {
        const parents = new Map<string, GqlStock>();
        const order: string[] = [];
        const viaItem = new Map<string, string>();
        for (const l of lines) {
          if (!l.__parentId) {
            const item = l.inventoryItem as { id?: string } | undefined;
            parents.set(l.id!, { id: l.id!, inventoryItem: { inventoryLevels: { nodes: [] } } });
            order.push(l.id!);
            if (item?.id) viaItem.set(item.id, l.id!);
            continue;
          }
          const ownerId = parents.has(l.__parentId) ? l.__parentId : viaItem.get(l.__parentId);
          if (ownerId) parents.get(ownerId)!.inventoryItem!.inventoryLevels.nodes.push(l as never);
        }
        return order.map((id) => parents.get(id)!);
      },
    },
    children: [{ path: ["inventoryItem", "inventoryLevels", "nodes"], limit: 10 }],
    save: (db, storeId, nodes) => saveInventory(db, storeId, nodes as GqlStock[]),
    webhooks: ["INVENTORY_LEVELS_UPDATE", "INVENTORY_LEVELS_CONNECT"],
    tables: ["inventory_levels"],
    drift: false,
  },
  refunds: {
    label: "refunds",
    scopes: ["read_orders"],
    // Only the orders that have one: a small slice of any store, cheap
    // to page even where the orders themselves went bulk.
    count: `{ ordersCount(query: "${REFUNDED}") { count } }`,
    page: REFUNDS_QUERY,
    root: "orders",
    // A refund's line items are a connection inside a list, which a
    // bulk query is refused for. So this pages, whatever the size, and
    // its page asks for the most Shopify allows.
    bulk: null,
    children: [
      { path: ["refunds"], limit: 50 },
      { path: ["refunds", "*", "refundLineItems", "nodes"], limit: 250 },
    ],
    save: (db, storeId, nodes) => saveRefunds(db, storeId, nodes as GqlRefundedOrder[]),
    // Carried by the orders topics: a refund raises orders/updated,
    // whose payload holds every refund the order has.
    webhooks: [],
    tables: ["refunds"],
    drift: false,
  },
  fulfillments: {
    label: "shipments",
    scopes: ["read_orders"],
    count: `{ ordersCount(query: "${FULFILLED}") { count } }`,
    page: FULFILLMENTS_QUERY,
    root: "orders",
    // Lists of scalars only, so bulk is allowed; the file has no
    // child lines, each order carries its shipments inline.
    bulk: {
      query: `{ orders(query: "${FULFILLED}") { edges { node {
    id
    fulfillments(first: 25) {
      id status displayStatus createdAt updatedAt deliveredAt
      trackingInfo(first: 5) { company number url }
    }
  } } } }`,
      assemble: parentsOnly,
    },
    children: [{ path: ["fulfillments"], limit: 25 }],
    save: (db, storeId, nodes) => saveFulfillments(db, storeId, nodes as GqlFulfilledOrder[]),
    // The order payload carries them too, and the order handler writes
    // them; these two catch a tracking number added after the fact.
    webhooks: ["FULFILLMENTS_CREATE", "FULFILLMENTS_UPDATE"],
    tables: ["fulfillments"],
    drift: false,
  },
} as const satisfies Record<string, ResourceSpec>;

export type Resource = keyof typeof SHOPIFY_RESOURCES;

/**
 * In the order they import. An order's customer and variant links can
 * only be made once those rows exist, and a later pass fills in
 * anything that arrived out of sequence.
 */
export const RESOURCES = Object.keys(SHOPIFY_RESOURCES) as Resource[];

export const isResource = (v: unknown): v is Resource =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(SHOPIFY_RESOURCES, v);

/**
 * Scopes asked for before the resource that will use them exists.
 *
 * The rule everywhere else is that a scope comes from the resource
 * that needs it. This is the one exception, and it earns it: adding
 * a scope means every connected store has to reconnect, and the
 * cheapest moment to do that is while there is one store and it is
 * ours. At fifty merchants the same change is fifty interruptions
 * and fifty people wondering why.
 *
 * So the reads for what is coming are asked for once, now, and each
 * resource lands later against a token that already has them.
 *
 * Every one of these is a read. The list shrinks as the resources
 * arrive: check-shopify fails if a name here is one a resource
 * already asks for, so a scope cannot end up declared twice, and it
 * has to be deleted from here when its resource is written.
 */
export const PLANNED_SCOPES = [] as const;

/** Every read scope any resource needs, once each, in resource order. Read-only by construction. */
export const SHOPIFY_SCOPES: readonly string[] = [
  ...new Set([...RESOURCES.flatMap((r) => SHOPIFY_RESOURCES[r].scopes), ...PLANNED_SCOPES]),
];

/**
 * Orders older than Shopify's default window, which needs Shopify's
 * approval on the app before it can be asked for at all — requesting it
 * unapproved fails the whole authorization, not just that one scope. Set
 * the flag once the grant comes through.
 */
export const EXTENDED_ORDER_HISTORY_SCOPE = "read_all_orders";

/**
 * What the install asks Shopify for: the reads, and what the actions
 * need to change anything.
 *
 * The writes are asked for now, before anything uses them, for the
 * reason 924c2ba asked for the reads early — a new scope means every
 * connected store reconnects, and there is one store today and it is
 * ours. At fifty merchants the same change is fifty interruptions.
 *
 * Holding the permission is not the safeguard and was never meant to
 * be. What stops a change reaching a shop is the account switch,
 * which is off until somebody turns it on, and the merchant's own
 * yes on the card — both of which are checked, and neither of which
 * a reconnect can grant by accident.
 */
export function scopesFor(env = process.env): string[] {
  const asked = [...new Set([...SHOPIFY_SCOPES, ...ACTION_SCOPES])];
  return env.SHOPIFY_READ_ALL_ORDERS === "true" ? [...asked, EXTENDED_ORDER_HISTORY_SCOPE] : asked;
}

/**
 * What the install asks for that this token was never given.
 *
 * `granted` is stores.granted_scopes: the list Shopify reported when it
 * handed the token over. Null means the grant predates that column, so
 * nothing is known about it — and an unknown grant reports nothing
 * missing rather than everything, because the store in front of you is
 * demonstrably working and sending its owner to reconnect for scopes
 * they may already hold is worse than staying quiet.
 */
export function missingScopes(granted: readonly string[] | null | undefined, env = process.env): string[] {
  if (!granted || granted.length === 0) return [];
  return scopesFor(env).filter((s) => !granted.includes(s));
}

/** Every webhook topic any resource listens for. */
export const WEBHOOK_TOPICS: readonly string[] = RESOURCES.flatMap((r) => SHOPIFY_RESOURCES[r].webhooks);

/** Every list found at `path` below `node`. A "*" step looks inside each element of a list. */
const listsAt = (node: unknown, path: readonly string[]): unknown[][] => {
  let cur: unknown[] = [node];
  for (const step of path) {
    cur = cur.flatMap((n) => {
      if (n === null || typeof n !== "object") return [];
      if (step === "*") return Array.isArray(n) ? n : [];
      return [(n as Record<string, unknown>)[step]];
    });
  }
  return cur.filter(Array.isArray) as unknown[][];
};

/**
 * Whether a page lost children to a limit.
 *
 * These are limits, not sizes. A product with more than a hundred
 * variants, an order with more than a hundred lines, a variant stocked
 * in more than ten places — the paged route asks for that many and
 * Shopify stops there, silently, and the rest was simply lost.
 *
 * ponytail: a page holding exactly the limit is treated as truncated
 * even when it is merely full. That costs one unnecessary bulk run on
 * a store where some product has exactly a hundred variants, and buys
 * not having to ask Shopify a second question per child.
 */
export function childrenWereCut(resource: Resource, nodes: unknown[]): boolean {
  return SHOPIFY_RESOURCES[resource].children.some(({ path, limit }) =>
    nodes.some((n) => listsAt(n, path).some((list) => list.length >= limit))
  );
}

/**
 * One page of one resource, then say whether there is more.
 *
 * The cut is checked BEFORE saving. saveOrders replaces an order's
 * lines rather than merging them — it has to, or a line deleted in
 * Shopify would live here for ever — so writing a page whose orders
 * were cut at a hundred lines would delete the real lines and put
 * back only the first hundred. The bulk route is about to fetch the
 * whole thing anyway; a page left untouched is still right.
 */
/**
 * The page a resource's root names, which is not always at the top.
 *
 * Most lists are one step down — `data.orders`. Payouts are two:
 * they hang off the shop's Shopify Payments account, and a shop
 * without one has no account object at all rather than an empty
 * list. Null at any step is that case, and the caller reads it as
 * zero rows instead of crashing on a property of null.
 */
export function pageAt(
  data: unknown,
  root: string
): { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: unknown[] } | null {
  let node: unknown = data;
  for (const step of root.split(".")) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[step];
  }
  if (node === null || typeof node !== "object") return null;
  const page = node as { pageInfo?: unknown; nodes?: unknown };
  // A page without its two halves is not a page. Shopify has never
  // sent one, and reading it as zero rows beats reading `undefined`
  // as a length.
  if (!Array.isArray(page.nodes) || !page.pageInfo) return null;
  return page as { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: unknown[] };
}

export async function importPage(
  db: SupabaseClient,
  store: StoreToken,
  resource: Resource,
  after: string | null
): Promise<{
  imported: number;
  cursor: string | null;
  hasNext: boolean;
  /** This page lost children to a limit; only bulk can carry them. */
  cut?: boolean;
}> {
  // Renewed here rather than by each caller: every path into Shopify
  // goes through this function, so one caller cannot forget.
  const token = await ensureFreshToken(db, store);
  const spec = SHOPIFY_RESOURCES[resource];
  const data = await graphql<
    Record<string, { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: unknown[] }>
  >(store.shop_domain, token, spec.page, { n: PAGE, after });
  const at = pageAt(data, spec.root);
  // Null the whole way down is a real answer, not a failure: a shop
  // with no Shopify Payments has no account object to hang payouts
  // off, which is most shops in most countries.
  if (!at) return { imported: 0, cursor: null, hasNext: false };
  const { nodes, pageInfo } = at;
  if (nodes.length === 0) return { imported: 0, cursor: pageInfo.endCursor, hasNext: false };
  // A cut is only worth reporting where there is a bulk road to take.
  if (spec.bulk && childrenWereCut(resource, nodes)) return { imported: 0, cursor: after, hasNext: true, cut: true };
  await spec.save(db, store.id, nodes);
  return { imported: nodes.length, cursor: pageInfo.endCursor, hasNext: pageInfo.hasNextPage };
}
