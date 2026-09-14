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
