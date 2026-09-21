// ─────────────────────────────────────────────────────────────
// Reading a connected store.
//
// Two very different things need this: the builder, so it designs on
// the tables a merchant already has instead of inventing empty ones,
// and the MCP server, so their own ChatGPT or Claude can ask about the
// store. Written once because two copies would drift, and the one that
// drifted would be the one nobody was looking at.
//
// Every function takes the caller's own Supabase client. Row-level
// security decides what comes back — there is no owner check here,
// because a second opinion on the same question is how the two answers
// end up disagreeing. The service-role key never appears in this file.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SchemaColumn } from "@/lib/types";

export type StoreBrief = {
  id: string;
  project_id: string;
  shop_domain: string;
  timezone: string;
  currency: string;
  last_synced_at: string | null;
};

const BRIEF = "id, project_id, shop_domain, timezone, currency, last_synced_at";

/** The stores this caller can see at all. */
export async function listStores(db: SupabaseClient): Promise<StoreBrief[]> {
  const { data, error } = await db.from("stores").select(BRIEF).eq("status", "connected");
  // "No stores" and "could not ask" are different answers, and the
  // caller acts on them differently. Returning [] for both told an
  // owner with a connected store that they had none.
  if (error) throw new Error(error.message);
  return (data ?? []) as StoreBrief[];
}

const COUNTED = [
  "products",
  "variants",
  "customers",
  "orders",
  "order_line_items",
  "inventory_levels",
] as const;

export type StoreOverview = StoreBrief & {
  counts: Record<(typeof COUNTED)[number], number>;
};

/**
 * What is actually in this store's copy.
 *
 * Counts rather than samples: the builder needs to know a table holds
 * eight thousand orders, and an assistant answering "how many customers
 * do I have" should not be guessing from one page of rows.
 */
export async function storeOverview(
  db: SupabaseClient,
  storeId: string
): Promise<StoreOverview | null> {
  const { data: store, error } = await db
    .from("stores")
    .select(BRIEF)
    .eq("id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!store) return null;

  const counts = Object.fromEntries(
    await Promise.all(
      COUNTED.map(async (table) => {
        const { count, error: counted } = await db
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("store_id", storeId);
        // A count that failed is not a count of zero. Reported as zero,
        // it reads as an empty store — and drift is measured from it.
        if (counted) throw new Error(counted.message);
        return [table, count ?? 0];
      })
    )
  ) as StoreOverview["counts"];

  return { ...(store as StoreBrief), counts };
}

/** A column the section shows. Every one of them is a column of the view. */
function sortable(spec: TableSpec, field: string): boolean {
  return spec.columns.some((c) => c.field === field);
}

export type StoreLeaders = {
  /** Biggest spenders first, by Shopify's lifetime figure; those not yet synced follow, by orders. */
  top_customers: Array<{ name: string | null; orders: number; spent: number | null }>;
  /** Most units first, from every uncancelled order, all time. */
  best_sellers: Array<{ title: string | null; units: number; revenue: number | null; currency: string | null }>;
};

/**
 * The two lists a merchant asks for first — "who buys most", "what
 * sells" — read over the whole store, so Luke and a connected
 * assistant can answer rather than say "build a section".
 */
export async function storeLeaders(
  db: SupabaseClient,
  storeId: string,
  limit = 5
): Promise<StoreLeaders> {
  const [c, p] = await Promise.all([
    db
      .from("customers")
      .select("name, orders_count, total_spent")
      .eq("store_id", storeId)
      .gt("orders_count", 0)
      .order("total_spent", { ascending: false, nullsFirst: false })
      .order("orders_count", { ascending: false })
      .limit(limit),
    db
      .from("product_sales")
      .select("title, units, revenue, currency")
      .eq("store_id", storeId)
      .order("units", { ascending: false })
      .limit(limit),
  ]);
  if (c.error) throw new Error(c.error.message);
  if (p.error) throw new Error(p.error.message);
  type C = { name: string | null; orders_count: number | null; total_spent: number | string | null };
  type P = { title: string | null; units: number | null; revenue: number | string | null; currency: string | null };
  return {
    top_customers: ((c.data ?? []) as unknown as C[]).map((r) => ({
      name: r.name,
      orders: r.orders_count ?? 0,
      spent: r.total_spent === null ? null : Number(r.total_spent),
    })),
    best_sellers: ((p.data ?? []) as unknown as P[]).map((r) => ({
      title: r.title,
      units: r.units ?? 0,
      revenue: r.revenue === null ? null : Number(r.revenue),
      currency: r.currency,
    })),
  };
}

/**
 * The start and end of a calendar day in a given time zone, as instants.
 *
 * A store in New York and a server in UTC disagree about when yesterday
 * started by four hours, and four hours of orders is not a rounding
 * error. Everything that asks about a day goes through this, so there is
 * one place to be right rather than one place per caller to be wrong.
 */
export function dayRangeInZone(day: string, timeZone: string): { from: string; to: string } {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`Not a YYYY-MM-DD date: ${day}`);

  /** How far ahead of UTC the zone is at that instant. */
  const offsetMs = (at: Date): number => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .reduce<Record<string, string>>((acc, x) => ((acc[x.type] = x.value), acc), {});
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour) % 24,
      Number(p.minute),
      Number(p.second)
    );
    return asUtc - at.getTime();
  };

  // Two passes: the offset depends on the instant, and the instant is
  // what is being worked out. The first guess lands within a day, which
  // is close enough for its offset to be the right one — except across a
  // DST change, where the second pass corrects it.
  const midnight = (year: number, month: number, date: number): number => {
    const guess = Date.UTC(year, month - 1, date);
    return guess - offsetMs(new Date(guess - offsetMs(new Date(guess))));
  };

  const from = midnight(y, m, d);
  // The next day's midnight, which is not always 24 hours later.
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const to = midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());

  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

// ── Sections backed by the store ────────────────────────────────
//
// A section normally holds rows the merchant typed, kept in `records`.
// One of these holds rows that came from Shopify instead: read-only,
// refreshed by the import, and never edited here — an edit would be
// overwritten by the next import and the merchant would never know.
//
// The columns and the rows are defined together on purpose. Two lists
// that must agree, written in two places, is how a section ends up
// showing blank cells for fields the query never asked for.

export type StoreTable =
  | "orders"
  | "customers"
  | "products"
  | "inventory_levels"
  | "product_sales"
  | "order_line_items";

type TableSpec = {
  /** What a stat over this table should be — for whoever designs one. */
  advice?: string;
  label: string;
  /**
   * The SQL view that holds this list in the shape the app shows
   * (0087). The shape used to be made here, row by row, after the
   * page was read — and a stat computed on the server had to see the
   * same shape. One definition, in the database; this reads it.
   */
  view: string;
  select: string;
  /** Column and direction the rows arrive in, newest or A-Z first. */
  order: { field: string; ascending: boolean };
  columns: SchemaColumn[];
  /**
   * What this list is, in one sentence, and which of a merchant's
   * phrases mean it. Read by the design prompt and handed to a
   * connected assistant, so neither carries its own copy of the list —
   * a copy is how a table went missing from the prompt for a week.
   */
  what: string;
  /**
   * The section this list becomes when the store connects: its name in
   * the sidebar, its icon, and which import's rows say it has anything
   * to show (lines and sales come in with the orders).
   */
  section: { label: string; icon: string; importedWith: "orders" | "customers" | "products" | "inventory" };
};

/** PostgREST embeds a to-one relation as a one-element array or an object; either way, the one row. */
const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

export const STORE_TABLES: Record<StoreTable, TableSpec> = {
  orders: {
    label: "Shopify orders",
    what: 'one row per order — number, customer, total, paid / pending / cancelled, fulfilment; what "our orders", "revenue", "COD pending" and "how much did we sell" mean',
    section: { label: "Orders", icon: "shopping-cart", importedWith: "orders" },
    // What a stat over these rows should be, said once and read by both
    // doors — Luke's prompt and design_format. A merchant's "revenue"
    // was sum(total) over every row: unpaid COD orders, cancelled ones,
    // refunds, all in. On a four-order store that is $4,942 where the
    // money actually collected is $0.
    advice:
      'Money: `total` is what the order comes to today, after refunds; `total_original` is what it came to when placed. Do not sum `total` over every row and call it revenue — most of it may be unpaid. Revenue collected = sum(total) where financial_status = "PAID". Awaiting payment (COD) = sum(total) where financial_status = "PENDING". Cancelled = count where cancelled_at is not empty, kept out of both. Average order value = avg(total_original). When a merchant asks for one revenue number, show these apart and say which is which.',
    view: "store_orders",
    order: { field: "placed_at", ascending: false },
    select:
      "id, order_number, placed_at, customer_name, customer_phone, total, total_original, currency, status, fulfilment_status, financial_status, cancelled_at, tags",
    columns: [
      { field: "order_number", label: "Order", type: "text" },
      { field: "placed_at", label: "Placed", type: "date" },
      { field: "customer_name", label: "Customer", type: "text" },
      { field: "customer_phone", label: "Phone", type: "phone" },
      // What the order comes to today, after refunds — Shopify's own
      // meaning of total — and what it came to when placed.
      { field: "total", label: "Total", type: "currency", currencyField: "currency" },
      { field: "total_original", label: "Before refunds", type: "currency", currencyField: "currency" },
      { field: "currency", label: "Currency", type: "text" },
      { field: "status", label: "Status", type: "badge" },
      { field: "fulfilment_status", label: "Fulfilment", type: "badge" },
    ],
  },
  customers: {
    advice:
      "Top buyers = sort by total_spent desc — Shopify's lifetime figure for the customer, over every customer, not this page. Repeat customers = count where orders_count >= 2. total_spent is empty for a customer not synced since it was added; it fills on the next import.",
    label: "Shopify customers",
    what: 'one row per customer — name, phone, email, city, orders placed, lifetime spend; "top buyers" is this list with defaultSort total_spent desc, "repeat customers" a count stat on it where orders_count >= 2',
    section: { label: "Customers", icon: "users", importedWith: "customers" },
    view: "store_customers",
    order: { field: "name", ascending: true },
    select: "id, name, email, phone, city, orders_count, total_spent",
    columns: [
      { field: "name", label: "Name", type: "text" },
      { field: "phone", label: "Phone", type: "phone" },
      { field: "email", label: "Email", type: "email" },
      { field: "city", label: "City", type: "text" },
      { field: "orders_count", label: "Orders", type: "number" },
      { field: "total_spent", label: "Total spent", type: "currency" },
    ],
  },
  // A view, not a table: one row per product, summed from the order
  // lines of every uncancelled order (0084, 0086). Ranked on the
  // server, so "best sellers" is over every sale, not the page that
  // loaded. Not paid-only: a cash-on-delivery shop has sales for days
  // before Shopify calls any of them paid, and some it never marks.
  product_sales: {
    advice:
      "Best sellers = sort by units desc (or revenue desc). One row per product, from every order that was not cancelled — paid or still awaiting payment (COD). revenue is the value of those orders, not what has been collected; a refund after the sale is not subtracted. units, revenue and orders are whole-store totals.",
    label: "Product sales",
    what: 'one row per product with units sold and order value from every uncancelled order; what "best sellers", "top products" and "which product sells most" mean',
    // Summed from the orders, so it exists once orders do.
    section: { label: "Best sellers", icon: "target", importedWith: "orders" },
    view: "product_sales",
    order: { field: "units", ascending: false },
    select: "id, product_id, title, units, revenue, orders, last_sold, currency",
    columns: [
      { field: "title", label: "Product", type: "text" },
      { field: "units", label: "Units sold", type: "number" },
      { field: "revenue", label: "Revenue", type: "currency", currencyField: "currency" },
      { field: "orders", label: "Orders", type: "number" },
      { field: "last_sold", label: "Last sold", type: "date" },
    ],
  },
  order_line_items: {
    // The lines inside the orders — one row per SKU per order. Asked
    // for as "which SKUs were in each order" and, until this existed,
    // answerable only with a list typed in by hand next to the real one.
    advice:
      "One row per SKU per order, from every order. Units of a SKU = sum(quantity) where sku = X. A cancelled order's lines are still here with status Cancelled — keep them out of a count with where status != Cancelled. line_total is quantity × price at the time; it is not what was collected.",
    label: "Shopify order items",
    what: 'one row per SKU per order — order number, product, variant, SKU, quantity, price; what "which SKUs were in each order", "a SKU list for my orders" and "order items" mean. Never build a hand-typed list of order lines beside it',
    // The lines come in with the orders.
    section: { label: "Order items", icon: "receipt", importedWith: "orders" },
    view: "store_order_items",
    order: { field: "placed_at", ascending: false },
    select:
      "id, order_id, order_number, placed_at, customer_name, title, variant_title, sku, quantity, price, line_total, currency, status",
    columns: [
      { field: "order_number", label: "Order", type: "text" },
      { field: "placed_at", label: "Placed", type: "date" },
      { field: "customer_name", label: "Customer", type: "text" },
      { field: "title", label: "Product", type: "text" },
      { field: "variant_title", label: "Variant", type: "text" },
      { field: "sku", label: "SKU", type: "text" },
      { field: "quantity", label: "Qty", type: "number" },
      { field: "price", label: "Price", type: "currency", currencyField: "currency" },
      { field: "line_total", label: "Line total", type: "currency", currencyField: "currency" },
      { field: "status", label: "Status", type: "badge" },
    ],
  },
  products: {
    label: "Shopify products",
    what: 'one row per product in the catalogue — title, category, vendor, status, tags; what "our products" and "the catalogue" mean',
    section: { label: "Products", icon: "package", importedWith: "products" },
    view: "store_products",
    order: { field: "title", ascending: true },
    select: "id, title, product_type, vendor, handle, status, tags",
    columns: [
      { field: "title", label: "Product", type: "text" },
      { field: "product_type", label: "Category", type: "badge" },
      { field: "vendor", label: "Vendor", type: "text" },
      { field: "status", label: "Status", type: "badge" },
      { field: "handle", label: "Handle", type: "text" },
      { field: "tags", label: "Tags", type: "text" },
    ],
  },
  inventory_levels: {
    label: "Shopify stock",
    what: 'one row per variant per location — product, variant, SKU, location, available; what "stock", "inventory" and "running low" mean',
    section: { label: "Stock", icon: "box", importedWith: "inventory" },
    // Lowest stock first: the rows a merchant opens this for.
    view: "store_inventory",
    order: { field: "available", ascending: true },
    select: "id, product, variant, sku, location_name, available",
    columns: [
      { field: "product", label: "Product", type: "text" },
      { field: "variant", label: "Variant", type: "text" },
      { field: "sku", label: "SKU", type: "text" },
      { field: "location_name", label: "Location", type: "text" },
      { field: "available", label: "In stock", type: "number" },
    ],
  },
} as Record<StoreTable, TableSpec>;

/**
 * The columns a search looks at, per table. Kept beside the specs
 * rather than derived from them: a column being text is not the same
 * as it being worth searching, and matching a postcode against a
 * product title helps nobody.
 */
const SEARCHABLE: Record<StoreTable, string[]> = {
  orders: ["order_number", "customer_name", "financial_status", "fulfilment_status"],
  customers: ["name", "email", "phone", "city"],
  products: ["title", "handle", "status", "product_type", "vendor"],
  inventory_levels: ["product", "variant", "sku", "location_name"],
  product_sales: ["title"],
  order_line_items: ["order_number", "sku", "title", "customer_name"],
};

export const isStoreTable = (v: unknown): v is StoreTable =>
  typeof v === "string" && v in STORE_TABLES;

/** The schema a section gets when it is pointed at a store table. */
export function storeTableSchema(table: StoreTable): { columns: SchemaColumn[] } {
  return { columns: STORE_TABLES[table].columns };
}

/**
 * Store rows in the shape the renderer already understands.
 *
 * Returned as `{ id, data }` so a section backed by Shopify renders
 * through exactly the same component as one the merchant built — the
 * difference is that nothing here is editable, which the caller enforces
 * by passing no write handlers.
 */
export async function readStoreRows(
  db: SupabaseClient,
  storeId: string,
  table: StoreTable,
  limit = 200,
  /**
   * Words to look for. Matched against the table's own text columns —
   * never against every column, because a number typed into a search
   * box would otherwise match an id nobody asked about.
   */
  /** One term, or several — a row matching any of them is a hit. */
  q?: string | string[],
  /**
   * The section's own sort, applied here rather than after the page is
   * read. "Customers by total spent" cut from the first 200 names A-Z
   * is the biggest spenders whose names start early in the alphabet;
   * the page has to be cut in the order the section asks for. Any
   * column the section shows can be sorted on; anything else falls
   * back to the list's own order.
   */
  sort?: { field: string; dir: "asc" | "desc" } | null,
  /** Only rows whose `field` (a YYYY-MM-DD day) falls in from..to, inclusive. */
  between?: { field: string; from: string; to: string } | null
): Promise<{ rows: Array<{ id: string; data: Record<string, unknown> }>; total: number }> {
  const spec = STORE_TABLES[table];
  const ordered = sort && sortable(spec, sort.field) ? sort : null;
  let query = db.from(spec.view).select(spec.select, { count: "exact" }).eq("store_id", storeId);
  // Rows without the figure go last whichever way the sort runs: a
  // customer never synced since total_spent arrived is not the top
  // buyer, and not the bottom one either.
  if (ordered) query = query.order(ordered.field, { ascending: ordered.dir === "asc", nullsFirst: false });
  query = query
    .order(spec.order.field, { ascending: spec.order.ascending })
    .limit(Math.min(Math.max(limit, 1), 500));

  // Commas and parentheses end an or() clause early, so a search for
  // "Shirt, blue" would silently become a search for "Shirt".
  const terms = (Array.isArray(q) ? q : [q ?? ""])
    .map((t) => t.replace(/[,()]/g, " ").trim())
    .filter(Boolean)
    .slice(0, 20);
  if (terms.length) {
    const fields = SEARCHABLE[table];
    query = query.or(terms.flatMap((t) => fields.map((f) => `${f}.ilike.%${t}%`)).join(","));
  }
  if (between && sortable(spec, between.field)) {
    query = query.gte(between.field, between.from).lte(between.field, between.to);
  }

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);

  return {
    rows: (data ?? []).map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return { id: row.id as string, data: row };
    }),
    total: count ?? 0,
  };
}

export type OrderSearch = {
  /** A calendar day in the store's own zone, YYYY-MM-DD. */
  day?: string;
  from?: string;
  to?: string;
  /** "cancelled", or a Shopify financial or fulfilment status. */
  status?: string;
  /** Matches an order number, or a customer's phone, email or name. */
  q?: string;
  limit?: number;
};

export type OrderHit = {
  order_number: string | null;
  placed_at: string | null;
  total: number | null;
  currency: string | null;
  financial_status: string | null;
  fulfilment_status: string | null;
  cancelled_at: string | null;
  tags: string[];
  customer: { name: string | null; phone: string | null; email: string | null } | null;
};

/** Hard ceiling. An assistant that asks for everything gets a page. */
const MAX_LIMIT = 100;

/** What may appear inside a PostgREST or() without changing its shape. */
const SAFE_TERM = /^[\w@.+\- ]{1,80}$/;

export async function searchOrders(
  db: SupabaseClient,
  store: Pick<StoreBrief, "id" | "timezone">,
  search: OrderSearch = {}
): Promise<OrderHit[]> {
  let q = db
    .from("orders")
    .select(
      "order_number, placed_at, total, currency, financial_status, fulfilment_status, cancelled_at, tags, customers(name, phone, email)"
    )
    .eq("store_id", store.id)
    .order("placed_at", { ascending: false })
    .limit(Math.min(Math.max(search.limit ?? 20, 1), MAX_LIMIT));

  // A day is resolved in the store's zone, never the server's.
  if (search.day) {
    const { from, to } = dayRangeInZone(search.day, store.timezone);
    q = q.gte("placed_at", from).lt("placed_at", to);
  } else {
    if (search.from) q = q.gte("placed_at", search.from);
    if (search.to) q = q.lt("placed_at", search.to);
  }

  if (search.status === "cancelled") {
    q = q.not("cancelled_at", "is", null);
  } else if (search.status && SAFE_TERM.test(search.status)) {
    // A cancelled order keeps its last financial status, so asking for
    // "paid" and being handed cancelled ones would be a wrong answer
    // rather than a generous one.
    q = q
      .is("cancelled_at", null)
      .or(`financial_status.eq.${search.status},fulfilment_status.eq.${search.status}`);
  }

  // Both of these end up inside a PostgREST or() expression, where a
  // comma or a bracket is punctuation rather than text. The caller is
  // frequently a language model repeating whatever a merchant typed —
  // or whatever a product title happens to contain — so the characters
  // that could change the shape of the filter are refused rather than
  // escaped. The store_id filter and RLS are separate and always
  // applied, so this was never a way into another shop; it was a way
  // to make one shop's query mean something else.
  const term = search.q?.trim();
  if (term && SAFE_TERM.test(term)) {
    const { data: people } = await db
      .from("customers")
      .select("id")
      .eq("store_id", store.id)
      .or(`phone.ilike.%${term}%,email.ilike.%${term}%,name.ilike.%${term}%`)
      .limit(MAX_LIMIT);
    const ids = (people ?? []).map((p) => p.id as string);
    // Both, because a merchant looking somebody up types whatever they
    // have in front of them — an order number or a phone.
    q = ids.length
      ? q.or(`order_number.ilike.%${term}%,customer_id.in.(${ids.join(",")})`)
      : q.ilike("order_number", `%${term}%`);
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    // PostgREST returns one object for a to-one relation, but the client
    // types every embed as an array. Both are handled rather than cast
    // away, because the cast is what turns a wrong shape into a crash
    // at the caller instead of here.
    const { customers, ...rest } = row as unknown as Omit<OrderHit, "customer"> & {
      customers: OrderHit["customer"] | OrderHit["customer"][] | null;
    };
    return {
      ...rest,
      customer: Array.isArray(customers) ? (customers[0] ?? null) : (customers ?? null),
    };
  });
}

/**
 * What is running out.
 *
 * "Low stock" is the question a shop actually asks, and it is not a
 * filter over one table: the count lives on the level, the name on the
 * variant, and the product it belongs to somewhere else again. A
 * generic row search cannot answer it, which is why it gets a function.
 */
export async function lowStock(
  db: SupabaseClient,
  storeId: string,
  { threshold = 5, limit = 50 }: { threshold?: number; limit?: number } = {}
): Promise<Array<{ product: string | null; variant: string | null; sku: string | null; location: string; available: number }>> {
  const { data, error } = await db
    .from("inventory_levels")
    .select("available, location_name, variants(title, sku, products(title))")
    .eq("store_id", storeId)
    .lte("available", Math.max(threshold, 0))
    .order("available", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), MAX_LIMIT));
  if (error) throw new Error(error.message);

  return (data ?? []).map((r) => {
    const row = r as unknown as Record<string, unknown>;
    const v = one(row.variants as { title?: string; sku?: string; products?: unknown } | null);
    const p = one(v?.products as { title?: string } | null);
    return {
      product: p?.title ?? null,
      variant: v?.title ?? null,
      sku: v?.sku ?? null,
      location: (row.location_name as string) || "—",
      available: (row.available as number) ?? 0,
    };
  });
}

/**
 * One order, with what was in it.
 *
 * The list view deliberately leaves line items out — a hundred orders
 * with their contents is a wall nobody reads. Asked about one order,
 * they are the whole point.
 */
export async function orderDetail(
  db: SupabaseClient,
  storeId: string,
  ref: string
): Promise<Record<string, unknown> | null> {
  const wanted = ref.trim();
  if (!wanted) return null;
  // Merchants say "1003"; the order is stored as "#1003".
  const numbers = [wanted, wanted.startsWith("#") ? wanted.slice(1) : `#${wanted}`];

  const { data, error } = await db
    .from("orders")
    .select(
      "order_number, placed_at, total, currency, financial_status, fulfilment_status, cancelled_at, tags, customers(name, phone, email), order_line_items(title, variant_title, sku, quantity, price)"
    )
    .eq("store_id", storeId)
    .in("order_number", numbers)
    .limit(1);
  if (error) throw new Error(error.message);

  const row = data?.[0] as unknown as Record<string, unknown> | undefined;
  if (!row) return null;

  const c = one(row.customers as { name?: string; phone?: string; email?: string } | null);
  const lines = (row.order_line_items ?? []) as Array<Record<string, unknown>>;
  return {
    order_number: row.order_number,
    placed_at: row.placed_at,
    total: row.total,
    currency: row.currency,
    status: row.cancelled_at ? "cancelled" : (row.financial_status ?? null),
    fulfilment_status: row.fulfilment_status ?? null,
    tags: row.tags ?? [],
    customer: c ? { name: c.name ?? null, phone: c.phone ?? null, email: c.email ?? null } : null,
    items: lines.map((l) => ({
      title: l.variant_title ? `${l.title} — ${l.variant_title}` : l.title,
      sku: l.sku ?? null,
      quantity: l.quantity,
      price: l.price,
    })),
  };
}

/**
 * What a few columns actually contain, so a design can use the real
 * strings instead of the ones a model would have guessed.
 *
 * Only the columns worth a dropdown, and only when there are few
 * enough to be one. A vendor list of four hundred names is not a
 * filter, and pasting it into a prompt would cost more than it tells.
 */
const FILTERABLE: Array<[StoreTable, string]> = [
  ["products", "status"],
  ["products", "product_type"],
  ["products", "vendor"],
  ["orders", "financial_status"],
  ["orders", "fulfilment_status"],
  ["inventory_levels", "location_name"],
];

/** Above this many distinct values it is a search box, not a dropdown. */
const MAX_CHOICES = 25;

export async function storeValues(
  db: SupabaseClient,
  storeId: string
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};

  await Promise.all(
    FILTERABLE.map(async ([table, column]) => {
      // Distinct is not exposed through PostgREST, so a page of rows
      // is read and reduced here. Bounded on purpose: this runs on
      // every design, and the answer only has to be representative
      // enough to spell the values correctly.
      const { data, error } = await db
        .from(table)
        .select(column)
        .eq("store_id", storeId)
        .not(column, "is", null)
        .limit(500);
      if (error || !data) return;

      const seen = new Set<string>();
      for (const row of data as unknown as Array<Record<string, unknown>>) {
        const v = String(row[column] ?? "").trim();
        if (v) seen.add(v);
        if (seen.size > MAX_CHOICES) return; // too many to be a choice
      }
      if (seen.size > 0) out[`${table}.${column}`] = [...seen].sort();
    })
  );

  return out;
}
