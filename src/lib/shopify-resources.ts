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
  graphql,
  INVENTORY_QUERY,
  ORDERS_QUERY,
  PAGE,
  PRODUCTS_QUERY,
  saveCustomers,
  saveInventory,
  saveOrders,
  saveProducts,
  type GqlCustomer,
  type GqlOrder,
  type GqlProduct,
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
  /** The bulk query: the same fields, no pagination arguments. */
  bulk: string;
  /**
   * Children a page may lose to its limit. A page holding exactly the
   * limit is treated as cut and the resource goes the bulk way, which
   * asks for children with no limit at all.
   */
  children: readonly ChildLimit[];
  /** Puts a bulk file's flattened lines back into the nodes the saver expects. */
  assemble: (lines: BulkLine[]) => unknown[];
  /** Writes a batch of nodes, from a page or a bulk file alike. */
  save: (db: SupabaseClient, storeId: string, nodes: unknown[]) => Promise<void>;
  /** Webhook topics that keep it fresh between imports. Each has a handler in abo_shopify_webhook. */
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
    bulk: `{ products { edges { node {
    id title handle status productType vendor tags updatedAt
    variants { edges { node { id title sku barcode price updatedAt inventoryItem { id } } } }
  } } } }`,
    children: [{ path: ["variants", "nodes"], limit: 100 }],
    assemble: (lines) =>
      withChildren<GqlProduct>(
        lines,
        (p) => ({ ...(p as unknown as GqlProduct), variants: { nodes: [] } }),
        (p, child) => p.variants.nodes.push(child as never)
      ),
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
    bulk: `{ customers { edges { node {
    id displayName email phone numberOfOrders tags updatedAt
    amountSpent { amount currencyCode }
    defaultAddress { city zip }
  } } } }`,
    children: [],
    assemble: parentsOnly,
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
    bulk: `{ orders { edges { node {
    id name createdAt updatedAt cancelledAt tags
    displayFinancialStatus displayFulfillmentStatus
    totalPriceSet { shopMoney { amount currencyCode } }
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    customer { id }
    lineItems { edges { node {
      id title quantity sku
      variant { id }
      product { id }
      originalUnitPriceSet { shopMoney { amount } }
    } } }
    refunds { id createdAt totalRefundedSet { shopMoney { amount } } }
  } } } }`,
    children: [
      { path: ["lineItems", "nodes"], limit: 100 },
      { path: ["refunds"], limit: 20 },
    ],
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
          if ("totalRefundedSet" in child) o.refunds!.push(child as never);
          else o.lineItems.nodes.push(child as never);
        }
      ),
    save: (db, storeId, nodes) => saveOrders(db, storeId, nodes as GqlOrder[]),
    webhooks: ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "ORDERS_PAID", "ORDERS_FULFILLED"],
    tables: ["orders", "order_line_items", "refunds"],
    drift: true,
  },
  inventory: {
    label: "inventory",
    // The level names its location, which is the locations scope.
    scopes: ["read_inventory", "read_locations"],
    count: "{ productVariantsCount { count } }",
    page: INVENTORY_QUERY,
    root: "productVariants",
    bulk: `{ productVariants { edges { node {
    id
    inventoryItem { id inventoryLevels { edges { node {
      quantities(names: ["available"]) { quantity }
      location { id name }
    } } } }
  } } } }`,
    children: [{ path: ["inventoryItem", "inventoryLevels", "nodes"], limit: 10 }],
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
    save: (db, storeId, nodes) => saveInventory(db, storeId, nodes as GqlStock[]),
    webhooks: ["INVENTORY_LEVELS_UPDATE", "INVENTORY_LEVELS_CONNECT"],
    tables: ["inventory_levels"],
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

const dig = (node: unknown, path: readonly string[]): unknown[] | null => {
  let cur: unknown = node;
  for (const step of path) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[step];
  }
  return Array.isArray(cur) ? cur : null;
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
    nodes.some((n) => (dig(n, path)?.length ?? 0) >= limit)
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
  if (childrenWereCut(resource, nodes)) return { imported: 0, cursor: after, hasNext: true, cut: true };
  await spec.save(db, store.id, nodes);
  return { imported: nodes.length, cursor: pageInfo.endCursor, hasNext: pageInfo.hasNextPage };
}
