"use client";

// ─────────────────────────────────────────────────────────────
// Overview — how the store is doing, on one screen.
//
// The numbers come from abo_store_overview (0113), counted over every
// order on the server; a page of rows in the browser would be a wrong
// total that looks right. Money is shown in the currency Shopify
// recorded it in, each currency on its own line, and "today" is the
// store's today.
//
// Every figure leads somewhere: tap it and the section it came from
// opens, or the order itself.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Package, RefreshCw, ShoppingCart, Store, TriangleAlert } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { useFormat } from "@/lib/format";
import { readStoreRows, STORE_TABLES, type StoreTable } from "@/lib/store-read";
import { ago } from "@/lib/when";
import { Badge } from "@/components/views";
import { button, card, note } from "@/components/ui/controls";
import type { DetailRow } from "@/components/StoreRecordDetail";

type Money = { currency: string; collected: number; awaiting: number; awaiting_count: number; average: number | null; orders: number };
type OverviewData = {
  store: { shop_domain: string; status: string; currency: string; timezone: string; last_synced_at: string | null } | null;
  today?: string;
  orders?: { today: number; last_7: number; last_30: number };
  money?: Money[];
  daily?: Array<{ day: string; orders: number }>;
  to_fulfil?: number;
  stock?: Record<string, number>;
  customers?: number;
  products?: number;
};

/** The stock states worth a merchant's attention, in the list's own words (0097). */
const WATCH = ["Out of stock", "All promised", "Out, more coming"];

export default function Overview({
  projectId,
  storeId,
  importing,
  hasSection,
  onOpenTable,
  onInspect,
  refreshKey,
}: {
  projectId: string;
  storeId: string;
  /** The store's import is still running, so the numbers are still growing. */
  importing: boolean;
  hasSection: (table: StoreTable) => boolean;
  onOpenTable: (table: StoreTable) => void;
  onInspect: (table: StoreTable, row: DetailRow) => void;
  /** Changes when the store has been read again, to count afresh. */
  refreshKey: number;
}) {
  const fmt = useFormat();
  const [data, setData] = useState<OverviewData | null>(null);
  const [latest, setLatest] = useState<DetailRow[] | null>(null);
  const [watch, setWatch] = useState<DetailRow[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setError(null);
    const [o, orders, stock] = await Promise.all([
      supabase.rpc("abo_store_overview", { p_project: projectId }),
      readStoreRows(supabase, storeId, "orders", 6).catch(() => null),
      supabase
        .from(STORE_TABLES.inventory_levels.view)
        .select(STORE_TABLES.inventory_levels.select)
        .eq("store_id", storeId)
        .in("stock_state", WATCH)
        .order("available", { ascending: true })
        .limit(6),
    ]);
    if (o.error) {
      setError("The overview couldn’t be counted just now.");
      return;
    }
    setData(o.data as OverviewData);
    setLatest(orders?.rows ?? []);
    setWatch(((stock.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({ id: r.id as string, data: r })));
    setNow(Date.now());
  }, [projectId, storeId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Webhooks keep the store moving while the page is open elsewhere.
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [load]);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: u }) => {
      if (!u.user) return;
      const { data: p } = await supabase.from("profiles").select("full_name").eq("user_id", u.user.id).maybeSingle();
      setName((p?.full_name as string | undefined)?.trim().split(/\s+/)[0] ?? null);
    });
  }, []);

  const greeting = useMemo(() => {
    const h = new Date(now).getHours();
    return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  }, [now]);

  if (error) {
    return (
      <div className="mx-auto max-w-5xl">
        <div role="alert" className={`${note.critical} flex items-center justify-between gap-3 text-[13px]`}>
          {error}
          <button onClick={load} className={button("secondary", "sm")}>
            <RefreshCw aria-hidden size={13} strokeWidth={2} />
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!data) return <OverviewSkeleton />;
  if (!data.store) return null;

  const store = data.store;
  const money = [...(data.money ?? [])].sort((a, b) => (a.currency === store.currency ? -1 : b.currency === store.currency ? 1 : 0));
  const main = money[0] ?? null;
  const others = money.slice(1);
  const orders = data.orders ?? { today: 0, last_7: 0, last_30: 0 };
  const stock = data.stock ?? {};
  const watching = WATCH.reduce((n, k) => n + (stock[k] ?? 0), 0);
  const open = (t: StoreTable) => (hasSection(t) ? () => onOpenTable(t) : undefined);
  const openOrders = open("orders");
  const openStock = open("inventory_levels");

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h2 className="text-xl font-semibold tracking-tight text-fg">
          {greeting}
          {name ? `, ${name}` : ""}
        </h2>
        <p className="mt-1 text-[13px] text-fg-muted">
          {store.shop_domain}
          {data.today ? ` · ${fmt.date(data.today)}` : ""} · synced {ago(store.last_synced_at, now, "not yet")}
        </p>
      </header>

      {store.status === "uninstalled" && (
        <div className={`${note.attention} flex items-center gap-2 text-[13px]`}>
          <TriangleAlert aria-hidden size={15} strokeWidth={2} className="shrink-0" />
          Warmluke was removed from this store in Shopify. What was imported is still here; reconnect from the menu to keep it current.
        </div>
      )}
      {importing && (
        <div className={`${note.info} flex items-center gap-2 text-[13px]`}>
          <RefreshCw aria-hidden size={14} strokeWidth={2} className="shrink-0 animate-spin" />
          Your store is still coming in. These numbers grow as it does.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Orders today"
          value={fmt.number(orders.today)}
          sub={`${fmt.number(orders.last_7)} in the last 7 days`}
          onClick={openOrders}
        />
        <Kpi
          label="Collected, 30 days"
          value={fmt.money(main?.collected ?? 0, main?.currency ?? store.currency)}
          sub={
            main?.average != null
              ? `${fmt.number(orders.last_30)} orders · ${fmt.money(main.average, main.currency)} on average`
              : `${fmt.number(orders.last_30)} orders`
          }
          extra={others.map((m) => `+ ${fmt.money(m.collected, m.currency)}`).join("   ")}
          onClick={openOrders}
        />
        <Kpi
          label="Awaiting payment"
          value={fmt.money(main?.awaiting ?? 0, main?.currency ?? store.currency)}
          sub={
            main && main.awaiting_count > 0
              ? `${fmt.number(main.awaiting_count)} ${main.awaiting_count === 1 ? "order" : "orders"} not paid yet, cash on delivery mostly`
              : "Nothing waiting to be paid"
          }
          extra={others
            .filter((m) => m.awaiting > 0)
            .map((m) => `+ ${fmt.money(m.awaiting, m.currency)}`)
            .join("   ")}
          attention={(main?.awaiting_count ?? 0) > 0}
          onClick={openOrders}
        />
        <Kpi
          label="To fulfil"
          value={fmt.number(data.to_fulfil ?? 0)}
          sub={(data.to_fulfil ?? 0) > 0 ? "orders still to send" : "Everything has been sent"}
          attention={(data.to_fulfil ?? 0) > 0}
          onClick={openOrders}
        />
      </div>

      <Chart daily={data.daily ?? []} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Latest orders"
          icon={<ShoppingCart aria-hidden size={15} strokeWidth={1.75} />}
          action={openOrders ? { label: "All orders", onClick: openOrders } : undefined}
        >
          {latest === null ? (
            <Rows />
          ) : latest.length === 0 ? (
            <Empty text="No orders yet. They appear here as Shopify sends them." />
          ) : (
            <ul className="divide-y divide-line">
              {latest.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => onInspect("orders", r)}
                    className="block w-full px-4 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="shrink-0 text-[13px] font-medium text-fg">{String(r.data.order_number ?? "")}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-muted">{String(r.data.customer_name ?? "Guest")}</span>
                      <span className="shrink-0 text-[13px] font-medium text-fg tabular-nums">
                        {r.data.total != null ? fmt.money(Number(r.data.total), (r.data.currency as string | undefined) ?? null) : ""}
                      </span>
                    </span>
                    <span className="mt-1 flex items-center gap-2">
                      <span className="text-[11px] whitespace-nowrap text-fg-faint">{r.data.placed_at ? fmt.date(String(r.data.placed_at)) : ""}</span>
                      {typeof r.data.status === "string" && <Badge value={r.data.status} />}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Stock to watch"
          icon={<Package aria-hidden size={15} strokeWidth={1.75} />}
          action={openStock ? { label: "All stock", onClick: openStock } : undefined}
          aside={watching > 0 ? `${fmt.number(watching)} ${watching === 1 ? "item" : "items"}` : undefined}
        >
          {watch === null ? (
            <Rows />
          ) : watch.length === 0 ? (
            <Empty text={Object.keys(stock).length ? "Nothing is out of stock." : "No stock levels from the store yet."} />
          ) : (
            <ul className="divide-y divide-line">
              {watch.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => onInspect("inventory_levels", r)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-fg">
                        {String(r.data.product ?? "")}
                        {r.data.variant ? <span className="text-fg-muted"> · {String(r.data.variant)}</span> : null}
                      </span>
                      <span className="block truncate text-[11px] text-fg-faint">{String(r.data.location_name ?? "")}</span>
                    </span>
                    <StockState value={String(r.data.stock_state ?? "")} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-faint">
        <span className="inline-flex items-center gap-1.5">
          <Store aria-hidden size={13} strokeWidth={1.75} />
          {fmt.number(data.products ?? 0)} products · {fmt.number(data.customers ?? 0)} customers
        </span>
        <span>Days are counted in {store.timezone}. Cancelled orders are left out of every figure.</span>
      </p>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  extra,
  attention = false,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  extra?: string;
  attention?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2 text-xs font-medium text-fg-muted">
        {label}
        {attention && <span className="h-1.5 w-1.5 rounded-full bg-signal-attention" aria-hidden />}
      </div>
      <div className="mt-1.5 truncate text-[22px] leading-7 font-semibold tracking-tight text-fg tabular-nums">{value}</div>
      <div className="mt-1 line-clamp-2 text-xs text-fg-muted">{sub}</div>
      {extra && <div className="mt-0.5 truncate text-[11px] text-fg-faint">{extra}</div>}
    </>
  );
  return onClick ? (
    <button
      onClick={onClick}
      className={`${card} p-4 text-left transition-shadow duration-200 hover:shadow-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}
    >
      {body}
    </button>
  ) : (
    <div className={`${card} p-4`}>{body}</div>
  );
}

/** Fourteen days of orders as bars; each says its day and count when pointed at. */
function Chart({ daily }: { daily: Array<{ day: string; orders: number }> }) {
  const fmt = useFormat();
  const max = Math.max(0, ...daily.map((d) => d.orders));
  const total = daily.reduce((n, d) => n + d.orders, 0);
  return (
    <section className={`${card} p-4`}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold text-fg">Orders, last 14 days</h3>
        <span className="text-xs text-fg-muted tabular-nums">{fmt.number(total)} in all</span>
      </div>
      {total === 0 ? (
        <p className="mt-6 mb-4 text-center text-xs text-fg-faint">No orders in the last two weeks.</p>
      ) : (
        <div className="mt-4 flex h-32 items-end gap-1.5" role="img" aria-label={`Orders per day over the last 14 days, ${total} in all`}>
          {daily.map((d, i) => {
            const date = new Date(`${d.day}T00:00:00`);
            const label = `${date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}: ${d.orders} ${d.orders === 1 ? "order" : "orders"}`;
            return (
              <div key={d.day} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5" title={label}>
                <span className="text-[10px] text-fg-muted tabular-nums opacity-0 transition-opacity group-hover:opacity-100">{d.orders}</span>
                <div
                  className={`w-full rounded-t-[4px] transition-colors ${i === daily.length - 1 ? "bg-primary" : "bg-line-strong group-hover:bg-fg-faint"}`}
                  style={{ height: `${Math.max(d.orders > 0 ? 6 : 2, (d.orders / max) * 100)}%` }}
                />
                <span className="text-[10px] text-fg-faint">{date.toLocaleDateString(undefined, { weekday: "narrow" })}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Panel({
  title,
  icon,
  action,
  aside,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  action?: { label: string; onClick: () => void };
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${card} overflow-hidden`}>
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-fg-muted">{icon}</span>
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        {aside && <span className="rounded-full bg-tone-attention px-1.5 py-px text-[11px] font-medium text-tone-attention-fg">{aside}</span>}
        {action && (
          <button onClick={action.onClick} className={`${button("plain", "sm")} -mr-2 ml-auto`}>
            {action.label}
            <ArrowRight aria-hidden size={13} strokeWidth={2} />
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

function StockState({ value }: { value: string }) {
  const tone =
    value === "Out of stock"
      ? "bg-tone-critical text-tone-critical-fg"
      : value === "All promised"
        ? "bg-tone-attention text-tone-attention-fg"
        : "bg-tone-info text-tone-info-fg";
  return <span className={`shrink-0 rounded-lg px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}>{value}</span>;
}

function Rows() {
  return (
    <div className="space-y-2 p-4" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-surface-hover" />
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-4 py-8 text-center text-xs text-fg-faint">{text}</p>;
}

function OverviewSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-5" aria-busy>
      <div className="h-7 w-56 animate-pulse rounded bg-surface-hover" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-card bg-surface shadow-card" />
        ))}
      </div>
      <div className="h-48 animate-pulse rounded-card bg-surface shadow-card" />
    </div>
  );
}
