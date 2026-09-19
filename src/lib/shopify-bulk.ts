// ─────────────────────────────────────────────────────────────
// Importing a store that is actually big.
//
// Paging works and is the right thing for a store with a few thousand
// rows. It does not survive a million: at 50 rows a request it is
// twenty thousand round trips, hours of wall clock, and a browser tab
// that has to stay open for all of it.
//
// Shopify's answer is to run the query on their side and hand back a
// file. One request starts it, one says when it is done, and the file
// is read in slices — so the work per HTTP request stays bounded no
// matter how large the store is, which is the only property that
// matters on a serverless runtime.
//
// The file is JSONL, one object per line, children flattened out and
// tied to their parent by __parentId. Reassembling them here means the
// same node shapes the paged importer produces, so both write through
// the same savers in lib/shopify-import.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { ShopifyError } from "@/lib/shopify";
import {
  graphql,
  saveCustomers,
  saveInventory,
  saveOrders,
  saveProducts,
  type GqlCustomer,
  type GqlOrder,
  type GqlProduct,
  type GqlStock,
  type Resource,
} from "@/lib/shopify-import";

/**
 * Above this many rows, paging is the wrong tool. Below it, a bulk
 * operation's start-up costs more than the whole import — Shopify
 * queues it, runs it, writes a file, and only then is there anything
 * to read.
 */
// ponytail: a knob, because the right number depends on a store's
// shape rather than on anything measurable from here — and because a
// path that only runs on somebody else's million rows is a path that
// never gets tested. Set it to 0 to take the bulk route always.
export const BULK_THRESHOLD = Number(process.env.SHOPIFY_BULK_THRESHOLD ?? 250);

/** How much of the file to read per request. */
const SLICE = 2 * 1024 * 1024;

/** The ceiling when one family needs more than a slice to complete. */
const MAX_SLICE = 32 * 1024 * 1024;

/** Parents held before writing. Large enough to be worth a round trip. */
const BATCH = 250;

/** Counting is one cheap query and decides which importer to use. */
const COUNTS: Record<Resource, string> = {
  products: "{ productsCount { count } }",
  customers: "{ customersCount { count } }",
  orders: "{ ordersCount { count } }",
  inventory: "{ productVariantsCount { count } }",
};

export async function countOf(shop: string, token: string, resource: Resource): Promise<number> {
  const data = await graphql<Record<string, { count: number } | null>>(
    shop,
    token,
    COUNTS[resource]
  );
  const first = Object.values(data)[0];
  return first?.count ?? 0;
}

// The same fields the paged queries ask for. Bulk forbids pagination
// arguments and returns every node, so the only difference is what is
// missing here.
const BULK_QUERIES: Record<Resource, string> = {
  products: `{ products { edges { node {
    id title handle status productType vendor tags updatedAt
    variants { edges { node { id title sku barcode price updatedAt inventoryItem { id } } } }
  } } } }`,
  customers: `{ customers { edges { node {
    id displayName email phone numberOfOrders tags updatedAt
    amountSpent { amount currencyCode }
    defaultAddress { city zip }
  } } } }`,
  orders: `{ orders { edges { node {
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
  inventory: `{ productVariants { edges { node {
    id
    inventoryItem { id inventoryLevels { edges { node {
      quantities(names: ["available"]) { quantity }
      location { id name }
    } } } }
  } } } }`,
};

type BulkOp = {
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: string | null;
  url: string | null;
};

/** Starts one, and hands back its id. */
export async function startBulk(shop: string, token: string, resource: Resource): Promise<string> {
  const data = await graphql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    shop,
    token,
    // groupObjects, because every reader below assumes a child is
    // written next to its parent. Shopify changed that default to
    // false in 2026-01, so leaving it out means a file whose lines are
    // in no particular order — and a parent whose children arrive
    // after it has already been written.
    `mutation($q: String!) {
       bulkOperationRunQuery(query: $q, groupObjects: true) {
         bulkOperation { id status }
         userErrors { field message }
       }
     }`,
    { q: BULK_QUERIES[resource] }
  );
  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (!bulkOperation) {
    // A store can only run one at a time, and being told so is not a
    // failure — the caller waits for the one already going.
    throw new ShopifyError("bulk_refused", userErrors.map((e) => e.message).join("; "));
  }
  return bulkOperation.id;
}

/**
 * The operation we started, asked for by name.
 *
 * This used to ask for currentBulkOperation — the most recent one —
 * and compare its id afterwards. Shopify now allows five at once, so
 * the most recent is often somebody else's and ours would look like it
 * had vanished.
 */
export async function pollBulk(shop: string, token: string, id: string): Promise<BulkOp | null> {
  const data = await graphql<{ node: BulkOp | null }>(
    shop,
    token,
    `query($id: ID!) {
       node(id: $id) {
         ... on BulkOperation { id status errorCode objectCount url }
       }
     }`,
    { id }
  );
  return data.node;
}

/** A line of the file: an object, plus where it hangs if it is a child. */
type Line = Record<string, unknown> & { id?: string; __parentId?: string };

/**
 * Reads one slice of the file and writes what it finds.
 *
 * Returns the offset to resume from. A slice almost never ends on a
 * line boundary, so the trailing fragment is left unread rather than
 * guessed at — the next call starts at its first byte.
 */
export async function ingestSlice(
  db: SupabaseClient,
  storeId: string,
  resource: Resource,
  url: string,
  offset: number
): Promise<{ nextOffset: number; done: boolean; imported: number }> {
  // Reads forward until there is at least one complete family, rather
  // than assuming one request returns everything asked for. A server
  // is allowed to answer a range with less of it, and a parent may
  // have more children than a single read holds; both look the same
  // from here and both are answered by reading on.
  let text = "";
  let atEnd = false;

  while (Buffer.byteLength(text) < MAX_SLICE) {
    const from = offset + Buffer.byteLength(text);
    const res = await fetch(url, { headers: { Range: `bytes=${from}-${from + SLICE - 1}` } });
    // 416 means the offset is past the end of the file.
    if (res.status === 416) {
      atEnd = true;
      break;
    }
    if (!res.ok && res.status !== 206) {
      throw new ShopifyError("bulk_unreadable", `The result file answered ${res.status}.`);
    }
    const chunk = await res.text();
    if (chunk.length === 0) {
      atEnd = true;
      break;
    }
    text += chunk;

    const range = res.headers.get("content-range");
    const total = range ? Number(range.split("/")[1]) : NaN;
    atEnd = Number.isFinite(total)
      ? offset + Buffer.byteLength(text) >= total
      : Buffer.byteLength(chunk) < SLICE;

    if (atEnd || hasWholeFamily(text)) break;
  }

  if (text.length === 0) return { nextOffset: offset, done: true, imported: 0 };

  const lastBreak = text.lastIndexOf("\n");
  const whole = atEnd ? text : lastBreak >= 0 ? text.slice(0, lastBreak + 1) : "";
  const raw = whole.split("\n").filter((l) => l.trim());

  // Cut at the last parent, not the last line. A parent and its
  // children are contiguous in the file, so a slice ending in the
  // middle of a family would write the parent and silently drop the
  // children that had not arrived yet — an import that looks complete
  // and has no variants in it.
  let take = raw.length;
  if (!atEnd) {
    take = lastParent(raw);
    if (take === 0) {
      throw new ShopifyError(
        "bulk_row_too_large",
        "One row in the result file is larger than the importer can read in one go."
      );
    }
  }

  const lines = raw.slice(0, take).map((l) => JSON.parse(l) as Line);
  const consumed =
    take === raw.length && atEnd
      ? Buffer.byteLength(text)
      : Buffer.byteLength(raw.slice(0, take).join("\n") + "\n");

  const imported = await writeLines(db, storeId, resource, lines);
  return { nextOffset: offset + consumed, done: atEnd, imported };
}

/** Index of the last top-level line — where a batch can safely stop. */
function lastParent(raw: string[]): number {
  for (let i = raw.length - 1; i >= 0; i--) {
    if (!(JSON.parse(raw[i]) as Line).__parentId) return i;
  }
  return 0;
}

/** Is there a complete family in what has been read so far? */
function hasWholeFamily(text: string): boolean {
  const lastBreak = text.lastIndexOf("\n");
  if (lastBreak < 0) return false;
  return lastParent(text.slice(0, lastBreak + 1).split("\n").filter((l) => l.trim())) > 0;
}

/**
 * Reassembles the flattened file into the shapes the savers expect.
 *
 * Shopify writes a child after its parent, and the batching below is
 * why a million-row file costs the same memory as a thousand-row one.
 */
async function writeLines(
  db: SupabaseClient,
  storeId: string,
  resource: Resource,
  lines: Line[]
): Promise<number> {
  if (resource === "customers") {
    const rows = lines.filter((l) => !l.__parentId) as unknown as GqlCustomer[];
    for (let i = 0; i < rows.length; i += BATCH) {
      await saveCustomers(db, storeId, rows.slice(i, i + BATCH));
    }
    return rows.length;
  }

  if (resource === "products") {
    const parents = new Map<string, GqlProduct>();
    const order: string[] = [];
    for (const l of lines) {
      if (!l.__parentId) {
        const p = { ...(l as unknown as GqlProduct), variants: { nodes: [] } };
        parents.set(l.id!, p);
        order.push(l.id!);
      } else {
        // Always present: a slice never ends mid-family.
        parents.get(l.__parentId)?.variants.nodes.push(l as never);
      }
    }
    const rows = order.map((id) => parents.get(id)!);
    for (let i = 0; i < rows.length; i += BATCH) {
      await saveProducts(db, storeId, rows.slice(i, i + BATCH));
    }
    return rows.length;
  }

  if (resource === "orders") {
    const parents = new Map<string, GqlOrder>();
    const order: string[] = [];
    for (const l of lines) {
      if (!l.__parentId) {
        // refunds is a plain list, not a connection, so the file
        // carries it inside the order itself and never as separate
        // __parentId lines. Blanking it here threw away every refund
        // the export had already handed us.
        const parent = l as unknown as GqlOrder;
        parents.set(l.id!, {
          ...parent,
          lineItems: { nodes: [] },
          refunds: parent.refunds ?? [],
        });
        order.push(l.id!);
        continue;
      }
      const parent = parents.get(l.__parentId);
      if (!parent) continue;
      // Refunds carry an amount; line items carry a quantity. The file
      // does not label which connection a child came from.
      if ("totalRefundedSet" in l) parent.refunds!.push(l as never);
      else parent.lineItems.nodes.push(l as never);
    }
    const rows = order.map((id) => parents.get(id)!);
    for (let i = 0; i < rows.length; i += BATCH) {
      await saveOrders(db, storeId, rows.slice(i, i + BATCH));
    }
    return rows.length;
  }

  // Inventory. Levels hang off the variant or off its inventory item
  // depending on how Shopify flattened it, so both are resolved.
  const parents = new Map<string, GqlStock>();
  const order: string[] = [];
  const viaItem = new Map<string, string>();
  for (const l of lines) {
    if (!l.__parentId) {
      const item = l.inventoryItem as { id?: string } | undefined;
      const v: GqlStock = {
        id: l.id!,
        inventoryItem: { inventoryLevels: { nodes: [] } },
      };
      parents.set(l.id!, v);
      order.push(l.id!);
      if (item?.id) viaItem.set(item.id, l.id!);
      continue;
    }
    const ownerId = parents.has(l.__parentId) ? l.__parentId : viaItem.get(l.__parentId);
    if (ownerId) parents.get(ownerId)!.inventoryItem!.inventoryLevels.nodes.push(l as never);
  }
  const rows = order.map((id) => parents.get(id)!);
  for (let i = 0; i < rows.length; i += BATCH) {
    await saveInventory(db, storeId, rows.slice(i, i + BATCH));
  }
  return rows.length;
}
