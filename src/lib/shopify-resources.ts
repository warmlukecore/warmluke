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

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOMERS_QUERY,
  ensureFreshToken,
  FULFILLED,
  FULFILLMENTS_QUERY,
  graphql,
  INVENTORY_QUERY,
  ORDERS_QUERY,
  PAGE,
  PRODUCTS_QUERY,
  REFUNDED,
  REFUNDS_QUERY,
  saveCustomers,
  saveFulfillments,
  saveInventory,
  saveOrders,
  saveProducts,
  saveRefunds,
  type GqlCustomer,
  type GqlFulfilledOrder,
  type GqlOrder,
  type GqlProduct,
  type GqlRefundedOrder,
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
    variants { edges { node { id title sku barcode price updatedAt inventoryItem { id } } } }
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
    ],
    save: (db, storeId, nodes) => saveOrders(db, storeId, nodes as GqlOrder[]),
    webhooks: ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "ORDERS_PAID", "ORDERS_FULFILLED"],
    tables: ["orders", "order_line_items", "refunds"],
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
      quantities(names: ["available"]) { quantity }
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

/** Every read scope any resource needs, once each, in resource order. Read-only by construction. */
export const SHOPIFY_SCOPES: readonly string[] = [
  ...new Set(RESOURCES.flatMap((r) => SHOPIFY_RESOURCES[r].scopes)),
];

/**
 * Orders older than Shopify's default window, which needs Shopify's
 * approval on the app before it can be asked for at all — requesting it
 * unapproved fails the whole authorization, not just that one scope. Set
 * the flag once the grant comes through.
 */
export const EXTENDED_ORDER_HISTORY_SCOPE = "read_all_orders";

/** What the install asks Shopify for. */
export function scopesFor(env = process.env): string[] {
  return env.SHOPIFY_READ_ALL_ORDERS === "true"
    ? [...SHOPIFY_SCOPES, EXTENDED_ORDER_HISTORY_SCOPE]
    : [...SHOPIFY_SCOPES];
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
  const { nodes, pageInfo } = data[spec.root];
  if (nodes.length === 0) return { imported: 0, cursor: pageInfo.endCursor, hasNext: false };
  // A cut is only worth reporting where there is a bulk road to take.
  if (spec.bulk && childrenWereCut(resource, nodes)) return { imported: 0, cursor: after, hasNext: true, cut: true };
  await spec.save(db, store.id, nodes);
  return { imported: nodes.length, cursor: pageInfo.endCursor, hasNext: pageInfo.hasNextPage };
}
