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
  const { data } = await db.from("stores").select(BRIEF).eq("status", "connected");
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
  const { data: store } = await db.from("stores").select(BRIEF).eq("id", storeId).maybeSingle();
  if (!store) return null;

  const counts = Object.fromEntries(
    await Promise.all(
      COUNTED.map(async (table) => {
        const { count } = await db
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("store_id", storeId);
        return [table, count ?? 0];
      })
    )
  ) as StoreOverview["counts"];

  return { ...(store as StoreBrief), counts };
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

export type StoreTable = "orders" | "customers" | "products" | "inventory_levels";

type TableSpec = {
  label: string;
  select: string;
  /** Column and direction the rows arrive in, newest or A-Z first. */
  order: { field: string; ascending: boolean };
  columns: SchemaColumn[];
  flatten: (row: Record<string, unknown>) => Record<string, unknown>;
};

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

export const STORE_TABLES: Record<StoreTable, TableSpec> = {
  orders: {
    label: "Shopify orders",
    order: { field: "placed_at", ascending: false },
    select:
      "id, order_number, placed_at, total, currency, financial_status, fulfilment_status, cancelled_at, tags, customers(name, phone)",
    columns: [
      { field: "order_number", label: "Order", type: "text" },
      { field: "placed_at", label: "Placed", type: "date" },
      { field: "customer_name", label: "Customer", type: "text" },
      { field: "customer_phone", label: "Phone", type: "phone" },
      { field: "total", label: "Total", type: "currency" },
      { field: "status", label: "Status", type: "badge" },
      { field: "fulfilment_status", label: "Fulfilment", type: "badge" },
    ],
    flatten: (r) => {
      const c = one(r.customers as { name?: string; phone?: string } | null);
      return {
        order_number: r.order_number,
        // The date only — the renderer's date column shows a day, and
        // a full timestamp would render as a wall of digits.
        placed_at: typeof r.placed_at === "string" ? r.placed_at.slice(0, 10) : null,
        customer_name: c?.name ?? null,
        customer_phone: c?.phone ?? null,
        total: r.total,
        // A cancelled order keeps its last financial status, so showing
        // that alone would call a cancelled order "paid".
        status: r.cancelled_at ? "Cancelled" : (r.financial_status ?? null),
        fulfilment_status: r.fulfilment_status ?? null,
      };
    },
  },
  customers: {
    label: "Shopify customers",
    order: { field: "name", ascending: true },
    select: "id, name, email, phone, city, orders_count",
    columns: [
      { field: "name", label: "Name", type: "text" },
      { field: "phone", label: "Phone", type: "phone" },
      { field: "email", label: "Email", type: "email" },
      { field: "city", label: "City", type: "text" },
      { field: "orders_count", label: "Orders", type: "number" },
    ],
    flatten: (r) => ({
      name: r.name,
      phone: r.phone,
      email: r.email,
      city: r.city,
      orders_count: r.orders_count,
    }),
  },
  products: {
    label: "Shopify products",
    order: { field: "title", ascending: true },
    select: "id, title, handle, status, tags",
    columns: [
      { field: "title", label: "Product", type: "text" },
      { field: "handle", label: "Handle", type: "text" },
      { field: "status", label: "Status", type: "badge" },
      { field: "tags", label: "Tags", type: "text" },
    ],
    flatten: (r) => ({
      title: r.title,
      handle: r.handle ?? null,
      status: r.status,
      // A text column renders a string; an array would print as
      // "[object Object]" or a bracketed dump.
      tags: Array.isArray(r.tags) && r.tags.length ? (r.tags as string[]).join(", ") : null,
    }),
  },
  inventory_levels: {
    label: "Shopify stock",
    // Lowest stock first: the rows a merchant opens this for.
    order: { field: "available", ascending: true },
    select: "id, available, location_name, updated_at, variants(sku, title, products(title))",
    columns: [
      { field: "product", label: "Product", type: "text" },
      { field: "variant", label: "Variant", type: "text" },
      { field: "sku", label: "SKU", type: "text" },
      { field: "location_name", label: "Location", type: "text" },
      { field: "available", label: "In stock", type: "number" },
    ],
    flatten: (r) => {
      const v = one(
        r.variants as { sku?: string; title?: string; products?: unknown } | null
      );
      const p = one(v?.products as { title?: string } | null);
      return {
        product: p?.title ?? null,
        variant: v?.title ?? null,
        sku: v?.sku ?? null,
        location_name: r.location_name || null,
        available: r.available,
      };
    },
  },
} as Record<StoreTable, TableSpec>;

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
  limit = 200
): Promise<{ rows: Array<{ id: string; data: Record<string, unknown> }>; total: number }> {
  const spec = STORE_TABLES[table];
  const { data, count, error } = await db
    .from(table)
    .select(spec.select, { count: "exact" })
    .eq("store_id", storeId)
    .order(spec.order.field, { ascending: spec.order.ascending })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (error) throw new Error(error.message);

  return {
    rows: (data ?? []).map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return { id: row.id as string, data: spec.flatten(row) };
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
  } else if (search.status) {
    // A cancelled order keeps its last financial status, so asking for
    // "paid" and being handed cancelled ones would be a wrong answer
    // rather than a generous one.
    q = q
      .is("cancelled_at", null)
      .or(`financial_status.eq.${search.status},fulfilment_status.eq.${search.status}`);
  }

  const term = search.q?.trim();
  if (term) {
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
