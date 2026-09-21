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
