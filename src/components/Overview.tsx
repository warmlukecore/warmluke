"use client";

// ─────────────────────────────────────────────────────────────
// Overview — how the store is doing, on one screen.
//
// The numbers come from abo_store_overview (0114), counted over every
// order on the server; a page of rows in the browser would be a wrong
// total that looks right. Money is shown in the currency Shopify
// recorded it in, each currency on its own line, and "today" is the
// store's today.
//
// Every figure leads somewhere: tap it and the section it came from
// opens, or the order itself.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Clock3,
  ExternalLink,
  Package,
  PackageX,
  RefreshCw,
  ShoppingBag,
  ShoppingCart,
  Store,
  TriangleAlert,
  Truck,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { useFormat } from "@/lib/format";
import { readStoreRows, type StoreTable } from "@/lib/store-read";
import { ago } from "@/lib/when";
import { knownStatus, badgeLabel, quietClasses, type Tone } from "@/lib/tone";
import { button, card, note } from "@/components/ui/controls";
import type { DetailRow } from "@/components/StoreRecordDetail";

type Money = {
  currency: string;
  collected: number;
  awaiting: number;
  awaiting_count: number;
  /** The payment method most unpaid orders are waiting on, as Shopify names it. */
  awaiting_by: string | null;
  average: number | null;
  orders: number;
};
/**
 * What abo_store_overview (0114) answers. The windows it counted are in
 * the answer; the page labels from them and keeps no copy of its own.
 */
export type OverviewData = {
  store: {
    shop_domain: string;
    status: string;
    currency: string;
    timezone: string;
    last_synced_at: string | null;
  } | null;
  days?: number;
  chart_days?: number;
  today?: string;
  orders?: { today: number; yesterday: number; window: number };
  money?: Money[];
  daily?: Array<{ day: string; orders: number }>;
  to_fulfil?: number;
  stock?: Record<string, number>;
  /** Tracked variants with nothing left to sell, emptiest first; chosen by the database. */
  stock_watch?: Array<Record<string, unknown>>;
  watching?: number;
  customers?: number;
  products?: number;
};

/** How many of the latest orders and stock rows the page lists: a layout choice, not data. */
const LIST_ROWS = 6;

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
  const [data, setData] = useState<OverviewData | null>(null);
  const [latest, setLatest] = useState<DetailRow[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setError(null);
    const [o, orders] = await Promise.all([
      supabase.rpc("abo_store_overview", { p_project: projectId }),
      readStoreRows(supabase, storeId, "orders", LIST_ROWS).catch(() => null),
    ]);
    if (o.error) {
      setError("The overview couldn’t be counted just now.");
      return;
    }
    setData(o.data as OverviewData);
    setLatest(orders?.rows ?? []);
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
  return (
    <OverviewBoard
      data={data}
      latest={latest}
      name={name}
      now={now}
      importing={importing}
      hasSection={hasSection}
      onOpenTable={onOpenTable}
      onInspect={onInspect}
    />
  );
}

/**
 * The overview itself, drawn from counts already made. The app's own
 * screen, and the landing page's glimpse of it, fed the sample store:
 * one drawing, so what a visitor sees is what they will open.
 */
export function OverviewBoard({
  data,
  latest,
  name,
  now,
  importing,
  hasSection,
  onOpenTable,
  onInspect,
}: {
  data: OverviewData;
  /** The newest orders, or null while they are still being read. */
  latest: DetailRow[] | null;
  name: string | null;
  now: number;
  importing: boolean;
  hasSection: (table: StoreTable) => boolean;
  onOpenTable: (table: StoreTable) => void;
  onInspect: (table: StoreTable, row: DetailRow) => void;
}) {
  const fmt = useFormat();
  if (!data.store) return null;
  const hour = new Date(now).getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const store = data.store;
  const money = [...(data.money ?? [])].sort((a, b) =>
    a.currency === store.currency ? -1 : b.currency === store.currency ? 1 : 0
  );
  const main = money[0] ?? null;
  const others = money.slice(1);
  const orders = data.orders ?? { today: 0, yesterday: 0, window: 0 };
  const days = data.days ?? 0;
  const stock = data.stock ?? {};
  const watch: DetailRow[] = (data.stock_watch ?? []).slice(0, LIST_ROWS).map((r) => ({ id: String(r.id), data: r }));
  const watching = data.watching ?? watch.length;
  const perDays = `${days} ${days === 1 ? "day" : "days"}`;
  const inDays = (n: number) => `${fmt.number(n)} ${n === 1 ? "order" : "orders"} in ${perDays}`;
  const open = (t: StoreTable) => (hasSection(t) ? () => onOpenTable(t) : undefined);
  const openOrders = open("orders");
  const openStock = open("inventory_levels");

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-fg">
            {greeting}
            {name ? `, ${name}` : ""}
          </h2>
          <p className="mt-1 truncate text-[13px] text-fg-muted">
            {data.today ? fmt.date(data.today) : ""} · synced {ago(store.last_synced_at, now, "not yet")}
          </p>
        </div>
        <a
          href={`https://${store.shop_domain}/admin`}
          target="_blank"
          rel="noopener noreferrer"
          className={button("secondary", "sm")}
        >
          <Store aria-hidden size={13} strokeWidth={2} />
          <span className="max-w-[16rem] truncate">{store.shop_domain}</span>
          <ExternalLink aria-hidden size={12} strokeWidth={2} className="text-fg-faint" />
        </a>
      </header>

      {store.status === "uninstalled" && (
        <div className={`${note.attention} flex items-center gap-2 text-[13px]`}>
          <TriangleAlert aria-hidden size={15} strokeWidth={2} className="shrink-0" />
          Warmluke was removed from this store in Shopify. What was imported is still here; reconnect from the menu to
          keep it current.
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
          icon={ShoppingBag}
          tone="info"
          label="Orders today"
          value={fmt.number(orders.today)}
          sub={`${fmt.number(orders.yesterday)} yesterday`}
          onClick={openOrders}
        />
        <Kpi
          icon={Wallet}
          tone="success"
          label="Collected"
          value={fmt.money(main?.collected ?? 0, main?.currency ?? store.currency)}
          sub={
            main?.average != null
              ? `${inDays(orders.window)} · ${fmt.money(main.average, main.currency)} each`
              : inDays(orders.window)
          }
          extra={others.map((m) => `+ ${fmt.money(m.collected, m.currency)}`).join("   ")}
          onClick={openOrders}
        />
        <Kpi
          icon={Clock3}
          tone="attention"
          label="Awaiting payment"
          value={fmt.money(main?.awaiting ?? 0, main?.currency ?? store.currency)}
          sub={
            main && main.awaiting_count > 0
              ? `${fmt.number(main.awaiting_count)} ${main.awaiting_count === 1 ? "order" : "orders"} not paid yet${
                  main.awaiting_by ? `, most by ${main.awaiting_by}` : ""
                }`
              : `Nothing waiting to be paid in ${perDays}`
          }
          extra={others
            .filter((m) => m.awaiting > 0)
            .map((m) => `+ ${fmt.money(m.awaiting, m.currency)}`)
            .join("   ")}
          onClick={openOrders}
        />
        <Kpi
          icon={Truck}
          tone="warning"
          label="To fulfil"
          value={fmt.number(data.to_fulfil ?? 0)}
          sub={(data.to_fulfil ?? 0) > 0 ? "orders still to send" : "Everything has been sent"}
          onClick={openOrders}
        />
      </div>

      <Chart daily={data.daily ?? []} />

      {/* Each panel as tall as what it holds: two lists side by side
          used to stretch the shorter one into a box of white. */}
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <Panel
          title="Latest orders"
          icon={<ShoppingCart aria-hidden size={15} strokeWidth={1.75} />}
          action={openOrders ? { label: "All orders", onClick: openOrders } : undefined}
        >
          {latest === null ? (
            <Rows />
          ) : latest.length === 0 ? (
            <Empty icon={ShoppingCart} text="No orders yet. They appear here as Shopify sends them." />
          ) : (
            <ul className="divide-y divide-line">
              {latest.map((r) => {
                const who = String(r.data.customer_name ?? "").trim() || "Guest";
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => onInspect("orders", r)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
                    >
                      <span
                        aria-hidden
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${quietClasses(who)}`}
                      >
                        {who.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-fg">{who}</span>
                        <span className="block truncate text-[11px] text-fg-muted">
                          {String(r.data.order_number ?? "")}
                          {r.data.placed_at ? ` · ${fmt.date(String(r.data.placed_at))}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-[13px] font-semibold text-fg tabular-nums">
                          {r.data.total != null
                            ? fmt.money(Number(r.data.total), (r.data.currency as string | undefined) ?? null)
                            : ""}
                        </span>
                        {typeof r.data.status === "string" && <StatusDot value={r.data.status} />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          title="Stock to watch"
          icon={<Package aria-hidden size={15} strokeWidth={1.75} />}
          action={openStock ? { label: "All stock", onClick: openStock } : undefined}
          aside={watching > 0 ? `${fmt.number(watching)} ${watching === 1 ? "item" : "items"}` : undefined}
        >
          {watch.length === 0 ? (
            <Empty
              icon={Package}
              text={Object.keys(stock).length ? "Nothing is out of stock." : "No stock levels from the store yet."}
            />
          ) : (
            <ul className="divide-y divide-line">
              {watch.map((r) => {
                const state = String(r.data.stock_state ?? "");
                const onHand = Number(r.data.on_hand ?? 0);
                const incoming = Number(r.data.incoming ?? 0);
                // Red when there is nothing on the shelf and nothing on the way;
                // amber when it is only promised away or already coming.
                const out = onHand <= 0 && incoming <= 0;
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => onInspect("inventory_levels", r)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
                    >
                      <span
                        aria-hidden
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control ${
                          out ? "bg-tone-critical text-tone-critical-fg" : "bg-tone-attention text-tone-attention-fg"
                        }`}
                      >
                        {out ? <PackageX size={15} strokeWidth={1.75} /> : <Package size={15} strokeWidth={1.75} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-fg">
                          {String(r.data.product ?? "")}
                          {r.data.variant ? (
                            <span className="font-normal text-fg-muted"> · {String(r.data.variant)}</span>
                          ) : null}
                        </span>
                        <span className="block truncate text-[11px] text-fg-muted">
                          {[r.data.location_name, r.data.sku].filter(Boolean).map(String).join(" · ")}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-[13px] font-semibold text-fg tabular-nums">
                          {fmt.number(Number(r.data.available ?? 0))} left
                        </span>
                        <span
                          className={`block text-[11px] ${out ? "text-tone-critical-fg" : "text-tone-attention-fg"}`}
                        >
                          {[
                            state,
                            onHand > 0 ? `${fmt.number(onHand)} on hand` : "",
                            incoming > 0 ? `${fmt.number(incoming)} coming` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-faint">
        <span>
          {fmt.number(data.products ?? 0)} products · {fmt.number(data.customers ?? 0)} customers
        </span>
        <span>Days are counted in {store.timezone}. Cancelled orders are left out of every figure.</span>
      </p>
    </div>
  );
}

/** The icon tile each figure wears, by the tone it is drawn in. */
const TILE: Record<"info" | "success" | "attention" | "warning", string> = {
  info: "bg-tone-info text-tone-info-fg",
  success: "bg-tone-success text-tone-success-fg",
  attention: "bg-tone-attention text-tone-attention-fg",
  warning: "bg-tone-warning text-tone-warning-fg",
};

function Kpi({
  icon: Glyph,
  tone,
  label,
  value,
  sub,
  extra,
  onClick,
}: {
  icon: LucideIcon;
  tone: keyof typeof TILE;
  label: string;
  value: string;
  sub: string;
  extra?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control ${TILE[tone]}`}>
          <Glyph aria-hidden size={16} strokeWidth={1.75} />
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 text-xs leading-tight font-medium text-fg-muted">{label}</span>
        {onClick && (
          <ArrowRight
            aria-hidden
            size={14}
            strokeWidth={2}
            className="shrink-0 -translate-x-1 text-fg-faint opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
          />
        )}
      </div>
      <div className="mt-3 truncate text-[22px] leading-7 font-semibold tracking-tight text-fg tabular-nums">
        {value}
      </div>
      <div className="mt-1 line-clamp-2 text-xs text-fg-muted" title={sub}>
        {sub}
      </div>
      {extra && <div className="mt-0.5 truncate text-[11px] text-fg-faint">{extra}</div>}
    </>
  );
  return onClick ? (
    <button
      onClick={onClick}
      className={`${card} group p-4 text-left transition-shadow duration-200 hover:shadow-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}
    >
      {body}
    </button>
  ) : (
    <div className={`${card} p-4`}>{body}</div>
  );
}

/**
 * Orders per day as bars, over however many days the database counted,
 * with a scale behind them. The count
 * for a day is shown in a bubble over its bar while it is pointed at —
 * the page's own, not the browser's tooltip, which stayed on screen
 * wherever the pointer had left it once the page scrolled.
 */
function Chart({ daily }: { daily: Array<{ day: string; orders: number }> }) {
  const fmt = useFormat();
  const max = Math.max(0, ...daily.map((d) => d.orders));
  const total = daily.reduce((n, d) => n + d.orders, 0);
  // A round top for the scale, so the lines sit on whole numbers.
  const top = max <= 4 ? Math.max(1, max) : Math.ceil(max / 5) * 5;
  const perDay = daily.length ? total / daily.length : 0;
  return (
    <section className={`${card} p-4`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-fg">Orders, last {daily.length} days</h3>
        <span className="text-xs text-fg-muted tabular-nums">
          {fmt.number(total)} in all · {perDay.toFixed(perDay < 10 ? 1 : 0)} a day
        </span>
      </div>
      {total === 0 ? (
        <p className="mt-6 mb-4 text-center text-xs text-fg-faint">No orders in the last {daily.length} days.</p>
      ) : (
        <div className="mt-8 flex gap-2">
          <div className="flex h-36 w-6 shrink-0 flex-col justify-between pb-5 text-right text-[10px] text-fg-faint tabular-nums">
            <span>{top}</span>
            <span>{top > 1 ? Math.round(top / 2) : ""}</span>
            <span>0</span>
          </div>
          <div className="relative min-w-0 flex-1">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 bottom-5 flex flex-col justify-between"
            >
              <span className="border-t border-dashed border-line" />
              <span className="border-t border-dashed border-line" />
              <span className="border-t border-line" />
            </div>
            <div
              className="relative flex h-36 items-end gap-1"
              role="img"
              aria-label={`Orders per day over the last ${daily.length} days, ${total} in all`}
            >
              {daily.map((d, i) => {
                const date = new Date(`${d.day}T00:00:00`);
                const isToday = i === daily.length - 1;
                // Bubbles at the edges open inwards, so none reaches past
                // the card and makes the page scroll sideways.
                const side = i < 3 ? "left-0" : i > daily.length - 4 ? "right-0" : "left-1/2 -translate-x-1/2";
                return (
                  <div key={d.day} className="group relative flex h-full flex-1 flex-col items-center justify-end">
                    <div className="flex h-[calc(100%-1.25rem)] w-full items-end">
                      <div
                        style={{ height: `${d.orders === 0 ? 2 : Math.max(6, (d.orders / top) * 100)}%` }}
                        className={`relative w-full rounded-t-[4px] transition-colors ${
                          d.orders === 0
                            ? "bg-line"
                            : isToday
                              ? "bg-signal-info"
                              : "bg-signal-info/35 group-hover:bg-signal-info/60"
                        }`}
                      >
                        <span
                          role="tooltip"
                          className={`pointer-events-none absolute bottom-full z-10 mb-1.5 hidden rounded-control bg-primary px-2 py-1 text-[11px] whitespace-nowrap text-on-primary shadow-popover group-hover:block ${side}`}
                        >
                          {date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ·{" "}
                          {d.orders} {d.orders === 1 ? "order" : "orders"}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`mt-1.5 h-3.5 text-[10px] leading-none ${isToday ? "font-semibold text-fg" : "text-fg-faint"}`}
                    >
                      {isToday ? "Today" : date.toLocaleDateString(undefined, { weekday: "narrow" })}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
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
        {aside && (
          <span className="rounded-full bg-tone-attention px-1.5 py-px text-[11px] font-medium text-tone-attention-fg">
            {aside}
          </span>
        )}
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

/** A status as a coloured dot and its words: lighter than a pill in a list. */
const DOT: Record<Tone, string> = {
  attention: "bg-signal-attention",
  warning: "bg-signal-attention",
  success: "bg-signal-success",
  info: "bg-signal-info",
  critical: "bg-signal-critical",
  neutral: "bg-signal-neutral",
};

function StatusDot({ value }: { value: string }) {
  const tone = knownStatus(value)?.tone ?? "neutral";
  return (
    <span className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
      {badgeLabel(value)}
    </span>
  );
}

function Rows() {
  return (
    <div className="space-y-2 p-4" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-9 animate-pulse rounded bg-surface-hover" />
      ))}
    </div>
  );
}

function Empty({ icon: Glyph, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-8 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas text-fg-faint">
        <Glyph aria-hidden size={16} strokeWidth={1.75} />
      </span>
      <p className="mt-2 text-xs text-fg-faint">{text}</p>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-5" aria-busy>
      <div className="h-7 w-56 animate-pulse rounded bg-surface-hover" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-32 animate-pulse rounded-card bg-surface shadow-card" />
        ))}
      </div>
      <div className="h-52 animate-pulse rounded-card bg-surface shadow-card" />
    </div>
  );
}
