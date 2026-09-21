// ─────────────────────────────────────────────────────────────
// Pulling a store into the canonical tables.
//
// GraphQL rather than REST: the REST order and customer endpoints are
// refused outright without protected-customer-data approval, because a
// REST order carries the customer whether you wanted it or not. GraphQL
// asks for named fields, so a store connects and reports useful numbers
// while that approval is still pending.
//
// Every call does one bounded page and writes down where it stopped. A
// serverless request dies at five minutes and a real store has tens of
// thousands of rows, so the only import that finishes is one that can be
// resumed rather than restarted.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { isTransient } from "@/lib/retry";
import {
  SHOPIFY_API_VERSION,
  ShopifyError,
  grantedScopes,
  refreshAccessToken,
  tokenNeedsRefresh,
} from "@/lib/shopify";

/** What the token functions below need off a store row. */
export type StoreToken = {
  id: string;
  shop_domain: string;
  access_token: string;
  refresh_token?: string | null;
  token_expires_at?: string | null;
};

/**
 * Returns a token Shopify will still accept, renewing it if it is about
 * to expire.
 *
 * Shopify no longer accepts non-expiring tokens, and an expiring one
 * lasts an hour — shorter than some imports. Called before each page
 * rather than once per import, because a run that outlives the hour
 * would otherwise start failing halfway through with rows already in.
 *
 * A store with no expiry recorded was connected before any of this and
 * cannot be renewed: it is told to reconnect rather than retried.
 */
export async function ensureFreshToken(
  db: SupabaseClient,
  store: StoreToken,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  if (!tokenNeedsRefresh(store.token_expires_at)) return store.access_token;

  // Two different problems that used to give the same answer. Only one
  // of them is the merchant's to fix, and telling them to reconnect a
  // store whose grant is fine — because this process simply has no app
  // credentials — sends them to do work that cannot help.
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new ShopifyError(
      "not_configured",
      "Shopify isn't configured here, so the access token can't be renewed."
    );
  }
  if (!store.refresh_token) {
    throw new ShopifyError(
      "reconnect_required",
      "Shopify's access to this store has expired. Connect the store again."
    );
  }

  const grant = await refreshAccessToken({
    shop: store.shop_domain,
    clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET,
    refreshToken: store.refresh_token,
  });

  // Every refresh returns a new refresh token as well, and the old one
  // stops working — storing only the access token would mean the next
  // renewal fails and the merchant is asked to reconnect for nothing.
  const now = Date.now();
  const renewed = grantedScopes(grant.scope);
  await db
    .from("stores")
    .update({
      access_token: grant.access_token,
      refresh_token: grant.refresh_token ?? store.refresh_token,
      token_expires_at: grant.expires_in
        ? new Date(now + grant.expires_in * 1000).toISOString()
        : null,
      ...(grant.refresh_token_expires_in
        ? {
            refresh_token_expires_at: new Date(
              now + grant.refresh_token_expires_in * 1000
            ).toISOString(),
          }
        : {}),
      // A renewal reports the same scopes the connect did, which is
      // what fills this in for a store connected before the column
      // existed — without asking anybody to reconnect for it. Omitted
      // rather than nulled when the response is silent about them:
      // writing null would erase a list the connect had recorded.
      ...(renewed ? { granted_scopes: renewed } : {}),
    })
    .eq("id", store.id);

  return grant.access_token;
}

/** One page. Small enough to finish, large enough not to crawl. */
export const PAGE = 50;

// Which resources there are, how each is counted, paged, bulk-exported,
// kept fresh and written: src/lib/shopify-resources.ts, declared once.
// This file holds the queries and the savers those declarations point
// at — the shape of each resource, not the list of them.

/**
 * How many times a page is attempted before the failure is real.
 *
 * Shopify meters the Admin API with a leaky bucket: an import that is
 * going at any speed WILL be throttled, and being throttled is not an
 * error — it is the API asking you to wait. Treating it as one is what
 * stopped an import halfway and left a merchant pressing "Try again"
 * to finish their own stock levels.
 *
 * Three attempts fit inside the route's 60s budget even at the longest
 * wait below.
 */
const ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shopify says how much of the bucket is left and how fast it refills,
 * so the wait can be the real one rather than a guess. Falls back to
 * doubling when it says nothing.
 */
function waitFor(
  attempt: number,
  cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } },
  retryAfter?: string | null
): number {
  const header = Number(retryAfter);
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 10_000);

  const need = cost?.requestedQueryCost ?? 0;
  const have = cost?.throttleStatus?.currentlyAvailable ?? 0;
  const rate = cost?.throttleStatus?.restoreRate ?? 0;
  if (need > have && rate > 0) {
    return Math.min(Math.ceil(((need - have) / rate) * 1000) + 250, 10_000);
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

export async function graphql<T>(
  shop: string,
  token: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  let last: unknown;
  let pause = 0;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(pause);

    let res: Response;
    try {
      res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      // A dropped connection mid-import is the commonest failure of
      // all and says nothing about the request.
      last = new ShopifyError("shopify_unavailable", `Could not reach Shopify: ${
        e instanceof Error ? e.message : "network error"
      }.`);
      pause = waitFor(attempt);
      continue;
    }

    if (!res.ok) {
      const err = new ShopifyError("shopify_unavailable", `Shopify answered ${res.status}.`);
      // 4xx other than 429 is this request being wrong; asking again
      // changes nothing and hides the reason.
      if (!isTransient(err)) throw err;
      last = err;
      pause = waitFor(attempt, undefined, res.headers.get("retry-after"));
      continue;
    }

    const body = (await res.json()) as {
      data?: T;
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
      extensions?: { cost?: Parameters<typeof waitFor>[1] };
    };

    if (body.errors?.length) {
      // A throttle arrives as a 200 with an error in the body, which
      // is why checking res.ok alone was never enough.
      const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
      const err = new ShopifyError(
        throttled ? "shopify_throttled" : "shopify_rejected",
        body.errors.map((e) => e.message).join("; ")
      );
      if (!throttled) throw err;
      last = err;
      pause = waitFor(attempt, body.extensions?.cost, res.headers.get("retry-after"));
      continue;
    }

    if (!body.data) throw new ShopifyError("shopify_empty", "Shopify returned no data.");
    return body.data;
  }

  throw last ?? new ShopifyError("shopify_unavailable", "Shopify did not answer.");
}

const money = (m?: { shopMoney?: { amount?: string } } | null) =>
  m?.shopMoney?.amount ? Number(m.shopMoney.amount) : null;

// ── Products and their variants ─────────────────────────────────
export const PRODUCTS_QUERY = `
query($n: Int!, $after: String) {
  products(first: $n, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle status productType vendor tags updatedAt
      variants(first: 100) {
        nodes { id title sku barcode price updatedAt inventoryItem { id tracked unitCost { amount } } }
      }
    }
  }
}`;

export type GqlProduct = {
  id: string; title: string; handle: string; status: string; tags: string[]; updatedAt: string;
  // What a merchant calls a category, and who it came from.
  productType?: string | null; vendor?: string | null;
  variants: {
    nodes: Array<{
      id: string; title: string; sku: string | null; barcode: string | null;
      price: string; updatedAt: string;
      // Carried so a stock webhook, which names the item and not the
      // variant, can find the row it belongs to.
      //
      // unitCost is what the merchant paid for it, and the only thing
      // in the whole import that turns "what did we sell" into "what
      // did we make". Empty until they enter it in Shopify, which
      // many never do — so a margin is offered when it is there and
      // never guessed when it is not.
      inventoryItem?: { id: string; tracked?: boolean; unitCost?: { amount: string } | null } | null;
    }>;
  };
};

/**
 * Writes a batch of products and their variants.
 *
 * Split from the fetch so the bulk importer, which gets the same nodes
 * out of a JSONL file rather than a page, writes them through exactly
 * this code. Two ways in, one set of rules about what a row looks
 * like — a second copy would drift the first time a column moved.
 */
export async function saveProducts(
  db: SupabaseClient, storeId: string, nodes: GqlProduct[]
): Promise<void> {
  if (nodes.length === 0) return;
  const { data: saved, error } = await db
    .from("products")
    .upsert(
      nodes.map((p) => ({
        store_id: storeId, external_id: p.id, title: p.title, handle: p.handle,
        status: p.status,
        // Shopify sends "" for a product with no type; a blank is not
        // a category, and a dropdown offering one helps nobody.
        product_type: p.productType?.trim() || null,
        vendor: p.vendor?.trim() || null,
        tags: p.tags ?? [], updated_at: p.updatedAt,
      })),
      { onConflict: "store_id,external_id" }
    )
    .select("id, external_id");
  if (error) throw new Error(error.message);

  const byExternal = new Map((saved ?? []).map((r) => [r.external_id as string, r.id as string]));
  const variants = nodes.flatMap((p) =>
    p.variants.nodes.map((v) => ({
      store_id: storeId, product_id: byExternal.get(p.id) ?? null, external_id: v.id,
      title: v.title, sku: v.sku, barcode: v.barcode,
      price: v.price ? Number(v.price) : null,
      cost: v.inventoryItem?.unitCost?.amount ? Number(v.inventoryItem.unitCost.amount) : null,
      // A variant Shopify does not count stock for reads zero
      // everywhere, which looks like "out of stock" and is not.
      tracked: v.inventoryItem?.tracked ?? null,
      inventory_item_id: v.inventoryItem?.id ?? null,
      updated_at: v.updatedAt,
    }))
  );
  if (variants.length > 0) {
    const { error: ve } = await db.from("variants").upsert(variants, { onConflict: "store_id,external_id" });
    if (ve) throw new Error(ve.message);
  }
}

// ── Carts nobody finished ───────────────────────────────────────
// The shop's near misses: somebody filled a basket, reached the
// checkout and left. Shopify keeps them, with a link that takes that
// person back to their own basket, and the copy has never held one —
// so the most answerable question in retail, "who nearly bought",
// could not be asked here at all.
//
// These carry an email, which makes them personal data. Everything
// about redaction that applies to a customer applies to these: the
// tombstone, the trigger that refuses a redacted person coming back,
// and the lock the two share. See migration 0101.
export const CARTS_QUERY = `
query($n: Int!, $after: String) {
  abandonedCheckouts(first: $n, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id abandonedCheckoutUrl createdAt updatedAt
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { id displayName email }
      lineItems(first: 20) { nodes { title quantity } }
    }
  }
}`;

export type GqlCart = {
  id: string;
  abandonedCheckoutUrl?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  totalPriceSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
  customer?: { id?: string | null; displayName?: string | null; email?: string | null } | null;
  lineItems: { nodes: Array<{ title: string; quantity: number }> };
};

/** Writes a batch of abandoned carts. */
export async function saveCarts(
  db: SupabaseClient, storeId: string, nodes: GqlCart[]
): Promise<void> {
  if (nodes.length === 0) return;

  // Linked to the customer row when we hold one, and still written
  // when we do not: a cart left by somebody who never finished an
  // order is exactly the case where there is no customer yet.
  const externalIds = [...new Set(nodes.map((c) => c.customer?.id).filter(Boolean) as string[])];
  const { data: known } = externalIds.length
    ? await db.from("customers").select("id, external_id").eq("store_id", storeId).in("external_id", externalIds)
    : { data: [] };
  const customerId = new Map((known ?? []).map((r) => [r.external_id as string, r.id as string]));

  const rows = nodes.map((c) => {
    const items = c.lineItems?.nodes ?? [];
    return {
      store_id: storeId, external_id: c.id,
      customer_id: c.customer?.id ? (customerId.get(c.customer.id) ?? null) : null,
      // Kept beside the link, because a redaction names a person by
      // Shopify's id and this is the only place a cart carries it.
      customer_external_id: c.customer?.id ?? null,
      name: c.customer?.displayName ?? null,
      email: c.customer?.email ?? null,
      total: c.totalPriceSet?.shopMoney?.amount ? Number(c.totalPriceSet.shopMoney.amount) : null,
      currency: c.totalPriceSet?.shopMoney?.currencyCode ?? null,
      recovery_url: c.abandonedCheckoutUrl ?? null,
      item_count: items.reduce((n, i) => n + (i.quantity ?? 0), 0),
      // A summary rather than a table of its own. What a merchant
      // wants from a basket nobody finished is what was nearly
      // bought, not a normalised record of a thing that never
      // happened.
      items: items.map((i) => (i.quantity > 1 ? `${i.title} ×${i.quantity}` : i.title)).join(", ") || null,
      started_at: c.createdAt,
      updated_at: c.updatedAt ?? c.createdAt,
    };
  });

  const { error } = await db.from("abandoned_checkouts").upsert(rows, { onConflict: "store_id,external_id" });
  if (error) throw new Error(error.message);
}

// ── Collections ─────────────────────────────────────────────────
// A merchant groups their catalogue and then asks about the groups:
// what is in the sale, which collection this product sits in, how
// many are in each. None of that could be answered from a copy that
// held products and nothing about how they are arranged.
export const COLLECTIONS_QUERY = `
query($n: Int!, $after: String) {
  collections(first: $n, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle sortOrder updatedAt
      productsCount { count }
      products(first: 100) { nodes { id } }
    }
  }
}`;

export type GqlCollection = {
  id: string; title: string; handle: string;
  sortOrder?: string | null; updatedAt?: string | null;
  productsCount?: { count: number } | null;
  /** Which products are in it. Cut at a limit on the paged road. */
  products: { nodes: Array<{ id: string }> };
};

/** Writes a batch of collections and what is in them. */
export async function saveCollections(
  db: SupabaseClient, storeId: string, nodes: GqlCollection[]
): Promise<void> {
  if (nodes.length === 0) return;

  const { data: saved, error } = await db
    .from("collections")
    .upsert(
      nodes.map((c) => ({
        store_id: storeId, external_id: c.id, title: c.title, handle: c.handle,
        sort_order: c.sortOrder ?? null,
        // Shopify's own count, which is the whole collection even when
        // this page carried only the first hundred of it.
        products_count: c.productsCount?.count ?? null,
        updated_at: c.updatedAt ?? new Date().toISOString(),
      })),
      { onConflict: "store_id,external_id" }
    )
    .select("id, external_id");
  if (error) throw new Error(error.message);
  const collectionId = new Map((saved ?? []).map((r) => [r.external_id as string, r.id as string]));

  // Products may not be imported yet: a membership pointing at one we
  // do not hold is dropped rather than invented, and the next pass
  // picks it up once the product is there.
  const productIds = [...new Set(nodes.flatMap((c) => c.products.nodes.map((p) => p.id)))];
  const { data: prows } = productIds.length
    ? await db.from("products").select("id, external_id").eq("store_id", storeId).in("external_id", productIds)
    : { data: [] };
  const productId = new Map((prows ?? []).map((r) => [r.external_id as string, r.id as string]));

  const links = nodes.flatMap((c) =>
    c.products.nodes
      .map((p) => ({
        store_id: storeId,
        collection_id: collectionId.get(c.id)!,
        product_id: productId.get(p.id) ?? null,
      }))
      .filter((l) => l.collection_id && l.product_id)
  );

  // Replaced per collection, not merged: a product taken out of a
  // collection in Shopify has to leave it here too, and no key would
  // notice its absence.
  const touched = nodes.map((c) => collectionId.get(c.id)).filter(Boolean) as string[];
  if (touched.length > 0) {
    await db.from("collection_products").delete().in("collection_id", touched);
  }
  if (links.length > 0) {
    const { error: le } = await db.from("collection_products").insert(links);
    if (le) throw new Error(le.message);
  }
}

// ── Customers ───────────────────────────────────────────────────
// Name, email, phone and postcode are protected customer data. Where
// Shopify withholds them the row still lands with what it did give, so
// counts and order links stay right and only the contact is missing.
export const CUSTOMERS_QUERY = `
query($n: Int!, $after: String) {
  customers(first: $n, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id displayName email phone numberOfOrders tags updatedAt
      amountSpent { amount currencyCode }
      defaultAddress { city zip }
    }
  }
}`;

export type GqlCustomer = {
  id: string; displayName: string | null; email: string | null; phone: string | null;
  numberOfOrders: string; tags: string[]; updatedAt: string;
  /** Lifetime spend, Shopify's own figure. Absent on old bulk files. */
  amountSpent?: { amount: string; currencyCode: string } | null;
  defaultAddress: { city: string | null; zip: string | null } | null;
};

/** Writes a batch of customers. Shared with the bulk importer. */
export async function saveCustomers(
  db: SupabaseClient, storeId: string, nodes: GqlCustomer[]
): Promise<void> {
  if (nodes.length > 0) {
    const { error } = await db.from("customers").upsert(
      nodes.map((c) => ({
        store_id: storeId, external_id: c.id, name: c.displayName, email: c.email,
        phone: c.phone, city: c.defaultAddress?.city ?? null, postal_code: c.defaultAddress?.zip ?? null,
        tags: c.tags ?? [], orders_count: Number(c.numberOfOrders ?? 0), updated_at: c.updatedAt,
        total_spent: c.amountSpent?.amount ? Number(c.amountSpent.amount) : null,
      })),
      { onConflict: "store_id,external_id" }
    );
    if (error) throw new Error(error.message);
  }
}

// ── Orders, their lines and refunds ─────────────────────────────
// Line items keep the title and SKU as they were when bought. A product
// renamed or deleted next year must not rewrite what somebody actually
// received last month.
export const ORDERS_QUERY = `
query($n: Int!, $after: String) {
  orders(first: $n, after: $after, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
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
      lineItems(first: 100) {
        nodes {
          id title variantTitle quantity sku
          variant { id }
          product { id }
          originalUnitPriceSet { shopMoney { amount } }
        }
      }
      refunds(first: 20) {
        id createdAt
        totalRefundedSet { shopMoney { amount } }
      }
      transactions(first: 30) {
        id kind status gateway processedAt test
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }
}`;

export type GqlOrder = {
  id: string; name: string; createdAt: string; updatedAt: string; cancelledAt: string | null;
  tags: string[]; displayFinancialStatus: string | null; displayFulfillmentStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  /** What the order comes to today, after refunds. Absent on old bulk files. */
  currentTotalPriceSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
  /**
   * What the total is made of, as it stands today.
   *
   * total = subtotal + shipping + tax, with the discount already
   * taken off the subtotal. Without the parts, "we sold 4,942" is the
   * only sentence possible, and it silently includes tax the merchant
   * owes somebody else and postage they paid a courier for. All four
   * are absent on a bulk file written before this.
   */
  currentSubtotalPriceSet?: { shopMoney: { amount: string } } | null;
  currentTotalTaxSet?: { shopMoney: { amount: string } } | null;
  currentTotalDiscountsSet?: { shopMoney: { amount: string } } | null;
  totalShippingPriceSet?: { shopMoney: { amount: string } } | null;
  customer: { id: string } | null;
  /** What paid: "Cash on Delivery (COD)", or the provider. The first is the one that did. */
  paymentGatewayNames?: string[] | null;
  discountCodes?: string[] | null;
  shippingAddress?: { city: string | null; provinceCode: string | null; countryCode: string | null } | null;
  lineItems: { nodes: Array<{ id: string; title: string; variantTitle?: string | null; quantity: number; sku: string | null;
    variant: { id: string } | null; product: { id: string } | null;
    originalUnitPriceSet: { shopMoney: { amount: string } } | null }> };
  refunds: Array<{ id: string; createdAt: string; totalRefundedSet: { shopMoney: { amount: string } } | null }>;
  /**
   * The money itself, as opposed to what the order says about it.
   *
   * An order reads PAID or PENDING; a transaction says what actually
   * moved, when, through which gateway, and whether it succeeded. On
   * a cash-on-delivery store every order sits at PENDING with a
   * SALE/PENDING transaction against it until the courier is paid,
   * and no status on the order can tell you that apart from money in
   * the bank. Absent on old bulk files.
   */
  transactions?: Array<{
    id: string; kind: string; status: string; gateway: string | null;
    processedAt: string | null; test: boolean;
    amountSet: { shopMoney: { amount: string; currencyCode: string } } | null;
  }> | null;
};

/** Writes a batch of orders, their lines and refunds. */
export async function saveOrders(
  db: SupabaseClient, storeId: string, nodes: GqlOrder[]
): Promise<void> {
  if (nodes.length === 0) return;

  // Customers may not be imported yet, and an order whose customer is
  // missing is still an order — the link fills in on a later pass rather
  // than the order being dropped.
  const externalIds = [...new Set(nodes.map((o) => o.customer?.id).filter(Boolean) as string[])];
  const { data: known } = externalIds.length
    ? await db.from("customers").select("id, external_id").eq("store_id", storeId).in("external_id", externalIds)
    : { data: [] };
  const customerId = new Map((known ?? []).map((c) => [c.external_id as string, c.id as string]));

  const { data: saved, error } = await db
    .from("orders")
    .upsert(
      nodes.map((o) => ({
        store_id: storeId, external_id: o.id, order_number: o.name,
        customer_id: o.customer ? (customerId.get(o.customer.id) ?? null) : null,
        placed_at: o.createdAt,
        // Today's total, after refunds, under the name the webhook has
        // always used for it — and the original beside it. This used
        // to write the original as `total`, so the same order carried
        // a different number depending on which road it last took.
        total: money(o.currentTotalPriceSet ?? o.totalPriceSet),
        total_original: money(o.totalPriceSet),
        // Null, not zero, when the field never came: an old bulk file
        // saying nothing about tax is not a shop that charges none.
        subtotal: money(o.currentSubtotalPriceSet),
        tax: money(o.currentTotalTaxSet),
        discount: money(o.currentTotalDiscountsSet),
        shipping: money(o.totalShippingPriceSet),
        currency: o.totalPriceSet?.shopMoney?.currencyCode ?? null,
        financial_status: o.displayFinancialStatus, fulfilment_status: o.displayFulfillmentStatus,
        cancelled_at: o.cancelledAt, tags: o.tags ?? [], source: "shopify", updated_at: o.updatedAt,
        gateway: o.paymentGatewayNames?.[0] ?? null,
        discount_codes: o.discountCodes ?? [],
        ship_city: o.shippingAddress?.city ?? null,
        ship_state: o.shippingAddress?.provinceCode ?? null,
        ship_country: o.shippingAddress?.countryCode ?? null,
      })),
      { onConflict: "store_id,external_id" }
    )
    .select("id, external_id");
  if (error) throw new Error(error.message);

  const orderId = new Map((saved ?? []).map((r) => [r.external_id as string, r.id as string]));

  const variantIds = [...new Set(nodes.flatMap((o) => o.lineItems.nodes.map((l) => l.variant?.id).filter(Boolean)) as string[])];
  const { data: vrows } = variantIds.length
    ? await db.from("variants").select("id, external_id").eq("store_id", storeId).in("external_id", variantIds)
    : { data: [] };
  const variantId = new Map((vrows ?? []).map((v) => [v.external_id as string, v.id as string]));

  const productIds = [...new Set(nodes.flatMap((o) => o.lineItems.nodes.map((l) => l.product?.id).filter(Boolean)) as string[])];
  const { data: prows } = productIds.length
    ? await db.from("products").select("id, external_id").eq("store_id", storeId).in("external_id", productIds)
    : { data: [] };
  const productId = new Map((prows ?? []).map((p) => [p.external_id as string, p.id as string]));

  const lines = nodes.flatMap((o) =>
    o.lineItems.nodes.map((l) => ({
      store_id: storeId, order_id: orderId.get(o.id)!, external_id: l.id,
      product_id: l.product ? (productId.get(l.product.id) ?? null) : null,
      variant_id: l.variant ? (variantId.get(l.variant.id) ?? null) : null,
      title: l.title, variant_title: l.variantTitle ?? null, sku: l.sku, quantity: l.quantity,
      price: l.originalUnitPriceSet?.shopMoney?.amount ? Number(l.originalUnitPriceSet.shopMoney.amount) : null,
    }))
  ).filter((l) => l.order_id);

  if (lines.length > 0) {
    // Replaced rather than merged: a line removed from an order in
    // Shopify has to disappear here too, and there is no key that would
    // notice its absence.
    const ids = [...new Set(lines.map((l) => l.order_id))];
    await db.from("order_line_items").delete().in("order_id", ids);
    const { error: le } = await db.from("order_line_items").insert(lines);
    if (le) throw new Error(le.message);
  }

  const refunds = nodes.flatMap((o) =>
    (o.refunds ?? []).map((r) => ({
      store_id: storeId, order_id: orderId.get(o.id)!, external_id: r.id,
      amount: r.totalRefundedSet?.shopMoney?.amount ? Number(r.totalRefundedSet.shopMoney.amount) : null,
      // No quantity: that is the refunds pass's to write (below). A
      // row this creates starts at the column's default and is filled
      // in there; a row that already has one keeps it.
      refunded_at: r.createdAt,
    }))
  ).filter((r) => r.order_id);
  if (refunds.length > 0) {
    // On the Shopify id, not on `id` — that is a generated uuid the
    // importer never supplies, so the conflict never matched and every
    // pass inserted the same refunds again.
    const { error: re } = await db
      .from("refunds")
      .upsert(refunds, { onConflict: "store_id,external_id" });
    if (re) throw new Error(re.message);
  }

  const paid = nodes.flatMap((o) =>
    (o.transactions ?? []).map((t) => ({
      store_id: storeId, order_id: orderId.get(o.id)!, external_id: t.id,
      kind: t.kind, status: t.status, gateway: t.gateway ?? null,
      amount: t.amountSet?.shopMoney?.amount ? Number(t.amountSet.shopMoney.amount) : null,
      currency: t.amountSet?.shopMoney?.currencyCode ?? null,
      // A test transaction is not money. Kept rather than dropped, so
      // a merchant looking for the one they made can find it, and
      // excluded from every total by the list that reads them.
      test: t.test === true,
      processed_at: t.processedAt,
    }))
  ).filter((t) => t.order_id);
  if (paid.length > 0) {
    const { error: te } = await db
      .from("order_transactions")
      .upsert(paid, { onConflict: "store_id,external_id" });
    if (te) throw new Error(te.message);
  }
}

// ── Refunds, with how many units went back ──────────────────────
// A refund's line items are a connection inside a list, which a bulk
// query is refused for ("a connection field within a list field").
// So they come by their own page, over only the orders that have a
// refund — a small slice of any store, cheap to page even where the
// orders themselves went bulk.
export const REFUNDED = "financial_status:partially_refunded OR financial_status:refunded";

export const REFUNDS_QUERY = `
query($n: Int!, $after: String) {
  orders(first: $n, after: $after, sortKey: UPDATED_AT, query: "${REFUNDED}") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      refunds(first: 50) {
        id createdAt
        totalRefundedSet { shopMoney { amount } }
        refundLineItems(first: 250) { nodes { quantity } }
      }
    }
  }
}`;

export type GqlRefundedOrder = {
  id: string;
  refunds: Array<{
    id: string; createdAt: string; totalRefundedSet: { shopMoney: { amount: string } } | null;
    refundLineItems: { nodes: Array<{ quantity: number }> };
  }>;
};

/** Writes the refunds of a batch of orders — amount, when, and how many units. */
export async function saveRefunds(
  db: SupabaseClient, storeId: string, nodes: GqlRefundedOrder[]
): Promise<void> {
  const withRefunds = nodes.filter((o) => (o.refunds ?? []).length > 0);
  if (withRefunds.length === 0) return;

  const { data: known } = await db
    .from("orders").select("id, external_id").eq("store_id", storeId)
    .in("external_id", withRefunds.map((o) => o.id));
  const orderId = new Map((known ?? []).map((r) => [r.external_id as string, r.id as string]));

  // An order not imported yet is nothing to hang a refund on. The
  // orders pass writes the refund itself when it gets there, and this
  // pass fills the units in on its next run.
  const refunds = withRefunds.flatMap((o) => {
    const id = orderId.get(o.id);
    if (!id) return [];
    return o.refunds.map((r) => ({
      store_id: storeId, order_id: id, external_id: r.id,
      amount: r.totalRefundedSet?.shopMoney?.amount ? Number(r.totalRefundedSet.shopMoney.amount) : null,
      quantity: (r.refundLineItems?.nodes ?? []).reduce((n, x) => n + (x.quantity ?? 0), 0),
      refunded_at: r.createdAt,
    }));
  });
  if (refunds.length === 0) return;
  const { error } = await db.from("refunds").upsert(refunds, { onConflict: "store_id,external_id" });
  if (error) throw new Error(error.message);
}

// ── Shipments ───────────────────────────────────────────────────
// Shopify calls them fulfillments. They come by their own pass over
// the orders that have one, so a store whose token cannot read them
// loses this list and nothing else.
export const FULFILLED = "fulfillment_status:shipped OR fulfillment_status:partial";

export const FULFILLMENTS_QUERY = `
query($n: Int!, $after: String) {
  orders(first: $n, after: $after, sortKey: UPDATED_AT, query: "${FULFILLED}") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      fulfillments(first: 25) {
        id status displayStatus createdAt updatedAt deliveredAt
        trackingInfo(first: 5) { company number url }
      }
    }
  }
}`;

export type GqlFulfilledOrder = {
  id: string;
  fulfillments: Array<{
    id: string; status: string; displayStatus: string | null;
    createdAt: string; updatedAt: string; deliveredAt: string | null;
    trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }>;
  }>;
};

/** Writes the shipments of a batch of orders — courier, tracking, status. */
export async function saveFulfillments(
  db: SupabaseClient, storeId: string, nodes: GqlFulfilledOrder[]
): Promise<void> {
  const shipped = nodes.filter((o) => (o.fulfillments ?? []).length > 0);
  if (shipped.length === 0) return;

  const { data: known } = await db
    .from("orders").select("id, external_id").eq("store_id", storeId)
    .in("external_id", shipped.map((o) => o.id));
  const orderId = new Map((known ?? []).map((r) => [r.external_id as string, r.id as string]));

  // An order not imported yet is nothing to hang a shipment on; the
  // next pass finds it there.
  const rows = shipped.flatMap((o) => {
    const id = orderId.get(o.id);
    if (!id) return [];
    return o.fulfillments.map((f) => {
      const tracking = f.trackingInfo ?? [];
      return {
        store_id: storeId, order_id: id, external_id: f.id,
        status: f.status ?? null, shipment_status: f.displayStatus ?? null,
        carrier: tracking.find((t) => t.company)?.company ?? null,
        // Several parcels under one shipment carry several numbers.
        tracking_number: tracking.map((t) => t.number).filter(Boolean).join(", ") || null,
        tracking_url: tracking.find((t) => t.url)?.url ?? null,
        shipped_at: f.createdAt, delivered_at: f.deliveredAt ?? null, updated_at: f.updatedAt,
      };
    });
  });
  if (rows.length === 0) return;
  const { error } = await db.from("fulfillments").upsert(rows, { onConflict: "store_id,external_id" });
  if (error) throw new Error(error.message);
}

// ── Where the stock sits ────────────────────────────────────────
// Stock levels have always named their location, so the name was in
// the copy — but only ever as a label on a quantity. Which locations
// exist, which are switched off, and where they actually are was not
// something the app could answer, and "how much is in the Pune
// warehouse" needs the second half.
export const LOCATIONS_QUERY = `
query($n: Int!, $after: String) {
  # Both flags on purpose. locationsCount counts every location a shop
  # has ever had and takes no arguments, while this list hides the
  # inactive and the legacy ones by default. This store has three and
  # showed two: the third is a legacy warehouse still named by old
  # stock rows. Left out, the drift report would say one location is
  # missing from Shopify, for ever, and be wrong every time.
  locations(first: $n, after: $after, includeInactive: true, includeLegacy: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name isActive fulfillsOnlineOrders
      address { address1 city province provinceCode country countryCode zip }
    }
  }
}`;

export type GqlLocation = {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders?: boolean | null;
  address?: {
    address1?: string | null; city?: string | null;
    province?: string | null; provinceCode?: string | null;
    country?: string | null; countryCode?: string | null; zip?: string | null;
  } | null;
};

/** Writes a batch of locations. */
export async function saveLocations(
  db: SupabaseClient, storeId: string, nodes: GqlLocation[]
): Promise<void> {
  if (nodes.length === 0) return;
  const { error } = await db.from("locations").upsert(
    nodes.map((l) => ({
      store_id: storeId, external_id: l.id, name: l.name,
      // A location switched off still holds stock and still appears
      // on old orders, so it is kept and marked rather than dropped.
      active: l.isActive ?? null,
      fulfills_online_orders: l.fulfillsOnlineOrders ?? null,
      address1: l.address?.address1 ?? null,
      city: l.address?.city ?? null,
      province: l.address?.province ?? null,
      province_code: l.address?.provinceCode ?? null,
      country: l.address?.country ?? null,
      country_code: l.address?.countryCode ?? null,
      zip: l.address?.zip ?? null,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "store_id,external_id" }
  );
  if (error) throw new Error(error.message);
}

// ── Stock on hand ───────────────────────────────────────────────
export const INVENTORY_QUERY = `
query($n: Int!, $after: String) {
  productVariants(first: $n, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      inventoryItem {
        inventoryLevels(first: 10) {
          nodes {
            quantities(names: ["available", "on_hand", "committed", "incoming"]) { name quantity }
            location { id name }
          }
        }
      }
    }
  }
}`;

export type GqlStock = {
  id: string;
  inventoryItem: {
    inventoryLevels: {
      nodes: Array<{
        /**
         * Asked for by name and read back by name.
         *
         * Shopify returns them in the order asked, but nothing
         * promises that, and this used to take quantities[0] as
         * "available". One more name in the query and the shop's
         * available stock would quietly have become its committed
         * stock, with every low-stock answer wrong and nothing
         * saying so.
         */
        quantities: Array<{ name?: string; quantity: number }>;
        location: { id?: string; name: string };
      }>;
    };
  } | null;
};

/** One named quantity, or zero. Never by position — see GqlStock. */
const qty = (list: Array<{ name?: string; quantity: number }> | undefined, name: string): number =>
  list?.find((q) => q.name === name)?.quantity ?? 0;

/** Writes a batch of stock levels. */
export async function saveInventory(
  db: SupabaseClient, storeId: string, nodes: GqlStock[]
): Promise<void> {
  const ids = nodes.map((v) => v.id);
  const { data: vrows } = ids.length
    ? await db.from("variants").select("id, external_id").eq("store_id", storeId).in("external_id", ids)
    : { data: [] };
  const variantId = new Map((vrows ?? []).map((v) => [v.external_id as string, v.id as string]));

  const levels = nodes.flatMap((v) =>
    (v.inventoryItem?.inventoryLevels.nodes ?? []).map((l) => ({
      store_id: storeId, variant_id: variantId.get(v.id) ?? null,
      location_id: l.location?.id ?? null,
      location_name: l.location?.name ?? "",
      available: qty(l.quantities, "available"),
      // What is physically there, what is spoken for by orders not
      // yet shipped, and what is on its way. "Available" is on_hand
      // minus committed, so a shop can have stock and be unable to
      // sell it, which is the thing a merchant most wants warning of.
      on_hand: qty(l.quantities, "on_hand"),
      committed: qty(l.quantities, "committed"),
      incoming: qty(l.quantities, "incoming"),
      updated_at: new Date().toISOString(),
    }))
  ).filter((l) => l.variant_id);

  if (levels.length > 0) {
    const { error } = await db.from("inventory_levels").upsert(levels, { onConflict: "store_id,variant_id,location_id" });
    if (error) throw new Error(error.message);
  }
}

// ── Draft orders ────────────────────────────────────────────────
// The sale that did not start in the storefront: a quote sent over
// WhatsApp, an order taken on the phone, a basket built for somebody
// standing in the shop. Open ones are money not yet taken; completed
// ones became real orders, and the link back is what stops the same
// sale being counted twice.
export const DRAFT_ORDERS_QUERY = `
query($n: Int!, $after: String) {
  draftOrders(first: $n, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name status email tags
      createdAt updatedAt completedAt invoiceUrl
      totalPriceSet { shopMoney { amount currencyCode } }
      subtotalPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      customer { id displayName email }
      order { id }
      lineItems(first: 50) {
        nodes {
          id title sku quantity
          variant { id }
          product { id }
          originalUnitPriceSet { shopMoney { amount } }
          discountedUnitPriceSet { shopMoney { amount } }
        }
      }
    }
  }
}`;

/** One line of a draft. Custom items carry no product and no variant. */
export type GqlDraftLine = {
  id?: string | null;
  title?: string | null;
  sku?: string | null;
  quantity?: number | null;
  variant?: { id?: string | null } | null;
  product?: { id?: string | null } | null;
  originalUnitPriceSet?: { shopMoney: { amount: string } } | null;
  discountedUnitPriceSet?: { shopMoney: { amount: string } } | null;
};

export type GqlDraftOrder = {
  id: string;
  name?: string | null;
  status?: string | null;
  email?: string | null;
  tags?: string[] | null;
  createdAt: string;
  updatedAt?: string | null;
  completedAt?: string | null;
  invoiceUrl?: string | null;
  totalPriceSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
  subtotalPriceSet?: { shopMoney: { amount: string } } | null;
  totalTaxSet?: { shopMoney: { amount: string } } | null;
  totalShippingPriceSet?: { shopMoney: { amount: string } } | null;
  customer?: { id?: string | null; displayName?: string | null; email?: string | null } | null;
  /** The order it became. Null while it is still a draft. */
  order?: { id?: string | null } | null;
  lineItems: { nodes: GqlDraftLine[] };
};

/** Writes a batch of draft orders and the lines on them. */
export async function saveDraftOrders(
  db: SupabaseClient, storeId: string, nodes: GqlDraftOrder[]
): Promise<void> {
  if (nodes.length === 0) return;

  // The two things a draft points at that we may already hold. Both
  // are optional: a draft can name somebody who is not a customer
  // yet, and an open one has become no order at all.
  const customerIds = [...new Set(nodes.map((d) => d.customer?.id).filter(Boolean) as string[])];
  const orderIds = [...new Set(nodes.map((d) => d.order?.id).filter(Boolean) as string[])];
  const [people, orders] = await Promise.all([
    customerIds.length
      ? db.from("customers").select("id, external_id").eq("store_id", storeId).in("external_id", customerIds)
      : Promise.resolve({ data: [] as Array<{ id: string; external_id: string }> }),
    orderIds.length
      ? db.from("orders").select("id, external_id").eq("store_id", storeId).in("external_id", orderIds)
      : Promise.resolve({ data: [] as Array<{ id: string; external_id: string }> }),
  ]);
  const customerId = new Map((people.data ?? []).map((r) => [r.external_id, r.id]));
  const orderId = new Map((orders.data ?? []).map((r) => [r.external_id, r.id]));
  const money = (m?: { shopMoney: { amount: string } } | null) =>
    m?.shopMoney?.amount != null ? Number(m.shopMoney.amount) : null;

  const { data: saved, error } = await db
    .from("draft_orders")
    .upsert(
      nodes.map((d) => ({
        store_id: storeId,
        external_id: d.id,
        name: d.name ?? null,
        // Uppercase on both roads, so a draft does not change shape
        // depending on whether an import or a webhook last wrote it.
        status: d.status ? d.status.toUpperCase() : null,
        customer_id: d.customer?.id ? (customerId.get(d.customer.id) ?? null) : null,
        customer_external_id: d.customer?.id ?? null,
        name_on_draft: d.customer?.displayName ?? null,
        // The draft's own address first: a merchant can put one on a
        // draft that has no customer attached at all.
        email: d.email ?? d.customer?.email ?? null,
        total: money(d.totalPriceSet),
        subtotal: money(d.subtotalPriceSet),
        tax: money(d.totalTaxSet),
        shipping: money(d.totalShippingPriceSet),
        currency: d.totalPriceSet?.shopMoney?.currencyCode ?? null,
        tags: d.tags ?? [],
        invoice_url: d.invoiceUrl ?? null,
        order_id: d.order?.id ? (orderId.get(d.order.id) ?? null) : null,
        order_external_id: d.order?.id ?? null,
        drafted_at: d.createdAt,
        completed_at: d.completedAt ?? null,
        updated_at: d.updatedAt ?? d.createdAt,
      })),
      { onConflict: "store_id,external_id" }
    )
    .select("id, external_id");
  if (error) throw new Error(error.message);

  // Whatever came back, which is not always everything sent: the
  // redaction trigger drops a draft naming somebody erased, and its
  // lines must not be written either.
  const draftId = new Map((saved ?? []).map((r) => [r.external_id as string, r.id as string]));
  const kept = nodes.filter((d) => draftId.has(d.id));
  if (kept.length === 0) return;

  // Products and variants the lines point at. A custom item points at
  // neither — #D1 in the dev store is one — and is still a real line
  // on a real draft, so it is written with both left null.
  const productIds = [...new Set(kept.flatMap((d) => d.lineItems?.nodes ?? []).map((l) => l.product?.id).filter(Boolean) as string[])];
  const variantIds = [...new Set(kept.flatMap((d) => d.lineItems?.nodes ?? []).map((l) => l.variant?.id).filter(Boolean) as string[])];
  const [prods, vars] = await Promise.all([
    productIds.length
      ? db.from("products").select("id, external_id").eq("store_id", storeId).in("external_id", productIds)
      : Promise.resolve({ data: [] as Array<{ id: string; external_id: string }> }),
    variantIds.length
      ? db.from("variants").select("id, external_id").eq("store_id", storeId).in("external_id", variantIds)
      : Promise.resolve({ data: [] as Array<{ id: string; external_id: string }> }),
  ]);
  const productId = new Map((prods.data ?? []).map((r) => [r.external_id, r.id]));
  const variantId = new Map((vars.data ?? []).map((r) => [r.external_id, r.id]));

  // Replaced rather than merged, the same as an order's lines: a line
  // the merchant removed in Shopify has to disappear here too, and an
  // upsert alone would leave it behind for ever.
  const ids = kept.map((d) => draftId.get(d.id)!);
  const { error: cleared } = await db.from("draft_order_line_items").delete().in("draft_order_id", ids);
  if (cleared) throw new Error(cleared.message);

  const lines = kept.flatMap((d) =>
    (d.lineItems?.nodes ?? []).map((l) => ({
      store_id: storeId,
      draft_order_id: draftId.get(d.id)!,
      external_id: l.id ?? null,
      product_id: l.product?.id ? (productId.get(l.product.id) ?? null) : null,
      variant_id: l.variant?.id ? (variantId.get(l.variant.id) ?? null) : null,
      title: l.title ?? null,
      sku: l.sku ?? null,
      quantity: l.quantity ?? null,
      // What it is actually being sold for. The original price is
      // what it would have cost; a draft discounted by hand is the
      // ordinary reason a merchant makes one.
      price: money(l.discountedUnitPriceSet) ?? money(l.originalUnitPriceSet),
    }))
  );
  if (lines.length === 0) return;
  const { error: wrote } = await db.from("draft_order_line_items").insert(lines);
  if (wrote) throw new Error(wrote.message);
}

// ── Discounts ───────────────────────────────────────────────────
// An order has carried the codes typed at the checkout since 0092.
// This is what those codes were: how much came off, when the campaign
// ran, how many people used it, whether it is still running.
//
// Shopify keeps eight concrete types under one union. Asking each for
// only what it has is why the fragments below differ — the two App
// types carry no summary, and only the basic ones carry a value that
// is a single number. What the rest of a rule does is in Shopify's
// own sentence rather than rebuilt here.
export const DISCOUNTS_QUERY = `
query($n: Int!, $after: String) {
  discountNodes(first: $n, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      discount {
        __typename
        ... on DiscountCodeBasic { title status summary startsAt endsAt usageLimit appliesOncePerCustomer asyncUsageCount createdAt codes(first: 20) { nodes { code } } customerGets { value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } } } } }
        ... on DiscountCodeBxgy { title status summary startsAt endsAt usageLimit asyncUsageCount createdAt codes(first: 20) { nodes { code } } }
        ... on DiscountCodeFreeShipping { title status summary startsAt endsAt usageLimit appliesOncePerCustomer asyncUsageCount createdAt codes(first: 20) { nodes { code } } }
        ... on DiscountCodeApp { title status startsAt endsAt usageLimit asyncUsageCount createdAt codes(first: 20) { nodes { code } } }
        ... on DiscountAutomaticBasic { title status summary startsAt endsAt createdAt customerGets { value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } } } } }
        ... on DiscountAutomaticBxgy { title status summary startsAt endsAt createdAt }
        ... on DiscountAutomaticFreeShipping { title status summary startsAt endsAt createdAt }
        ... on DiscountAutomaticApp { title status startsAt endsAt createdAt }
      }
    }
  }
}`;

type GqlDiscountValue = {
  __typename?: string;
  percentage?: number | null;
  amount?: { amount: string; currencyCode: string } | null;
};

export type GqlDiscount = {
  id: string;
  discount?: {
    __typename?: string;
    title?: string | null;
    status?: string | null;
    summary?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    createdAt?: string | null;
    usageLimit?: number | null;
    appliesOncePerCustomer?: boolean | null;
    asyncUsageCount?: number | null;
    codes?: { nodes: Array<{ code: string }> } | null;
    customerGets?: { value?: GqlDiscountValue | null } | null;
  } | null;
};

/**
 * The type name, split into the two things worth filtering on.
 *
 * DiscountCodeBasic → CODE and BASIC; DiscountAutomaticFreeShipping →
 * AUTOMATIC and FREE_SHIPPING. Read off the name rather than listed,
 * so a ninth type Shopify adds arrives as itself instead of as null.
 */
export function splitDiscountType(typename?: string | null): { method: string | null; kind: string | null } {
  if (!typename?.startsWith("Discount")) return { method: null, kind: null };
  const rest = typename.slice("Discount".length);
  const method = rest.startsWith("Code") ? "CODE" : rest.startsWith("Automatic") ? "AUTOMATIC" : null;
  if (!method) return { method: null, kind: null };
  const tail = rest.slice(method === "CODE" ? 4 : 9);
  // FreeShipping → FREE_SHIPPING, Bxgy → BXGY.
  const kind = tail.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase() || null;
  return { method, kind };
}

/** Writes a batch of discounts. */
export async function saveDiscounts(
  db: SupabaseClient, storeId: string, nodes: GqlDiscount[]
): Promise<void> {
  if (nodes.length === 0) return;

  const rows = nodes.map((n) => {
    const d = n.discount ?? {};
    const { method, kind } = splitDiscountType(d.__typename);
    const value = d.customerGets?.value;
    return {
      store_id: storeId,
      external_id: n.id,
      title: d.title ?? null,
      method,
      kind,
      status: d.status ? d.status.toUpperCase() : null,
      summary: d.summary ?? null,
      codes: (d.codes?.nodes ?? []).map((c) => c.code).filter(Boolean),
      // Shopify reports 0.8 for 80% off. Stored as whole percents,
      // because a column called percent_off holding 0.8 is a bug in
      // every report that formats it.
      percent_off: typeof value?.percentage === "number" ? Number((value.percentage * 100).toFixed(2)) : null,
      amount_off: value?.amount?.amount != null ? Number(value.amount.amount) : null,
      currency: value?.amount?.currencyCode ?? null,
      // Null is no limit. Zero would be a campaign nobody can use.
      usage_limit: d.usageLimit ?? null,
      times_used: d.asyncUsageCount ?? null,
      once_per_customer: d.appliesOncePerCustomer ?? null,
      starts_at: d.startsAt ?? null,
      ends_at: d.endsAt ?? null,
      made_at: d.createdAt ?? null,
      updated_at: new Date().toISOString(),
    };
  });

  const { error } = await db.from("discounts").upsert(rows, { onConflict: "store_id,external_id" });
  if (error) throw new Error(error.message);
}

// ── Returns ─────────────────────────────────────────────────────
// Refunds (0091) are the money going back. This is everything before
// that: the customer asking, the merchant agreeing, the goods coming
// back, and why. The reason is the part no refund carries, and it is
// the part that tells a merchant a listing is wrong rather than a
// customer is difficult.
//
// Reached through the order, because Shopify has no top-level
// returns list — checked against the schema, not assumed. Unlike
// refunds, a bulk export IS accepted: refunds are a list field on
// Order and returns are a connection, and the restriction is on
// connections inside lists.
//
// returnReason is deliberately not asked for. Shopify marks it
// deprecated — "Use returnReasonDefinition instead. This field will
// be removed in the future" — and a field that disappears takes the
// whole query with it, not just one column.
//
// Five returns and twenty lines, not twenty and fifty. Shopify
// prices a query before running it and refuses anything over 1000;
// three levels of connection multiply, and the generous version
// cost 1598 and was refused outright — on every store, empty or
// not, because the price is set by what is asked for and not by
// what comes back. This costs 716. An order with more than five
// returns, or a return with more than twenty lines, trips the child
// limits below and goes the bulk way, which has no limits at all.
export const RETURNING =
  "return_status:return_requested OR return_status:in_progress OR return_status:returned";

/**
 * A line of a return, as both concrete shapes leave it.
 *
 * returnLineItems is an interface with two implementations, and only
 * one of them, ReturnLineItem, reaches back to what was bought. An
 * UnverifiedReturnLineItem — a line the merchant has not matched to a
 * fulfilment yet — carries quantities and a reason and nothing else,
 * so its title, SKU and product are null here. Checked against the
 * schema: it has no line item field at all to ask for.
 */
export type GqlReturnLine = {
  id?: string | null;
  quantity?: number | null;
  refundedQuantity?: number | null;
  returnReasonNote?: string | null;
  returnReasonDefinition?: { handle?: string | null; name?: string | null } | null;
  fulfillmentLineItem?: {
    lineItem?: {
      id?: string | null;
      title?: string | null;
      sku?: string | null;
      variant?: { id?: string | null } | null;
      product?: { id?: string | null } | null;
    } | null;
  } | null;
};

export const RETURNS_QUERY = `
query($n: Int!, $after: String) {
  orders(first: $n, after: $after, sortKey: UPDATED_AT, query: "${RETURNING}") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      returns(first: 5) {
        nodes {
          id name status totalQuantity createdAt closedAt
          returnLineItems(first: 20) {
            nodes {
              id quantity refundedQuantity returnReasonNote
              returnReasonDefinition { handle name }
              ... on ReturnLineItem {
                fulfillmentLineItem { lineItem { id title sku variant { id } product { id } } }
              }
            }
          }
        }
      }
    }
  }
}`;

export type GqlReturningOrder = {
  id: string;
  returns: {
    nodes: Array<{
      id: string;
      name?: string | null;
      status?: string | null;
      totalQuantity?: number | null;
      createdAt?: string | null;
      closedAt?: string | null;
      returnLineItems: { nodes: GqlReturnLine[] };
    }>;
  };
};

/** Writes a batch of returns and what is coming back in them. */
export async function saveReturns(
  db: SupabaseClient, storeId: string, nodes: GqlReturningOrder[]
): Promise<void> {
  if (nodes.length === 0) return;

  // An order carrying no return is not a mistake: the filter asks for
  // orders in a returning state, and one can leave that state between
  // the count and the page.
  const withReturns = nodes.filter((o) => (o.returns?.nodes ?? []).length > 0);
  if (withReturns.length === 0) return;

  const { data: orders } = await db
    .from("orders")
    .select("id, external_id")
    .eq("store_id", storeId)
    .in("external_id", withReturns.map((o) => o.id));
  const orderId = new Map((orders ?? []).map((r) => [r.external_id as string, r.id as string]));

  const rows = withReturns.flatMap((o) => {
    // Skipped rather than invented. A return whose order has not been
    // imported yet would need an order_id there is no honest value
    // for, and the next pass brings both.
    const parent = orderId.get(o.id);
    if (!parent) return [];
    return o.returns.nodes.map((r) => ({
      store_id: storeId,
      order_id: parent,
      external_id: r.id,
      name: r.name ?? null,
      status: r.status ? r.status.toUpperCase() : null,
      quantity: r.totalQuantity ?? null,
      // When the customer asked, which is what "open for nine days"
      // counts from.
      requested_at: r.createdAt ?? null,
      closed_at: r.closedAt ?? null,
      updated_at: new Date().toISOString(),
    }));
  });
  if (rows.length === 0) return;

  const { data: saved, error } = await db
    .from("returns")
    .upsert(rows, { onConflict: "store_id,external_id" })
    .select("id, external_id");
  if (error) throw new Error(error.message);
  const returnId = new Map((saved ?? []).map((r) => [r.external_id as string, r.id as string]));

  const lineNodes = withReturns
    .flatMap((o) => o.returns.nodes)
    .filter((r) => returnId.has(r.id));
  const allLines = lineNodes.flatMap((r) => r.returnLineItems?.nodes ?? []);
  const productIds = [...new Set(allLines
    .map((l) => l.fulfillmentLineItem?.lineItem?.product?.id).filter(Boolean) as string[])];
  const variantIds = [...new Set(allLines
    .map((l) => l.fulfillmentLineItem?.lineItem?.variant?.id).filter(Boolean) as string[])];
  const [prods, vars] = await Promise.all([
    productIds.length
      ? db.from("products").select("id, external_id").eq("store_id", storeId).in("external_id", productIds)
      : Promise.resolve({ data: [] as Array<{ id: string; external_id: string }> }),
    variantIds.length
      ? db.from("variants").select("id, external_id").eq("store_id", storeId).in("external_id", variantIds)
      : Promise.resolve({ data: [] as Array<{ id: string; external_id: string }> }),
  ]);
  const productId = new Map((prods.data ?? []).map((r) => [r.external_id, r.id]));
  const variantId = new Map((vars.data ?? []).map((r) => [r.external_id, r.id]));

  // Replaced rather than merged: a line dropped from a return in
  // Shopify has to disappear here, the same as an order's lines.
  const ids = lineNodes.map((r) => returnId.get(r.id)!);
  const { error: cleared } = await db.from("return_line_items").delete().in("return_id", ids);
  if (cleared) throw new Error(cleared.message);

  const lines = lineNodes.flatMap((r) =>
    (r.returnLineItems?.nodes ?? []).map((l) => {
      const item = l.fulfillmentLineItem?.lineItem;
      const def = l.returnReasonDefinition;
      return {
        store_id: storeId,
        return_id: returnId.get(r.id)!,
        external_id: l.id ?? null,
        // All null for an unverified line: it has nothing pointing
        // back at what was bought, which is a real state and not a
        // gap in the import.
        product_id: item?.product?.id ? (productId.get(item.product.id) ?? null) : null,
        variant_id: item?.variant?.id ? (variantId.get(item.variant.id) ?? null) : null,
        title: item?.title ?? null,
        sku: item?.sku ?? null,
        quantity: l.quantity ?? null,
        // How much of it has actually been paid back. The gap is a
        // return agreed and not yet settled.
        refunded_quantity: l.refundedQuantity ?? null,
        // The merchant-facing label Shopify shows, falling back to the
        // handle when a shop has not named its own reason. Stored as
        // it comes: it is already in words, unlike the enum it
        // replaced.
        reason: def?.name ?? def?.handle ?? null,
        reason_note: l.returnReasonNote ?? null,
      };
    })
  );
  if (lines.length === 0) return;
  const { error: wrote } = await db.from("return_line_items").insert(lines);
  if (wrote) throw new Error(wrote.message);
}

// ── Payouts ─────────────────────────────────────────────────────
// Orders say what customers were charged. Transactions say what the
// gateway captured. Neither says what Shopify actually sent to the
// bank, on what day, with what taken out — the number the merchant
// reconciles against their statement.
//
// Not a top-level list: payouts hang off the shop's Shopify Payments
// account, and a shop without one has no account at all rather than
// an empty list. That is the ordinary case for most of the world,
// so it is a normal answer here and not a failure.
//
// gross is deliberately not asked for: Shopify deprecates it in
// favour of net.
export const PAYOUTS_QUERY = `
query($n: Int!, $after: String) {
  shopifyPaymentsAccount {
    payouts(first: $n, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id status transactionType issuedAt
        net { amount currencyCode }
        summary {
          chargesGross { amount }
          chargesFee { amount }
          refundsFeeGross { amount }
          refundsFee { amount }
          adjustmentsGross { amount }
          adjustmentsFee { amount }
          reservedFundsGross { amount }
          reservedFundsFee { amount }
          retriedPayoutsGross { amount }
          retriedPayoutsFee { amount }
          advanceGross { amount }
          advanceFees { amount }
        }
      }
    }
  }
}`;

type Money = { amount?: string | null } | null | undefined;

export type GqlPayout = {
  id: string;
  status?: string | null;
  transactionType?: string | null;
  issuedAt?: string | null;
  net?: { amount?: string | null; currencyCode?: string | null } | null;
  summary?: {
    chargesGross?: Money; chargesFee?: Money;
    refundsFeeGross?: Money; refundsFee?: Money;
    adjustmentsGross?: Money; adjustmentsFee?: Money;
    reservedFundsGross?: Money; reservedFundsFee?: Money;
    retriedPayoutsGross?: Money; retriedPayoutsFee?: Money;
    advanceGross?: Money; advanceFees?: Money;
  } | null;
};

/** Writes a batch of payouts. */
export async function savePayouts(
  db: SupabaseClient, storeId: string, nodes: GqlPayout[]
): Promise<void> {
  if (nodes.length === 0) return;
  const n = (m: Money) => (m?.amount != null ? Number(m.amount) : null);

  const { error } = await db.from("payouts").upsert(
    nodes.map((p) => {
      const s = p.summary ?? {};
      return {
        store_id: storeId,
        external_id: p.id,
        status: p.status ? p.status.toUpperCase() : null,
        // DEPOSIT or WITHDRAWAL. Kept apart because adding the two
        // reports money arriving that in fact left.
        kind: p.transactionType ? p.transactionType.toUpperCase() : null,
        issued_at: p.issuedAt ?? null,
        net: n(p.net),
        currency: p.net?.currencyCode ?? null,
        charges_gross: n(s.chargesGross),
        charges_fee: n(s.chargesFee),
        refunds_gross: n(s.refundsFeeGross),
        refunds_fee: n(s.refundsFee),
        adjustments_gross: n(s.adjustmentsGross),
        adjustments_fee: n(s.adjustmentsFee),
        reserved_gross: n(s.reservedFundsGross),
        reserved_fee: n(s.reservedFundsFee),
        retried_gross: n(s.retriedPayoutsGross),
        retried_fee: n(s.retriedPayoutsFee),
        advance_gross: n(s.advanceGross),
        advance_fee: n(s.advanceFees),
      };
    }),
    { onConflict: "store_id,external_id" }
  );
  if (error) throw new Error(error.message);
}
