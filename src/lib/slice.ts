// The rows a routed question needs, read from the store.
//
// The route says which list, what span, what kind. This turns the span
// into days in the shop's own zone, and the kind into how the page is
// cut — the biggest first for a ranking, the words looked up for a
// lookup, the span's rows for a total — and reads them through the
// same functions the sections and the MCP tools read through. Nothing
// here is computed; Luke does the arithmetic over rows it can quote.

import type { SupabaseClient } from "@supabase/supabase-js";
import { dayRangeInZone, lowStock, readStoreRows } from "@/lib/store-read";
import { ROUTE_TABLE, type Route } from "@/lib/route";

export type Slice = {
  /** What was read, in words Luke can repeat: "orders placed 2026-09-01 to 2026-09-19". */
  what: string;
  rows: Array<Record<string, unknown>>;
  /** How many the span holds in all, when the read can say. */
  total: number | null;
};

/** The most rows a slice carries. Luke reads every one; past this it reads none well. */
const ROWS = 50;

/** Today's date in a zone, YYYY-MM-DD. */
const todayIn = (timeZone: string, now: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const shift = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const firstOfMonth = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}-01`;

/**
 * The span as inclusive days in the shop's zone, and as instants for a
 * query on timestamps. Null for "all".
 */
export function windowRange(
  route: Pick<Route, "window" | "month">,
  timeZone: string,
  now = new Date()
): { fromDay: string; toDay: string; from: string; to: string; label: string } | null {
  const today = todayIn(timeZone, now);
  const [y, m] = today.split("-").map(Number);
  let fromDay: string, toDay: string, label: string;
  switch (route.window) {
    case "today":
      fromDay = toDay = today; label = "today";
      break;
    case "yesterday":
      fromDay = toDay = shift(today, -1); label = "yesterday";
      break;
    case "this_week":
      fromDay = shift(today, -6); toDay = today; label = "the last 7 days";
      break;
    case "this_month":
      fromDay = shift(today, -29); toDay = today; label = "the last 30 days";
      break;
    case "last_month": {
      const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
      fromDay = firstOfMonth(py, pm); toDay = shift(firstOfMonth(y, m), -1); label = "last month";
      break;
    }
    case "named_month": {
      if (!route.month) return null;
      // A month not yet reached this year means last year's.
      const yy = route.month > m ? y - 1 : y;
      const ny = route.month === 12 ? yy + 1 : yy, nm = route.month === 12 ? 1 : route.month + 1;
      fromDay = firstOfMonth(yy, route.month); toDay = shift(firstOfMonth(ny, nm), -1);
      label = new Date(`${fromDay}T00:00:00Z`).toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });
      break;
    }
    default:
      return null;
  }
  return {
    fromDay,
    toDay,
    from: dayRangeInZone(fromDay, timeZone).from,
    to: dayRangeInZone(toDay, timeZone).to,
    label,
  };
}

/**
 * Of the words worth looking up, the ones to actually search. An order
 * number names one row; a capitalised word is a name or a product; the
 * rest are only tried when there is nothing better — "is #2 paid" must
 * not also match every paid order because "paid" was in the sentence.
 */
export function pickNeedles(needles: string[]): string[] {
  const numbers = needles.filter((n) => /^#\d+$/.test(n));
  if (numbers.length) return numbers;
  const proper = needles.filter((n) => /^[A-Z]/.test(n));
  if (proper.length) return proper.slice(0, 6);
  return needles.slice(0, 6);
}

const strip = (rows: Array<{ data: Record<string, unknown> }>) =>
  rows.map(({ data }) => {
    const { id: _id, store_id: _sid, ...rest } = data;
    void _id; void _sid;
    return rest;
  });

export async function fetchSlice(
  db: SupabaseClient,
  store: { id: string; timezone: string },
  route: Route
): Promise<Slice | null> {
  const span = windowRange(route, store.timezone);
  const when = span ? ` ${span.label} (${span.fromDay} to ${span.toDay})` : "";
  const needles = route.kind === "lookup" ? pickNeedles(route.needles) : [];
  const table = ROUTE_TABLE[route.list];

  if (route.list === "sales" && span) {
    // Per product within a span: the view is all-time, the function is not.
    const { data, error } = await db.rpc("abo_sales_between", {
      p_store: store.id,
      p_from: span.from,
      p_to: span.to,
      p_limit: 20,
    });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    return { what: `products sold${when}, most units first`, rows, total: rows.length };
  }

  // "August ka top buyer": the customers list carries lifetime spend,
  // not August's. What answers that is August's orders, each with its
  // customer's name — fifty rows Luke can rank by name itself.
  if (route.list === "customers" && span && route.kind !== "lookup") {
    const { rows, total } = await readStoreRows(db, store.id, "orders", ROWS, undefined, { field: "total", dir: "desc" }, {
      field: "placed_at",
      from: span.fromDay,
      to: span.toDay,
    });
    return {
      what: `orders placed${when}, biggest first, each with its customer — rank or count customers from these`,
      rows: strip(rows),
      total,
    };
  }

  if (route.list === "stock" && route.kind !== "lookup") {
    const low = await lowStock(db, store.id, { threshold: 10, limit: ROWS });
    return { what: "stock running low (under 10), lowest first", rows: low, total: null };
  }

  // Ranked lists are cut biggest-first on the server; a lookup by the
  // words; a total by the span, newest first.
  const sort =
    route.kind === "ranking"
      ? route.list === "customers"
        ? { field: "total_spent", dir: "desc" as const }
        : route.list === "sales"
          ? { field: "units", dir: "desc" as const }
          : route.list === "orders"
            ? { field: "total", dir: "desc" as const }
            : null
      : null;
  const between =
    span && route.list === "orders" ? { field: "placed_at", from: span.fromDay, to: span.toDay } : null;
  const { rows, total } = await readStoreRows(db, store.id, table, ROWS, needles, sort, between);
  const what =
    route.list === "orders"
      ? `orders placed${when || " (all time)"}${sort ? ", biggest first" : ", newest first"}`
      : route.list === "customers"
        ? sort
          ? "customers by lifetime spend, biggest first"
          : "customers"
        : route.list === "products"
          ? "products in the catalogue"
          : route.list === "stock"
            ? "stock levels"
            : "products sold, all time, most units first";
  return {
    what: needles.length ? `${what}, matching "${needles.slice(0, 5).join('" or "')}"` : what,
    rows: strip(rows),
    total,
  };
}
